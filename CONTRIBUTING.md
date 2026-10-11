# Contributing to Open Archiver

First off, thank you for considering contributing to Open Archiver! It's people like you that make open source such a great community. We welcome any and all contributions.

## Where do I start?

Not sure where to start? You can:

- Look through the [open issues](https://github.com/LogicLabs-OU/OpenArchiver/issues) for bugs or feature requests.
- Check the issues labeled `good first issue` for tasks that are a good entry point into the codebase.

## How to Contribute

### Reporting Bugs

If you find a bug, please ensure the bug was not already reported by searching on GitHub under [Issues](https://github.com/LogicLabs-OU/OpenArchiver/issues). If you're unable to find an open issue addressing the problem, open a new one. Be sure to include a **title and clear description**, as much relevant information as possible, and a **code sample** or an **executable test case** demonstrating the expected behavior that is not occurring.

### Suggesting Enhancements

If you have an idea for an enhancement, please open an issue to discuss it. This allows us to coordinate our efforts and prevent duplication of work.

### Pull Requests

1.  **Fork the repository** and create your branch from `main`.
2.  **Set up your development environment** by following the instructions in the `README.md`.
3.  **Make your changes.** Ensure your code follows the project's coding style.
4.  **Write tests** for any new functionality.
5.  **Ensure all tests pass** before submitting your pull request.
6.  **Update the documentation** if your changes require it.
7.  **Submit a pull request** to the `main` branch of the main repository. Please provide a clear description of the problem and solution. Include the relevant issue number if applicable.

## Maintaining dependencies in this fork

`renovate.json` covers workspace packages and the pnpm lockfile, Docker/Compose images, and GitHub
Actions. It enables fork processing, leaves automerge disabled, limits concurrent PRs to four, and
requires dashboard approval for major updates. HTTP/authorization, mail/upload, and SvelteKit
non-major updates are separate groups; do not combine unrelated fixes into one maintenance PR.

Validate configuration changes with Node.js 24 (required by this Renovate CLI version):

```sh
npx --yes --package=renovate@44.149.2 renovate-config-validator --strict renovate.json
```

For a non-writing inventory, set `RENOVATE_CONFIG_FILE=renovate.json` in the environment and run
the same Renovate version with `--platform=local --dry-run=lookup --onboarding=false`.
GitHub Actions lookups require an authorized GitHub token. Docker Hub anonymous pagination limits may
leave image lookups incomplete; a missing proposal does not prove that an image is current.

The operator confirmed Mend Renovate access and enablement on 2026-10-10. This was not independently
confirmed by the available GitHub token, whose App-installation lookups were denied. After the
configuration lands on the default branch, verify a successful, non-silent repository job in the
[Mend portal](https://developer.mend.io/). Configuration validation and local lookups do not prove that
the hosted bot is operational. See [Mend's fork processing and onboarding documentation](https://docs.renovatebot.com/mend-hosted/hosted-apps-config/).

Dependency PRs must include source rebuilds and relevant regression results, not only lockfile
changes or a package-manager audit. Keep upstream synchronization manual and reviewed, preserving
fork patches. Do not use Renovate to automatically merge upstream commits.

### Pinned toolchain and tarball integrity

Use Node.js 22 and the pnpm version pinned in `package.json` (12.10.1). The Docker build and
documentation workflow read that pin rather than selecting another version. Enable the Corepack
pnpm shim so nested workspace scripts use the same version. From a clean checkout:

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build:oss
```

`pnpm-workspace.yaml` allows only the previously approved `esbuild` dependency scripts. The other
listed builds remain denied, including `sqlite3`; this toolchain change does not repair native SQLite
runtime support. `verifyDepsBeforeRun: false` preserves explicit installation: `pnpm run` and
`pnpm exec` must not install dependencies implicitly.

`minimumReleaseAgeStrict: true` makes pnpm reject unattended updates when no requested version meets
its release-age policy, rather than automatically recording exceptions. Interactive exceptions require
explicit approval. The default minimum release age is unchanged (one day); choose an eligible release
or wait instead of adding an exclusion.

The backend uses the official SheetJS 0.20.3 tarball at
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. Its SHA-512 integrity, verified against a current
official download on 2026-10-10, is:

```text
sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==
```

This verifies the downloaded artifact, not historical byte-for-byte equivalence: no trusted checksum
was recorded in the old lockfile. An unchanged URL or version is not proof that past bytes match.
For this missing-integrity repair, pnpm removed and re-added only that identical URL with
`--lockfile-only` (and `--ignore-scripts` on add); the generated checksum was independently compared
with the download. Do not hand-edit generated hashes, delete the entire lockfile, or disable
integrity checks.

pnpm 10.34.6 can discard tarball integrity on update. See
[pnpm/pnpm#14351](https://github.com/pnpm/pnpm/issues/14351) and
[pnpm/pnpm#12185](https://github.com/pnpm/pnpm/issues/12185) for the upstream fix verification.
When changing this toolchain, run `pnpm --filter @open-archiver/backend update xlsx --lockfile-only`
twice, checking that the recorded checksum survives each operation and that no unrelated dependency
resolutions or integrity values change, then repeat the frozen install and OSS source build.

### Mail/upload parser regressions

After the explicit frozen install above, run the bounded, synthetic parser tests with Node.js 22:

```sh
pnpm --filter @open-archiver/backend exec node --test --test-timeout=30000 test/mail-upload-parsers.test.cjs
```

After building the backend, `pnpm test:oss` also runs the compiled application boundary tests in
`archive-containment.test.cjs`.

These built-in `node:test` checks use the existing parser dependencies, not a new test framework.
They need no API server, database, native SQLite binding, external services, mail credentials, or real
mailbox data. Fixtures are generated in memory with small binary attachments and ZIP payloads.

The suite passes multipart bytes through **Busboy**, ZIP entries through **yauzl** with the
connector's `lazyEntries: true, decodeStrings: false` options, and MIME bytes through **mailparser**.
It checks nested entry names, raw bytes/SHA-256, attachment bytes, repeated reads, invalid/truncated
ZIP and multipart data, MIME stream errors, and an explicit HTML-to-text limit. MIME parsing is
deliberately lenient: a missing final MIME boundary can still yield complete attachment content;
it is not a strict MIME validator. With `decodeStrings: false`, yauzl does not automatically reject
unsafe entry names. EMLConnector validates raw names explicitly before filtering or parsing entries;
the compiled connector tests require rejection rather than accepting traversal as a library quirk.
These checks do not establish a total archive-size limit.

The upload controller uses Busboy directly. The separate Multer memory-upload/size-limit smoke test
checks a declared dependency only, not the production upload route. Neither its test size limit nor
the mailparser HTML test limit changes the controller/connector configuration.

The compiled boundary suite invokes the upload controller with synthetic request/response streams,
encrypted StorageService, and EMLConnector, retrieving raw MIME and attachment bytes in both
preserve-original modes. It tests LocalFileSystemProvider operations against owned outside-root
sentinels, Unicode normalization fallback, existing symlink components, conditional-write contention,
and failed-stream cleanup. An isolated copy of the unmodified compiled IngestionService class
uses inert infrastructure imports to verify rejection before file reads or DB/queue access.

These are parser and application-boundary regressions, **not full ingestion or restore tests**.
They do not establish HTTP authentication/authorization, real database deduplication/retries,
indexing, or a matching database/archive checkpoint restore. Those remain prerequisites for
closing [issue #5](https://github.com/DevSecNinja/OpenArchiver/issues/5). Keep source-build results,
the installed dependency graph/advisory inventory, and any actual ingestion, retrieval, encrypted
storage, indexing, deduplication, and matching database/archive restore evidence separate in the PR.
Preserve-original mode intentionally stores attachments inside the raw EML without separate
attachment rows. No PST import coverage is implied by these synthetic EML/ZIP fixtures.

### Mail-composer and IMAP dependency regressions

The backend pins Nodemailer 10.0.14 and ImapFlow 2.3.0 for
[issue #124](https://github.com/DevSecNinja/OpenArchiver/issues/124). Their registry publication
times are `2026-10-03T13:45:29.976Z` and `2026-10-08T14:12:31.660Z`, respectively.
Both met pnpm's unchanged 1440-minute (24-hour) installation floor during validation:
`pnpm-workspace.yaml` sets `minimumReleaseAgeStrict: true` without an explicit duration.
Separately, `renovate.json` sets `"minimumReleaseAge": "3 days"`, the repository's 72-hour
adoption gate. Nodemailer met both thresholds; ImapFlow did not yet meet the adoption gate
during the morning validation on 2026-10-11. It reached 72 elapsed hours at
`2026-10-11T14:12:31.660Z` (16:12:31.660 CEST), not at a calendar-day boundary.
At resumption on `2026-10-11T16:01:51.183Z`, all 26 resolved packages in the two updated
parents' dependency closure met 72 hours, including all seven newly added lockfile resolutions.
Their registry integrity values matched the lockfile; no dependency or test bytes changed.
The morning test results remain historical evidence, not a new execution after the age gate.
Successful installation or age eligibility alone is not adoption or publication approval.
At selection before 07:00 UTC, Nodemailer 10.1.0 and ImapFlow 2.4.0 were still inside
pnpm's one-day floor. These are intentionally exact parent versions, not overrides or
release-age exceptions.

Nodemailer 10.0.14 contains the address-list accumulation fix
[GHSA-2x7j-588g-ccc2](https://github.com/advisories/GHSA-2x7j-588g-ccc2) (fixed in 9.1.0)
and free-text fallback fix
[GHSA-v53p-9fqp-m79j](https://github.com/advisories/GHSA-v53p-9fqp-m79j) (fixed in 10.0.6).
The direct dependency and mailparser now resolve to the same fixed copy.

ImapFlow 1.0.191 imported its separate Nodemailer 7.0.5 copy only from
`lib/proxy-connection.js`, for the HTTP/HTTPS CONNECT proxy client. ImapConnector supplies no
proxy option; its LIST/FETCH envelope parsing is not the Nodemailer address-parser path.
ImapFlow 2.3.0 removes that dependency through a supported parent update. Its v2 migration
requires Node.js 20+ and publishes CJS/ESM through an export map; our Node.js 22 build uses the
package-root API and needs no connector or declaration shim. Package presence alone did not
establish SMTP, OAuth/TLS, raw-option SSRF, or address-parser exploitation through ImapFlow.

After a frozen install and OSS build, run:

```sh
pnpm --filter @open-archiver/backend exec node --test --test-concurrency=1 --test-timeout=30000 test/mail-composer.test.cjs
```

This suite is also discovered by `pnpm test:oss`. It runs the real compiled
`stripAttachmentsFromEml` with 4/8/16/32 recipients and messages smaller than 4 KiB. In-memory
counters precede the original installed accumulator operation, and a delegating `compile`
hook isolates composer work from mailparser's initial parse. Neither the helper nor dependency
files are rewritten. The linear-work assertion fails on 8.0.2 with 10/36/136/528 logical element
copies and passes on 10.0.14 with 4/8/16/32 appends; repeated runs must agree. This is not a
timed denial-of-service, CPU-instruction measurement, or free-text fallback reproduction.

Additional checks preserve ordinary/encoded From, To, Cc and Reply-To, threading/custom headers,
text/HTML, inline bytes and the byte-identical no-attachment/inline-only shortcuts. An isolated,
unmodified compiled IngestionService runs both preservation branches with real encrypted local
storage and retrieval, but synthetic database results and inert eager infrastructure. It checks
separate attachment bytes/links in default mode and original MIME with no separate attachment
rows or composer call in preserve-original mode. It does not cover database deduplication,
collisions, retries, indexing, or the separate filename/retry repair.

The IMAP check constructs the actual client and parses synthetic source through the compiled
connector in both modes without connecting. Real mailbox LIST/FETCH, authentication, TLS,
proxies and server interoperability remain unverified. Keep the full source/test results and
resolved dependency advisory inventory separate from native SQLite, full-runtime and image
scan evidence; this change does not approve deployment or claim a zero-vulnerability artifact.

#### Opt-in Dovecot interoperability fixture

`packages/backend/test/integration/run-imap-interop.sh` is an opt-in real-server
fixture. Its source is prepared separately from the already validated composer regressions;
runtime results must be recorded before treating it as interoperability evidence.
The first local preparation stopped before dependency installation because effective kernel
resource limits could not be verified. No local interoperability success is claimed.
The OSS workflow therefore includes one bounded hosted-Linux step that reuses its existing
compiled build and runs the fixture explicitly; this initial CI wiring is not itself a
runtime-validation result.
It requires a prebuilt Linux amd64 workspace, Docker or Podman with effective cgroup-v2
limits, and existing Bash and `timeout` tools. Certificate generation uses the existing
OpenSSL in the same pinned Dovecot image, not a host tool installation. It does not install
dependencies or build images. Network preparation is explicit and separate from the isolated
protocol run:

```sh
bash packages/backend/test/integration/run-imap-interop.sh prepare
bash packages/backend/test/integration/run-imap-interop.sh run
# Use CONTAINER_ENGINE=podman for either command when appropriate.
```

The runner pins official Dovecot 2.4.4 to manifest
`sha256:723e3392fe16c6fad8ddc605ea767cc01b4bad9cd9f13eb1dbac15e79c89b2d4`
and reuses the existing frontend fixture's pinned Node 22 image. On 2026-10-11, registry
manifest/config hashes were verified without pulling layers; the Dovecot tag was last pushed
on 2026-06-03 and the Node tag on 2026-10-06, both beyond the 72-hour gate. The choice follows
[ImapFlow's Dovecot integration fixture](https://github.com/postalsys/imapflow/tree/v2.3.0/test/integration),
but does **not** copy its certificate-verification bypass or plaintext-auth override.

Each run generates an owned, short-lived CA and server certificate with localhost/IP SANs
in a network-disabled, capped certificate helper that exits and is removed before the server
and client start; the temporary CA private key is then deleted.
Only the client test processes trust that CA, via `NODE_EXTRA_CA_CERTS`; production TLS
configuration is untouched. The server requires TLS. The server and client each have a
256 MiB memory/no-swap ceiling, one CPU and 128 PIDs; the runner verifies effective controls,
uses read-only filesystems with small temporary writable paths, and fails rather than
relaxing unavailable controls. They share a network-disabled namespace using loopback,
with no host ports. Readiness, test execution and cleanup have explicit deadlines. CI caps
the entire preparation/protocol step at ten minutes; certificate and test output are limited
to their final 16 KiB and 64 KiB respectively, without discarding failure exit codes.

The opt-in test drives the actual compiled ImapConnector and installed ImapFlow through
implicit TLS and STARTTLS, authentication, LIST/select, both passes of UID-based fetching,
MIME/attachment reads in both preservation modes, cursor resume, logout and early iterator
return. It separately exercises explicit SEARCH on the connector-owned client, since the
production UID-only criterion can optimize away SEARCH. Wrong-password and untrusted-CA
cases must reject and close. Messages and credentials are synthetic; no OAuth, proxy, live
provider account, real ingestion database or production archive is involved. Ordinary
`pnpm test:oss` discovery skips this test unless the isolated runner opts in. Passing one
Dovecot fixture is not multi-provider, full-ingestion, concurrency or deployment clearance.

### Archive path constraints

ZIP entry names and connector folder paths must be relative, slash-separated paths without empty,
dot or dot-dot components, backslashes, colons, NULs, or trailing dots/spaces in a component.
An optional trailing slash denotes a directory. These portable constraints also reject absolute,
drive-relative, UNC and Windows alias forms before ingestion adds a source namespace. Valid Unicode
names remain supported. Unsafe ZIP names abort the import with an explicit error; previously
processed entries are not rolled back.

Local storage applies the same constraints to `put`, `get`, `delete`, and `exists`, including each
NFC/NFD lookup candidate, and refuses symlink components below the configured root. Existing archives
using such links must be migrated to ordinary directories/files. The configured root and its ancestors
are trusted; these checks are **not protection against concurrent filesystem mutation (TOCTOU)** or
host-managed mount/hard-link changes. Restrict filesystem write access to the archive service and trusted
administrators. Conditional writes retain the existing atomic hard-link publish behavior and its
documented non-atomic claim fallback on filesystems without hard links.

### Backend authorization and HTTP regression checks

After a locked install with the repository's declared pnpm version, rebuild and run these focused
checks from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm build:oss
node --test packages/backend/test/authorization-dependencies.test.cjs packages/backend/test/http-dependencies.test.cjs
pnpm --filter @open-archiver/backend list @casl/ability axios express express-rate-limit express-validator --depth 0
```

The authorization tests load the compiled `createAbilityFor` and mailbox-condition normalization
code. They check individual ingestion and archive instances, source/mailbox allow and deny rules,
default denial, and administrator access. Storage downloads use archive permissions, not a separate
storage subject; these tests cover the policy decision, not the database-backed storage-path lookup
or authentication middleware. The PostgreSQL-backed storage checks below cover the separate lookup.

The HTTP tests bind an ephemeral loopback port and exercise Express JSON parsing and async errors,
Axios redirects/streaming/error responses, request validation, and rate-limit responses/headers.
They also check proxy-trust CIDR matching, bounded optional route expansion, and wildcard parameters
through Express's actual transitive dependencies; no extra direct dependencies or overrides are needed.
They use synthetic routes rather than the application server and disable Axios proxy discovery.
Axios and express-validator are declared dependencies but currently have no direct backend source
imports; their fixtures check package compatibility, not live connector behavior. No database,
mailbox credentials, Redis, search service, or cloud resources are needed for these focused tests.

Record the resolved versions from the rebuilt installation alongside any audit/scan findings in
the dependency PR. A passing fixture or dependency inventory does not establish that the full
artifact is free of vulnerabilities.

### PostgreSQL storage authorization checks

`storage-authorization.test.cjs` calls the compiled `ArchivedEmailService.canAccessStoragePath`
against a real PostgreSQL database. It exercises the email query, attachment lookup and carrier-email
query through the real IAM service, CASL rules, filter builder and SQL translator. Cases include both
source/mailbox boundaries, normalized addresses, explicit denial, read versus search permission,
administrator access, shared attachments and missing/unreferenced files.

For local execution, start a disposable PostgreSQL 17 server on loopback with a dedicated test role
allowed to create databases. Use only test credentials; do not point these checks at an application
database. After the OSS build, set the explicit test URL and run:

```sh
STORAGE_AUTH_TEST_DATABASE_URL='postgresql://storage_test:storage_test@127.0.0.1:5432/postgres' \
  node --test packages/backend/test/storage-authorization.test.cjs
```

The fixture accepts only a loopback `/postgres` maintenance URL, creates a uniquely named database,
applies the committed migrations, inserts synthetic records and drops only its own database afterward.
It never reads `DATABASE_URL` or real provider credentials. The connection export is replaced with
a real Drizzle/PostgreSQL connection to that database; no authorization, filter or query result is
mocked. Unrelated ingestion, storage I/O, search and deletion entry points are blocked with
fail-on-use test doubles to avoid starting provider, queue or native-SQLite dependencies.

Without the explicit test URL this check is marked skipped locally; in CI a missing URL fails.
The OSS validation job supplies an ephemeral PostgreSQL service and test-only credentials, so this
coverage runs with `pnpm test:oss`. These are service/database authorization tests, not download-route,
filesystem containment, authentication or full archive end-to-end tests.

## OSS validation in this fork

From a clean checkout, use Node.js 22 and the pnpm release declared in the root
`package.json` `packageManager` field. Do not substitute a different pnpm release or regenerate
the lockfile just to get validation to pass. Run these commands from the repository root on Linux
(or in WSL on Windows, since the existing build uses POSIX commands):

```sh
pnpm install --frozen-lockfile
pnpm build:oss
pnpm test:oss
```

`.github/workflows/validation.yml` runs these commands for pull requests, pushes to `main`, and
manual dispatches. A separate Node.js 24 job runs the strict Renovate validator documented above.
Failures stop their job; no build or test failures are ignored. The workflow uses read-only repository
permissions, SHA-pinned actions, and checkouts without persisted credentials. It does not use production
secrets, publish images, or deploy documentation. Repository administrators can require the
`OSS build and regressions` and `Renovate configuration` checks in branch protection; adding the workflow
alone does not configure required checks.

The OSS build runs TypeScript compilation for the shared types, backend, and OSS entry point, plus
the frontend's Vite/Node-adapter build. `pnpm test:oss` uses Node's built-in test runner, including the
real compiled `createAbilityFor` function and installed CASL dependency; build first, including after
source changes. The runner discovers both CommonJS (`*.test.cjs`) and ESM (`*.test.mjs`) tests under
`packages/backend/test`. Its synthetic policy/subject fixtures cover default denial, mailbox and source
boundaries, action isolation, explicit denial, no implicit ingestion-to-archive grants, and administrator
wildcards. It also discovers the mail/upload parser regressions documented above. No real mailboxes,
mail contents, attachments, or cloud credentials are used.
The same runner also discovers the focused HTTP and PostgreSQL storage authorization checks described
above. CI supplies the isolated PostgreSQL service; local database coverage requires the explicit test URL.

### Coverage limits and follow-up work

This is a build, policy/HTTP/storage-authorization/parser, and frontend-adapter regression gate,
not end-to-end archive validation.
Frontend regressions exercise compiled session and proxy behavior against a synthetic loopback API,
not real API authentication. The gate does not establish all policy interpolation or database filtering,
full ingestion, indexing/search, export, deletion, or matching database/archive restoration.
The policy tests import the compiled policy module, HTTP checks use synthetic loopback fixtures, and
storage checks call the compiled service with isolated database rows, not the application entry point.
The compiled application-boundary tests and MIME/attachment coverage limits are documented above.

Only `esbuild` is approved in `pnpm-workspace.yaml` `allowBuilds`, and `sqlite3` is explicitly denied,
so a normal locked installation does not build the SQLite native binding. A passing source build does not prove that
SQLite or the production application can start. Native-module checks, image builds, non-root startup,
migrations, synthetic ingestion/search, and restore integration coverage belong to
[issue #2](https://github.com/DevSecNinja/OpenArchiver/issues/2). Do not bypass native checks or treat
this workflow as evidence that the runtime gap is fixed.

The workflow separately runs `pnpm --filter @open-archiver/frontend check` and the compiled
production-adapter regressions described in `packages/frontend/README.md`. It reuses the OSS source
build in a read-only Node 22 container with no external network or published host ports; the test
starts a synthetic API on loopback port 4000. This does not prove real backend authorization or
archive processing. The workflow does not run repository-wide Prettier checks because inherited
formatting warnings would obscure the focused gate. Check formatting only for files you change;
do not mass-format unrelated source.

The inherited Docker publication, release tagging, Pages deployment (including its upstream CNAME),
and CLA jobs are restricted to the non-fork `LogicLabs-OU/OpenArchiver` repository. Their existing
upstream targets remain unchanged. They are skipped in this fork, even if it is later detached from
its fork network, and no fork publication is configured. Elevated repository permissions stay inside
the guarded upstream jobs that need them.

## Contributor License Agreement

By submitting a pull request to this repository, you agree to the terms and conditions of our [Contributor License Agreement](./.github/CLA.md)

The statement above is inherited and references `CLA.md`, while the inherited upstream CLA workflow
references `CLA-v2.md`. Clarification of the fork's contributor policy and this reference ambiguity is
pending. All license and CLA texts remain unchanged. Skipping the upstream-only CLA job prevents
failures caused by unavailable upstream credentials; it does not resolve the policy ambiguity or
establish legal compliance.

## Code of Conduct

This project and everyone participating in it is governed by the [Open Archiver Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior.

## Styleguides

### Git Commit Messages

- Use the present tense ("Add feature" not "Added feature").
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...").
- Limit the first line to 72 characters or less.
- Reference issues and pull requests liberally after the first line.

### TypeScript Styleguide

- Follow the existing code style.
- Use TypeScript's strict mode.
- Avoid using `any` as a type. Define clear interfaces and types in the `packages/types` directory.

### Formatting

We use Prettier for code formatting. In this fork, check the files you change from the repository root,
replacing the example path with the changed file paths:

```sh
pnpm exec prettier --check path/to/changed-file
```

To fix their formatting, use the same explicit paths:

```sh
pnpm exec prettier --write path/to/changed-file
```
