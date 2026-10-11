#!/usr/bin/env bash
set -euo pipefail

ENGINE="${CONTAINER_ENGINE:-docker}"
case "$ENGINE" in docker|podman) ;; *) echo "Use CONTAINER_ENGINE=docker or podman" >&2; exit 2 ;; esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
DOVECOT_IMAGE="docker.io/dovecot/dovecot:2.4.4-root@sha256:d6b2f80db2e656a9250583712a82397e2752b35ad7e4e2e71c85fdc0d510137d"
NODE_IMAGE="docker.io/library/node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392"

for tool in "$ENGINE" timeout; do
	command -v "$tool" >/dev/null || { echo "Required existing tool missing: $tool" >&2; exit 1; }
done
case "${1:-}" in
	prepare)
		# Explicit network preparation only; the run phase never pulls or installs.
		timeout 180s "$ENGINE" pull --platform linux/amd64 "$DOVECOT_IMAGE"
		timeout 180s "$ENGINE" pull --platform linux/amd64 "$NODE_IMAGE"
		exit 0
		;;
	run) ;;
	*) echo "Usage: bash $0 prepare|run (Linux amd64, prebuilt workspace)" >&2; exit 2 ;;
esac

[[ "$(uname -m)" == x86_64 ]] || { echo "This bounded fixture requires native Linux amd64" >&2; exit 1; }
[[ -f "$ROOT/packages/backend/dist/services/ingestion-connectors/ImapConnector.js" ]] ||
	{ echo "Build the backend and install locked dependencies before running" >&2; exit 1; }
for image in "$DOVECOT_IMAGE" "$NODE_IMAGE"; do
	"$ENGINE" image inspect "$image" >/dev/null
done

scratch="$(mktemp -d /tmp/oa-imap-interop.XXXXXXXX)"
server="oa-imap-server-${scratch##*.}"
client="oa-imap-client-${scratch##*.}"
cert_helper="oa-imap-certs-${scratch##*.}"
server_created=false
client_created=false
cert_helper_created=false
cleanup() {
	local result=$?
	local retain_scratch=false
	trap - EXIT INT TERM
	set +e
	if [[ "$result" -ne 0 ]] && $server_created; then
		timeout --kill-after=2s 5s "$ENGINE" logs --tail 80 "$server" >&2
	fi
	for container in "$client" "$server" "$cert_helper"; do
		if { [[ "$container" == "$client" ]] && $client_created; } ||
			{ [[ "$container" == "$server" ]] && $server_created; } ||
			{ [[ "$container" == "$cert_helper" ]] && $cert_helper_created; }; then
			if ! timeout --kill-after=2s 10s "$ENGINE" stop --time 2 "$container" >/dev/null; then
				echo "Failed to stop owned container $container within its cleanup deadline" >&2
				result=1
			fi
			if ! timeout --kill-after=2s 10s "$ENGINE" rm --force "$container" >/dev/null; then
				echo "Failed to remove owned container $container; certificate directory retained: $scratch" >&2
				result=1
				retain_scratch=true
				continue
			fi
		fi
	done
	if ! $retain_scratch; then
		case "$scratch" in /tmp/oa-imap-interop.*) rm -rf -- "$scratch" || result=1 ;; *) result=1 ;; esac
	fi
	exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The private 0700 scratch parent prevents host access; the helper writes as UID 1000.
