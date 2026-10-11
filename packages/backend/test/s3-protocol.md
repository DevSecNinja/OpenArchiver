# S3 SDK protocol regression coverage

These tests load the compiled `S3StorageProvider`, not a replacement provider or the
whole API. They use Node's built-in test runner, a loopback HTTP server on an ephemeral
port, and synthetic credentials. No AWS account, bucket, database, or SQLite native
binding is required. No requests are sent to AWS.

## Running the tests

Use Node 22 and the repository-pinned pnpm 12.10.1. From a clean Linux checkout, with
no pre-existing `node_modules`, build output, or TypeScript incremental state:

```sh
pnpm install --frozen-lockfile
pnpm build:oss
pnpm test:oss
```

After an existing clean install, the smaller compile/test command is:

```sh
pnpm --filter @open-archiver/types build
pnpm --filter @open-archiver/backend build
node --test packages/backend/test/s3-protocol.test.mjs
```

The root `test:oss` command and OSS validation CI discover this suite alongside
the other backend tests; the explicit command above runs only the S3 suite.
Coverage includes single-part upload/download byte preservation, successful and
missing-object HEAD responses, conditional PUT refusal on 412, one 409 retry with
the same `If-None-Match: *` header and original bytes, XML 403 error deserialization,
and multipart upload of exactly 5 MiB + 123 bytes in two distinguishable parts.

This mock does not validate AWS authentication/signatures, IAM policy, TLS,
live AWS behavior, or compatibility with every S3-compatible service. It is not
evidence for the separate prefix-deletion issue, and no deletion contract is changed.

## Dependency investigation

The pre-update foundation lockfile resolved:

```text
@aws-sdk/client-s3@3.844.0
  -> @aws-sdk/core@3.844.0
    -> fast-xml-parser@5.2.5
@aws-sdk/lib-storage@3.844.0
  -> @aws-sdk/client-s3@3.844.0
```

