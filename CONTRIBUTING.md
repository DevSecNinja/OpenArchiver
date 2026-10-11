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

### Archive path constraints

ZIP entry names and connector folder paths must be relative, slash-separated paths without empty,
dot or dot-dot components, backslashes or NULs. Absolute, drive-relative and UNC paths are rejected
before ingestion adds a source namespace. An optional trailing slash denotes a directory.
On POSIX hosts (including the Linux container), colons and trailing dots/spaces are literal filename
characters: existing keys remain readable and new uploads, folder names, message IDs and attachments
retain them without changing original metadata. On Windows hosts, stream/device names and trailing
dot/space aliases are rejected because they do not identify ordinary literal files. Valid Unicode
names remain supported. Unsafe ZIP names abort the import explicitly; previously processed entries
are not rolled back.

Local storage applies the same constraints to `put`, `get`, `delete`, `deleteObject`, and `exists`, including each
NFC/NFD lookup candidate, and refuses symlink components below the configured root. Existing archives
using such links must be migrated to ordinary directories/files. The configured root and its ancestors
are trusted; these checks are **not protection against concurrent filesystem mutation (TOCTOU)** or
host-managed mount/hard-link changes. Restrict filesystem write access to the archive service and trusted
administrators. Conditional writes retain the existing atomic hard-link publish behavior and its
documented non-atomic claim fallback on filesystems without hard links.

Ingestion and deletion share **64 fixed global PostgreSQL advisory lock stripes**, independent of
attachment count. Existing deduplication identities and exact storage paths map to these stripes;
stripe IDs are deduplicated and acquired in ascending order. Collisions serialize work without changing
the SQL equality/cardinality rules. High-fanout messages may occupy all 64 stripes temporarily.
Discovery only reads state: if a fresh read reveals another required stripe, the transaction rolls back
before external writes, expands its held set, and rechecks. Expansion strictly adds a stripe and is bounded
by 64; locks are never acquired out of order. Unicode-normalization variants share a path lock.

After acquiring the locks, a `READ COMMITTED` transaction rechecks deduplication and publishes the
full email or shared reference together with its attachment links. All enclosed database work uses
the same transaction connection. This deliberately holds a connection and transaction during storage
I/O; disjoint stripes remain independent. Monitor pool
capacity/storage latency rather than assuming this is a short, database-only transaction.

Storage or link-insert failures are explicit, and all new rows/links roll back so retries cannot skip an
incomplete email. Attachment-ID memoization is transaction-local; rolled-back IDs cannot leak into
another attempt. New attachment objects use stable root/full-SHA256 paths and conditional publication;
an existing winner must match decrypted bytes' hash and size before adoption. Retries can rediscover
files left by rollback without multiplying random object names. Original filename metadata and existing
random-path records remain usable. Corrupt winners are explicit failures, not overwritten.

Per-email deletion commits row/link removals before physical cleanup. Cleanup reacquires exact-path
stripes and rechecks references in both email and attachment tables; a concurrently published reference
prevents removal. `deleteObject` removes exactly one object, unlike the existing `delete` prefix contract.
DB/search/storage are not one atomic system: a crash, failed audit or cleanup error after metadata commit
can leave unlinked bytes. These are not blindly deleted, and no general repair/GC service is introduced.

**Whole-source deletion is a conservative coarse-gate operation:** it cancels queued jobs before
acquiring all 64 stripes and never waits for workers while holding their locks. Active transactions
finish first; queued/cached-source writers must freshly verify their source/root inside the gate before
publishing. Group membership is rechecked before DB removal, then prefix cleanup reacquires all stripes
and retains prefixes still referenced by any email/attachment row. External attachment ownership that
would break a surviving link refuses deletion explicitly. Cooperating archive **writes may pause
globally during large source-deletion phases**; ordinary reads do not take this gate. This is an
implementation tradeoff, not a user-selected throughput setting or deployment approval.
After metadata commit, unused pending PST/EML/MBOX upload objects from the deleted source and its
children are removed with exact-object deletion, never prefix deletion. Archive references and
surviving file-source credentials are rechecked under the same locks; the encrypted source scan is
paged. Source create/update publishes upload references under the path locks and verifies newly
selected objects still exist, without requiring a consumed upload to exist for an ordinary source edit.
Partial or blank provider edits are merged against fresh, locked credentials, never a preflight
encrypted snapshot; concurrent replacement and canonical input clearing cannot be undone by a blank form.
Referenced objects are retained; undecipherable relevant credentials fail cleanup explicitly.