mkdir -m 0733 "$scratch/certs"
limits=(--memory 256m --memory-swap 256m --cpus 1 --pids-limit 128 --read-only --cap-drop ALL --security-opt no-new-privileges)
"$ENGINE" create --pull never --name "$cert_helper" "${limits[@]}" --network none --user 1000:1000 \
	--mount "type=bind,source=$scratch/certs,target=/fixture" \
	--entrypoint /bin/sh "$DOVECOT_IMAGE" -ec '
		read memory < /sys/fs/cgroup/memory.max
		read cpu < /sys/fs/cgroup/cpu.max
		read pids < /sys/fs/cgroup/pids.max
		read swap < /sys/fs/cgroup/memory.swap.max
		test "$memory|$cpu|$pids|$swap" = "268435456|100000 100000|128|0"
		test "$(id -u):$(id -g)" = "1000:1000"
		grep -Eq "^CapEff:[[:space:]]+0+$" /proc/self/status
		grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status
		printf "Certificate helper: effective memory=256MiB cpu=1 pids=128 no swap UID/GID=1000 CapEff=0 NNP=1\n"
		openssl version
		openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=Open Archiver fixture CA" \
			-addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
			-keyout /fixture/ca.key -out /fixture/ca.crt
		openssl req -new -newkey rsa:2048 -nodes -subj "/CN=localhost" \
			-keyout /fixture/tls.key -out /fixture/server.csr
		printf "%s\n" "subjectAltName=DNS:localhost,IP:127.0.0.1" "extendedKeyUsage=serverAuth" \
			"basicConstraints=critical,CA:FALSE" "keyUsage=critical,digitalSignature,keyEncipherment" > /fixture/server.ext
		openssl x509 -req -in /fixture/server.csr -CA /fixture/ca.crt -CAkey /fixture/ca.key \
			-CAcreateserial -days 2 -extfile /fixture/server.ext -out /fixture/tls.crt
		chmod 0444 /fixture/tls.key /fixture/tls.crt /fixture/ca.crt
		rm /fixture/ca.key
	' >/dev/null
cert_helper_created=true
certificate_result=0
timeout --kill-after=2s 45s "$ENGINE" start --attach "$cert_helper" > "$scratch/certificate.log" 2>&1 ||
	certificate_result=$?
tail -c 16384 "$scratch/certificate.log"
[[ "$certificate_result" == 0 ]] || exit "$certificate_result"
[[ "$("$ENGINE" inspect --format '{{.State.ExitCode}}' "$cert_helper")" == 0 ]] ||
	{ echo "Certificate helper failed" >&2; exit 1; }
timeout 10s "$ENGINE" rm "$cert_helper" >/dev/null
cert_helper_created=false
mv "$scratch/certs/ca.crt" "$scratch/ca.crt"
rm -- "$scratch/certs/server.csr" "$scratch/certs/ca.srl" "$scratch/certs/server.ext"
chmod 0755 "$scratch/certs"

"$ENGINE" create --pull never --name "$server" "${limits[@]}" --network none --user 1000:1000 \
	--tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
	--tmpfs /run:rw,nosuid,nodev,noexec,size=16m,mode=1777 \
	--tmpfs /srv/vmail:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000,mode=0700 \
	--mount "type=bind,source=$scratch/certs,target=/etc/dovecot/ssl,readonly" \
	--mount "type=bind,source=$SCRIPT_DIR/dovecot.conf,target=/etc/dovecot/conf.d/99-interop.conf,readonly" \
	--env 'USER_PASSWORD={PLAIN}synthetic-imap-fixture-password' "$DOVECOT_IMAGE" >/dev/null
server_created=true
"$ENGINE" start "$server" >/dev/null
"$ENGINE" create --pull never --name "$client" "${limits[@]}" --network "container:$server" \
	--user 1000:1000 --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777 \
	--mount "type=bind,source=$ROOT,target=/app,readonly" \
	--mount "type=bind,source=$scratch/ca.crt,target=/fixture-ca/ca.crt,readonly" \
	--workdir /app --env NODE_EXTRA_CA_CERTS=/fixture-ca/ca.crt \
	--env LOG_LEVEL=silent --env DOTENV_CONFIG_PATH=/dev/null --env ARCHIVE_DRAFTS=false \
	--env ALL_INCLUSIVE_ARCHIVE=false --env OA_IMAP_INTEROP=1 \
	"$NODE_IMAGE" node -e 'setTimeout(() => process.exit(1), 150000)' >/dev/null
client_created=true
"$ENGINE" start "$client" >/dev/null
[[ "$("$ENGINE" inspect --format '{{.HostConfig.NetworkMode}}' "$server")" == none ]] ||
	{ echo "Server must have no external network" >&2; exit 1; }