The relevant input surface is SDK processing of S3 XML responses and errors, not
parsing archived email bodies. The
[3.844.0 `parseXmlBody` implementation](https://github.com/aws/aws-sdk-js-v3/blob/v3.844.0/packages/core/src/submodules/protocols/xml/parseXmlBody.ts)
constructs `XMLParser` without `processEntities: false`; `parseXmlErrorBody` calls
that same parser. The provider's XML paths include service errors and multipart
control responses. Successful object downloads remain raw streams.
[GHSA-jmr7-xgp7-cmfj / CVE-2026-26278](https://github.com/advisories/GHSA-jmr7-xgp7-cmfj)
affects parser entity expansion for 5.x versions before 5.3.6, including 5.2.5.
Whether an attacker can control an S3 response reaching this installation has not
been demonstrated; a package match is not proof of application exploitability.
[GHSA-gh4j-gqv2-49f6 / CVE-2026-41650](https://github.com/advisories/GHSA-gh4j-gqv2-49f6)
instead concerns `fast-xml-parser`'s XMLBuilder comment/CDATA output. It must not be
treated as evidence of the SDK response-parser path or confused with the distinct
`@aws-sdk/xml-builder` package.

The selected update is the same-version pair `@aws-sdk/client-s3@3.1147.0` and
`@aws-sdk/lib-storage@3.1147.0`, also proposed by
[Renovate PR #29](https://github.com/DevSecNinja/OpenArchiver/pull/29).
It preserves the existing caret-range policy and the release-age controls. The
October 6 releases satisfy the selected aging policy; the newer 3.1149 pair was
not adopted. Manifests and the lockfile were generated with pnpm, not a transitive
parser override:

```sh
pnpm --filter @open-archiver/backend update @aws-sdk/client-s3@3.1147.0 @aws-sdk/lib-storage@3.1147.0 --lockfile-only
```

## Validation results

Validated on October 10, 2026 against this S3-only slice on foundation `d1f69c8`
(tree-identical to the merged prerequisite `bebbeea` from
[PR #72](https://github.com/DevSecNinja/OpenArchiver/pull/72)). Later dependency PRs
on `main` are not included in this artifact's results.

The branch was subsequently fast-forwarded to actual `main` at `bccf876`, and
the preserved S3 patch reapplied with a clean Git three-way merge. The main
HTTP/authorization dependency updates and tests were retained. A structural
comparison confirms that the resulting lockfile differs from that main only in
the SDK dependency closure, with no manual lockfile resolution or age exceptions.
Hosted [run 38082652745](https://github.com/DevSecNinja/OpenArchiver/actions/runs/38082652745)
subsequently passed for head `a158ba4`: OSS build and 32 tests, with no failures or
skips, including all five S3 cases and PostgreSQL storage authorization.
That integrated graph was not rescanned locally.

On October 11, the branch was refreshed with actual `main` at `4c0805de` using a
conflict-free Git merge. Main's mail/parser, frontend, and HTTP dependency updates
and tests were retained. Structural checks confirm that only the original SDK
dependency closure differs from main, and all 37 updated SDK package/snapshot
records remain identical to `a158ba4`. The provider and protocol tests are unchanged.
No manual lockfile edits, package-manager reconciliation, or age exceptions were
needed. Hosted [run 38142178893](https://github.com/DevSecNinja/OpenArchiver/actions/runs/38142178893)
passed for `de485e0`: 51 backend tests including S3/PostgreSQL and 16 production
frontend tests, with no failures or skips. Frontend types had zero errors and
44 warnings. The actual GitHub Copilot
[Balanced review](https://github.com/DevSecNinja/OpenArchiver/pull/121#pullrequestreview-5483469443)
reported zero open findings on that head; it excluded the generated lockfile.

After [PR #122](https://github.com/DevSecNinja/OpenArchiver/pull/122) landed, the
branch was refreshed with actual `main` at `b27216e9`. The conflict-free merge
preserves the landed prefix pagination/error handling, `DeleteObjectCommand`
import, deletion tests, and shared `s3-fixture.mjs`. The SDK pair remains 3.1147.0.
Main's lockfile is unchanged from `4c0805de`, and the merged lockfile and SDK
manifest are unchanged from `de485e0`, preserving the prior structural graph proof.
**Fresh hosted CI and an actual matching-head Copilot review are pending signed
publication of this merge.** Earlier CI/review results do not cover the newly
combined deletion and SDK changes. No new installation, build, container, or scan
was run locally. Results and residual counts below remain old-base fixture evidence.

| Check                   | Result                                                                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Clean source snapshot   | No host `node_modules`, build output, or TypeScript incremental state                                                                                              |
| Node / pnpm             | 22.23.3 / 12.10.1                                                                                                                                                  |
| Source install / build  | `pnpm install --shamefully-hoist --frozen-lockfile --prod=false` and `pnpm build:oss` passed                                                                       |
| Source test discovery   | `pnpm test:oss`: 11 passed, including all 5 S3 cases                                                                                                               |
| Production-only fixture | Fresh `pnpm install --frozen-lockfile --prod --ignore-scripts` passed                                                                                              |
| Fixture tests           | All 5 S3 cases passed with `--read-only --network none` (loopback remains available)                                                                               |
| Installed versions      | client-s3 / lib-storage 3.1147.0; core 3.978.1; xml-builder 3.972.41                                                                                               |
| Installed inventory     | 595 package manifests under application `node_modules`; `fast-xml-parser` absent                                                                                   |
| Lockfile boundary       | Only the two SDK importers and their dependency closure changed; package-manager document, other importers, SheetJS SRI, and strict release-age controls unchanged |

The source image used the pinned multi-architecture base
`node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`.
Existing frontend circular-dependency warnings did not prevent the OSS build.

The foundation Dockerfile's final stage does not install runtime dependencies
([issue #2](https://github.com/DevSecNinja/OpenArchiver/issues/2)); inventorying that
empty graph would not establish successful remediation. A temporary
dependency/protocol fixture instead copied manifests and the generated lockfile
from this slice's fresh source-build image into a fresh pinned Node 22 stage,
installed the same pinned pnpm, ran the production-only install above, and copied
the compiled packages and S3 tests from that source image. It did not copy the
source image's `node_modules`.

This fixture deliberately leaves native SQLite unbuilt and does not validate API
startup or constitute a complete working archive image. The runtime fix remains a
separate prerequisite under issue #2. Do not publish the validation fixture.

### Artifact scan and residual findings

The exact fixture image
`sha256:825919941e3fdeb8d6e7705959466b7626481f95b32fea019dbac847ab79b0e8`
was exported as a Docker archive and scanned with Trivy 0.74.0, database updated
`2026-10-10T12:33:35Z`:

```sh
trivy image --input issue8-dependency-fixture.tar --scanners vuln --list-all-pkgs --format json --output issue8-trivy.json --timeout 10m
pnpm list --recursive --prod --depth Infinity --json
```

The captured installed graph contains 37 distinct package/version pairs in the
updated S3 SDK dependency closure. Matching that complete closure against the
scan produced **zero findings**, not merely zero package-name matches for the two
top-level SDKs. `fast-xml-parser` is absent from the actual application inventory.

The whole fixture still produced **405 finding rows**: 10 critical, 174 high,
187 medium, 24 low, and 10 unknown. These include repeated installed paths,
unrelated application dependencies, global npm/pnpm tooling, embedded Go binaries,
and OS packages. Trivy also warned that Alpine 3.24 was absent from its EOL list.
These results do not establish application exploitability or complete OS coverage.

[s3-dependency-scan.json](./s3-dependency-scan.json) records the dated
artifact/lockfile identities and selected S3 dependency closure. Full raw scan
results and the residual advisory inventory are retained separately as session
artifacts, not committed here. Residuals include HTTP/authorization, mail/upload,
frontend, localization, tooling, and base-image families. They remain separate
maintenance work, not additional changes in this PR.

**Adoption decision:** adopt the aged, supported SDK pair for the parser-path
remediation and preserved local S3 protocol behavior. Do not claim live AWS
compatibility, native/API readiness, or a globally vulnerability-free image.