### Uploaded-input completion

Migration `0045_upload_completion_receipt` adds one nullable, internal `sync_sessions.upload_receipt`
JSONB column. It stores only the source ID, original uploaded storage key, a closed normalized mailbox
set, and canonical outcomes, never credentials or mail content. Existing/null/malformed receipts do
not authorize deletion. This bounded upload-only receipt is a conservative implementation decision,
not a user-selected retention setting or a general attempt-lease system.

EML, MBOX and PST connectors no longer delete an uploaded input when enumeration ends or fails.
The masters close discovery before persisting a receipt and dispatching jobs with the original input
snapshot. The worker reports success only after iteration, all email writes and indexing-queue
handoff complete with zero fetch/archive failures. Results are recorded idempotently per declared
mailbox under the session row lock: reporting A twice cannot complete `[A, B]`, and unknown input or
mailbox identities cannot advance progress. Failure/skip before full canonical success stays failed;
only a redundant attempt after independently established success can be ignored.

Finalization and stale-session terminal shortcuts use canonical coverage for uploaded sessions, not
aggregate counters. A separate release step takes storage stripes before source/session locks, checks
fresh credentials, the original session/input identity and other unfinished sessions, then clears only
the matching consumed `uploadedFilePath`. Original display-name metadata, ordinary edits and reupload
remain supported. Failed/canceled/partial-discovery, paused or ambiguous input stays retained.
For a successfully completed old input, finalization may perform exact reference-safe cleanup without
changing replacement credentials or newer import status. The receipt's optional `disposition: handled`
is recorded only after cleanup succeeds (including retaining bytes owned by another reference).
An absent current path is not disposition proof; cleanup/marking failures keep the receipt available
for retry or explicit source purge. Failed old receipts and stale recovery do not overwrite newer status.
Stale recovery makes a genuinely inactive **current** uploaded import retryable as `error` while
retaining its receipt and input. It rechecks the source/input, session heartbeat and discovery-claim
time under locks, and defers if a newer or active session exists. It does not manufacture completion
or retire ambiguous old work. Releasers honor the freshly locked `handled` disposition before any
credential/storage action, and upload finalization preserves a pause made after its earlier reads.
Unfinished receipts continue protecting their original input even after a source is repointed; source
deletion collects their keys before cascade. Source credentials and receipts participate in both exact
and prefix cleanup reference checks.

MBOX continues to stream without whole-file spooling. No session-row lock is held while waiting for
storage stripes. External/local file paths are never released by this completion hook. A crash between
metadata release and physical cleanup can retain unlinked input bytes; there is no new GC framework.
API job/session responses omit the internal receipt and upload-job snapshot.

These changes do not repair historical partial imports or promise safe arbitrary concurrent regrouping,
filesystem mutation, or direct SQL/object-store changes outside the protocol. Deploy the API and
workers together: mixed application versions that do not share this lock namespace cannot coordinate.

`ingestion-attachments.test.cjs` uses the same explicit `STORAGE_AUTH_TEST_DATABASE_URL` and isolated
PostgreSQL database pattern as the authorization tests below. It calls the compiled EMLConnector,
IngestionService and encrypted storage with original colon/trailing-dot/space names in both preservation
modes, verifies retrieved bytes and same-source deduplication, and injects storage and database-link
failures before retry, including shared-reference publication. Concurrent independent service instances
exercise two mailboxes in a merge group, headerless preserve-mode hash deduplication, unrelated-key
progress, and a one-connection pool. Tests also check compiled deletion against uncommitted publication,
rollback object counts/winner corruption, source purge versus active/late writers, exact deletion and
the measured lock budget for many small attachments. Search/queue orchestration is controlled in these
tests; no external mailbox is contacted.
Hosted `pnpm test:oss` runs it with the existing PostgreSQL service. Without an explicit local test URL
it is skipped, not counted as integration proof.

`upload-completion.test.cjs` uses the same isolated PostgreSQL service to exercise duplicate and
unknown results, partial discovery, last-mailbox release, failures/cancellation, shared and repointed
inputs, and actual worker/finalizer paths. Its valid-plus-broken ZIP uses a real corrupt ZIP entry;
the streaming MBOX parser failure and PST folder failure are injected bounded fixtures. No real PST
import or external mailbox coverage is implied. PST attachment construction refuses an incomplete
message before it reaches persistence; missing/unreadable attachment-stream cases exercise a healthy
same-ID retry through the real worker/database path, while absent optional recipient properties remain
permitted.

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