server_id="$("$ENGINE" inspect --format '{{.Id}}' "$server")"
client_network="$("$ENGINE" inspect --format '{{.HostConfig.NetworkMode}}' "$client")"
[[ "$client_network" == "container:$server_id" || "$client_network" == "container:$server" ]] ||
	{ echo "Client must share only the isolated server namespace" >&2; exit 1; }

for container in "$server" "$client"; do
	controls="$("$ENGINE" inspect --format '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}}' "$container")"
	[[ "$controls" == '268435456 128 true false' ]] ||
		{ echo "Unexpected container controls: $controls" >&2; exit 1; }
	[[ "$("$ENGINE" inspect --format '{{len .HostConfig.PortBindings}}' "$container")" == 0 ]] ||
		{ echo "The fixture must not publish host ports" >&2; exit 1; }
	effective="$(timeout 5s "$ENGINE" exec "$container" /bin/sh -c \
		'read memory < /sys/fs/cgroup/memory.max; read cpu < /sys/fs/cgroup/cpu.max; read pids < /sys/fs/cgroup/pids.max; read swap < /sys/fs/cgroup/memory.swap.max; printf "%s|%s|%s|%s" "$memory" "$cpu" "$pids" "$swap"')"
	[[ "$effective" == '268435456|100000 100000|128|0' ]] ||
		{ echo "Missing effective cgroup-v2 limits: $effective" >&2; exit 1; }
	timeout 5s "$ENGINE" exec "$container" /bin/sh -ec '
		test "$(id -u):$(id -g)" = "1000:1000"
		for status in /proc/self/status /proc/1/status; do
			grep -Eq "^Uid:[[:space:]]+1000[[:space:]]+1000[[:space:]]+1000[[:space:]]+1000$" "$status"
			grep -Eq "^Gid:[[:space:]]+1000[[:space:]]+1000[[:space:]]+1000[[:space:]]+1000$" "$status"
			grep -Eq "^CapEff:[[:space:]]+0+$" "$status"
			grep -Eq "^NoNewPrivs:[[:space:]]+1$" "$status"
		done
	'
	echo "$container: effective memory=256MiB cpu=1 pids=128 UID/GID=1000 CapEff=0 NNP=1; read-only"
done
filecaps="$(timeout 5s "$ENGINE" exec "$server" getcap \
	/dovecot/libexec/dovecot/imap-login /dovecot/libexec/dovecot/anvil)"
[[ -z "$filecaps" ]] || { echo "Unexpected Dovecot executable file capabilities: $filecaps" >&2; exit 1; }
echo "Dovecot imap-login/anvil have no file capabilities"
version="$(timeout 5s "$ENGINE" exec "$server" /dovecot/sbin/dovecot --version)"
[[ "$version" == 2.4.4* ]] || { echo "Unexpected Dovecot version: $version" >&2; exit 1; }
echo "Dovecot $version; no published ports or external network"

timeout --kill-after=2s 25s "$ENGINE" exec "$client" node -e '
	const tls = require("node:tls");
	const deadline = Date.now() + 20000;
	function attempt() {
		const socket = tls.connect({ host: "127.0.0.1", port: 31993, rejectUnauthorized: true });
		socket.setTimeout(2000, () => socket.destroy(new Error("IMAP greeting timed out")));
		socket.once("data", data => {
			if (!data.toString().startsWith("* OK")) {
				socket.destroy(new Error("Unexpected IMAP greeting")); return;
			}
			console.log("Verified-TLS Dovecot greeting received");
			socket.destroy();
		});
		socket.once("error", error => {
			socket.destroy();
			if (error.code === "ECONNREFUSED" && Date.now() < deadline) setTimeout(attempt, 200);
			else { console.error(error); process.exitCode = 1; }
		});
	}
	attempt();
'
test_result=0
timeout --kill-after=5s 75s "$ENGINE" exec "$client" node --max-old-space-size=128 \
	--test --test-concurrency=1 --test-timeout=65000 \
	packages/backend/test/integration/imap-interop.test.cjs > "$scratch/test.log" 2>&1 ||
	test_result=$?
tail -c 65536 "$scratch/test.log"
exit "$test_result"
