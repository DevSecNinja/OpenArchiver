# Container runtime and recovery

The OSS container is built from reviewed source and its committed lockfile, retaining the root AGPL
license and the types package's MIT license. Enterprise implementation and license agreements are
unchanged. This runtime work depends on the pnpm 12.10.1 / SheetJS integrity foundation in
[DevSecNinja/OpenArchiver#72](https://github.com/DevSecNinja/OpenArchiver/pull/72).
Do not edit generated lockfile checksums or suppress integrity failures.

The revised runtime fixture and Dockerfile also depend on the unused-SQLite removal in
[DevSecNinja/OpenArchiver#123](https://github.com/DevSecNinja/OpenArchiver/pull/123). That separate
change owns the manifest, lockfile and SQLite build-approval removal. Until it is integrated, this
runtime-only patch deliberately fails its package-absence checks against the old dependency graph.
A labeled PR #123 removal + PR #118 runtime fixture passed on Linux amd64 using build tree
`8b0bc66fca460c6d80c9a9fdcef1f1d32d35897f` and application image
`sha256:ebf4f4871e1c82684b64a6bb7db60078f3834a0ba19b7be14e332934ca83e233`.
The final external harness tree was `8e64f816b7717a096aa8dcae7928e4a3f7b9e61f`: its retry-counter
assertion was corrected after the image build, without changing the application image. That harness
adds a real initial-import retry and duplicate-import check not yet included in this runtime-only
patch. It passed package/binding absence, default/arbitrary-UID read-only startup, HTML/assets,
PostgreSQL migrations, ingestion/search, retry/dedup, shutdown and paired restore.

The retained `sqlite-removal-validation-receipt.json` has SHA-256
`e49fbb2ab398028f80b52a9c2c5756ac0551e60ae0109c2a5e1c2ff207365c1b`; the external driver has SHA-256
`376f9fbd7d53121ed609f885c856c75cc36d83e9f550ff839288f0427bd6e94f`.
This is combined-fixture evidence, not standalone PR #118 validation: it also uses the removal
branch's actual-main dependency graph, including SvelteKit 2.70.3 rather than this branch's 2.38.1.
Final merged-main, platform and adoption acceptance remain pending. No new vulnerability scan,
ARM64, live-provider, PST or S3 result is claimed for this combination. Earlier results below remain
historical.

## Container contract

Build the OSS image from source; do not patch dependencies into an old precompiled image. Source
builds are serialized across workspaces to avoid concurrent compiler memory pressure.

```sh
docker build -f apps/open-archiver/Dockerfile -t open-archiver:local .
```

The default identity is `node` (UID/GID 1000). An arbitrary non-root UID/GID is supported when the
operator pre-owns the archive volume for that identity. The image does not change mount ownership at
startup and does not require a platform-specific NAS account.

Container engines may initialize a named volume's root ownership from the image. For an arbitrary UID,
pre-create an owned archive subdirectory and set `STORAGE_LOCAL_ROOT_PATH` to that directory; do not
assume that changing an empty volume's root before its first application mount prevents engine
initialization. The integration fixture uses an owned `archive` subdirectory and verifies its UID.

For example, initialize a **new, empty** named volume with the intended container UID/GID before
starting writers (this one-off helper runs as root; the application does not):

```sh
docker volume create archive-data
docker run --rm --network none --user 0:0 --entrypoint sh \
  --mount type=volume,source=archive-data,target=/data,volume-nocopy \
  open-archiver:local \
  -c 'mkdir -p /data/archive && chown 12345:12345 /data/archive'
```

Mount that volume at `/var/data/open-archiver` with copy-up disabled, run as `12345:12345`, and set
`STORAGE_LOCAL_ROOT_PATH=/var/data/open-archiver/archive`. With Compose, override both `user` and the
volume target accordingly; the supplied Compose file normally mounts its named volume directly at
`STORAGE_LOCAL_ROOT_PATH` for the default identity. Set ownership using container IDs in the engine's
user namespace, not an assumed host account mapping. Existing archives need a planned ownership
migration while all writers are stopped; do not recursively change unrelated directories.

- `/app` and the root filesystem can be read-only.
- `STORAGE_LOCAL_ROOT_PATH` defaults to `/var/data/open-archiver` and needs a writable persistent
  volume, including when S3 storage is selected.
- `/tmp` needs writable scratch space. Size it for uploads, PST extraction, and concurrent jobs.
  It must not be treated as the durable archive.
- Locked production dependencies are installed at build time. The revised image omits unused SQLite
  and its compiler/rebuild steps, verifies package absence and the supervisor CLI, and relies on the
  real PostgreSQL-backed application lifecycle for readiness. No runtime install repairs dependencies.
- `verifyDepsBeforeRun: false` preserves the no-install runtime contract under pnpm 12.
- The API and frontend share a network namespace. Keep backend port 4000 for the compiled frontend's
  localhost proxy. Expose the frontend only; `PORT_FRONTEND` controls its internal listening port.
- Tini forwards termination to the process group. The OSS launcher stops siblings on a child exit
  without an internal restart loop; the external container supervisor owns restarts.
- `INDEXING_WORKER_MAX_OLD_SPACE_MB` retains its 2048 MiB default.

Only `/tmp` and the configured persistent storage need writes. No writable home directory, package
store, `/app`, or startup package-registry access is required. The entrypoint does not repair missing
dependencies. Dropped Linux capabilities and `no-new-privileges` are part of the Compose contract.

By default, migrations finish before the main command starts. A PostgreSQL advisory lock serializes
concurrent migration processes. For split workers, run a migration job successfully first and set
`RUN_MIGRATIONS=false` on those workers. That flag is not a readiness check and must not be used to
skip required migrations. Invalid values fail startup.

After migrations, probe `GET /api/v1/auth/status` through the frontend to establish HTTP readiness
(`needsSetup` is true only on an unconfigured archive). The image does not define a Docker healthcheck;
configure the deployment's probe and restart policy explicitly. That endpoint is not evidence that
every queue or external service is healthy.

`drizzle-kit` is a development-only schema generation/push tool. Install development dependencies
before running `db:generate` or `db:push`; neither the kit nor `drizzle.config.ts` belongs in the
production image. Startup executes the compiled migrator with `drizzle-orm` and the SQL journal.
`@sveltejs/kit` is also development-only: adapter-node emits the runtime frontend into `build`.
Its version remains 2.38.1 in this change; this is dependency classification, not a framework upgrade.
Keep later framework version updates when integrating this classification change.

The Compose application service builds local source. The dedicated container validation workflow
has read-only permissions and does not publish images or deploy. Production sidecar versions remain
unchanged pending separate review; test fixtures are not production recommendations.

## Validation

```sh
pnpm install --frozen-lockfile
pnpm build:oss
pnpm test:runtime
docker build -f apps/open-archiver/Dockerfile -t open-archiver:test .
pnpm test:integration
```

For Podman, set `CONTAINER_ENGINE=podman`; `TEST_IMAGE` selects the locally built image.
The integration driver uses an internal, unexposed network, unique resource names, synthetic
credentials and a generated EML-in-ZIP with an attachment. It removes only resources it created.
`docker/compose.test.yml` pins test sidecars independently of production defaults. The Node base and
test sidecars pin multi-platform OCI indexes, not individual amd64 manifests. Each selected index
retains the original tested amd64 child and also supplies a native arm64 child.

Excluding host `dist` without excluding `*.tsbuildinfo` lets TypeScript skip needed output. Both
incremental metadata and nested host `node_modules` are excluded, with build assertions and CI
contamination markers. Environment files, package-manager config, archive data and secrets are also
excluded from the build context.

The initial SQLite-based packaging needed a full-workspace native rebuild: filtering it to the backend
removed other workspace links and the root `concurrently` executable. That rebuild is no longer
needed after the unused dependency is removed. The revised build retains the production CLI check
and verifies that neither the SQLite package nor its native binding is installed. Other platform
dependencies are still installed normally; no package files are manually stripped. The integration
driver starts the actual default command rather than replacing it with a test-only server.

The fixture covers default UID 1000 and arbitrary UID 12345 read-only startup using the actual image
command, rendered `/setup` and `/signin` HTML with first-party emitted JavaScript and CSS assets,
concurrent fresh migrations, setup/authentication/authorization, cross-origin upload
rejection, original MIME hashes and embedded attachment bytes, encrypted storage, body/attachment
search, completed full reindex, unchanged archive keys, restart persistence, shutdown without respawn,
a paired database/files restore preserving distinct credential and archive encryption keys,
restored ingestion-source API state, search rebuilding, and nonzero
termination after a fatal worker exit. With `preserveOriginalFile=true`, attachments remain inside the
EML; no separate attachment rows are expected.

Historically, on 2026-10-10, the runtime slice based on foundation `d1f69c83` passed the source build,
five runtime tests, six inherited OSS policy tests, and the complete fixture above on rootless Podman
5.8.6, Linux amd64. The final image ID was
`sha256:d53b694c40a6aacf9e3cac73d0be4c09d026094d8bfbd1bfa6d7685cf1356a8d`.
That image build also passed the host-contamination assertions, runtime tests, and final-user native
SQLite/concurrently checks. Hosted CI reports native amd64 and arm64 results separately; this local
result does not establish ARM64 success. No deployment or upstream image publication is claimed.

Image build/test success is not a vulnerability clearance. Scan the exact built image, retain its
image ID/digest and scanner database date, and separate installed packages from reachable behavior.
The base stage upgrades the Alpine OS `zlib` package within the image's configured Alpine branch at
build time, not startup. Confirm the installed version and scan the resulting image: Alpine
`1.3.2-r1` fixes CVE-2026-85091 affecting `1.3.2-r0`. This does not establish the status of any zlib
copy bundled with Node or another dependency.
The historical SQLite 5 artifact's native build-tool findings are not a reason to retain an unused
database dependency; its removal is tracked separately in PR #123. The same-major
concurrently 9.2.4 supervisor still pins vulnerable shell-quote 1.9.0; see
[DevSecNinja/OpenArchiver#113](https://github.com/DevSecNinja/OpenArchiver/issues/113).
The launcher uses static operator-controlled command strings, not request data. This limits the
exposed input path but is not an advisory fix. Do not pass untrusted command strings or environment
values to the supervisor. The newer major is deliberately not included or overridden here.
Concurrently 10.0.6 first meets the three-day release-age requirement at
`2026-10-11T12:53:46Z`; this change does not waive that gate or claim a shell-quote fix.
Do not infer that all advisories are fixed from a successful install or from excluding an unused
development tool. Record an actual final-image inventory and scan limitations separately.

That historical amd64 image contained Node 22.23.3, pnpm 12.10.1, SQLite 5.1.7, concurrently 9.2.4,
Alpine 3.24.2, tini 0.19.0-r3 and OS zlib 1.3.2-r1. Inspection found the native SQLite binding and
no physical esbuild executable, `drizzle-kit`, `drizzle.config.ts`, or installed `@sveltejs/kit`.
Trivy 0.74.0 scanned the exported image using its database updated at
`2026-10-10T12:33:35Z`: 19 Alpine package records with no vulnerability matches and 846 Node package
records with **8 critical, 107 high, 96 medium and 12 low** package-advisory matches. No Go executable
target remained. These are scanner matches, not deduplicated exploitability findings. Trivy warned
that Alpine 3.24 was absent from its end-of-life list; this is not an OS support-lifecycle attestation.

Those historical critical matches include CASL, fast-xml-parser, form-data, localization packages,
proxy-addr, shell-quote and node-tar. SQLite dependency remediation remains separate in
[DevSecNinja/OpenArchiver#28](https://github.com/DevSecNinja/OpenArchiver/issues/28), alongside the
other issue-specific dependency updates. Removing development packages does not update bundled
frontend framework code: the compiled frontend still uses SvelteKit 2.38.1, and a manifest-based
image scan may miss bundled vulnerabilities. The scan excludes test sidecars and is not a live
application security assessment.
These inventory and scan counts predate later main dependency updates and the SQLite-removal
revision; they must not be presented as results for a new image or the combined removal fixture.

The ZIP path-escape concern raised in the review of
[DevSecNinja/OpenArchiver#117](https://github.com/DevSecNinja/OpenArchiver/pull/117) is unresolved in
this runtime slice. Its contained reproduction and ingestion/local-storage path fix belong to that
separate follow-up. The benign synthetic ZIP lifecycle here does not establish that hostile archive
paths are safe.

Live iCloud/Outlook authentication and S3 are not covered by synthetic imports. No PST fixture is shipped,
so EML-in-ZIP coverage is not a claim that a representative PST import has passed.

## Consistent backup and restore

Database changes and archive writes are not one transaction. A PostgreSQL dump by itself is not an
archive backup, and independently timed storage/database snapshots can lose or orphan records.

1. Stop new uploads and syncing, pause sources, and let ingestion/indexing jobs finish. Confirm the
   queues are drained; a bounded process shutdown is not a guarantee that an in-flight archive write
   has completed.
2. Stop every API, scheduler and worker that can change the archive. Keep PostgreSQL available for a
   consistent `pg_dump -Fc`, and capture the matching archive files or S3 object versions while writers
   remain stopped.
3. Back up configuration and encryption keys securely alongside the recovery set, not in Git.
   Preserve `ENCRYPTION_KEY` and `STORAGE_ENCRYPTION_KEY`; new keys cannot decrypt existing data.
   Record source/image versions and PostgreSQL version.
4. Restore into an isolated stack with pre-owned storage, the same keys, and the matching source/image
   first. Restore both the database dump and file/object data. Run migrations once before traffic.
5. Rebuild search from restored archive data with a full reindex. Do not replay stale Redis jobs from
   a different point in time. Verify login/permissions, counts, original EML hashes, attachment bytes,
   integrity results and search before enabling live ingestion.

Prove restoration with a disposable test stack before relying on a backup. Do not delete the original
recovery set until the restored archive is verified.
