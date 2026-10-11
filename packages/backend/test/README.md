# Localization dependency regressions

These Node.js tests cover the focused dependency update in
[issue #9](https://github.com/DevSecNinja/OpenArchiver/issues/9). They use the real
filesystem backend, HTTP middleware, Express, and compiled translation assets;
they do not start the full archive application or require archive data.

From a clean Linux checkout with the repository's pinned pnpm and Node.js 22:

```sh
pnpm install --frozen-lockfile --prod=false
pnpm build:oss
pnpm --filter @open-archiver/backend test:localization
```

The tests cover all 11 packaged languages, an explicitly configured English
fallback for an unsupported language, rejection of language/namespace path
components, and query/header handling with English and Dutch system languages.
The filesystem negative cases require the backend's controlled `unsafe lng/ns`
error: `ENOENT`, including paths containing HTML-escaped slashes, is not evidence
of path validation or a demonstrated arbitrary-file read.

## Configuration and applicability

`src/api/server.ts` initializes `i18next.use(FsBackend)` with
`dist/locales/{{lng}}/{{ns}}.json` and installs `middleware.handle(i18next)`.
It uses the saved system language (or English when absent) for both `lng` and
`fallbackLng`. The tests mirror that setup for supported system languages.
The unsupported-language test deliberately sets `fallbackLng: 'en'` in the
dependency fixture; it does **not** claim that an unsupported saved system
language automatically falls back to English in the application.

The server does not register `LanguageDetector` or mount `missingKeyHandler`,
and does not enable missing-key persistence. Query/header inputs therefore must
not override the configured system language. Header CR/LF is percent-encoded in
the fixture; the test does not send invalid raw HTTP headers or exercise a
detector that the application does not use.

The direct dependency paths are
`@open-archiver/backend -> i18next-fs-backend` and
`@open-archiver/backend -> i18next-http-middleware`. The selected, aged Renovate
44.149.2 candidates are `2.6.0 -> 2.6.8` and `3.8.0 -> 3.9.9`, respectively.
The caret ranges are retained; i18next core remains at locked version `25.4.2`.

The update was generated with pnpm 12.10.1 using exact version arguments:

```sh
pnpm --filter @open-archiver/backend update i18next-fs-backend@2.6.8 i18next-http-middleware@3.9.9 --lockfile-only --ignore-scripts
```

The npm registry records both releases on 2026-09-08, before Renovate's
three-day minimum age on the validation date. Their registry SHA-512 values
match the generated lockfile. No other dependency resolutions, integrity
values, release-age exceptions, or dependency build approvals changed.

| Advisory                                                                 | Package                 | First fixed | Relevant surface                                    |
| ------------------------------------------------------------------------ | ----------------------- | ----------- | --------------------------------------------------- |
| [GHSA-8847-338w-5hcj](https://github.com/advisories/GHSA-8847-338w-5hcj) | i18next-fs-backend      | 2.6.4       | Language/namespace path components                  |
| [GHSA-2933-q333-qg83](https://github.com/advisories/GHSA-2933-q333-qg83) | i18next-fs-backend      | 2.6.6       | Crafted missing-key strings and prototype pollution |
| [GHSA-jfgf-83c5-2c4m](https://github.com/advisories/GHSA-jfgf-83c5-2c4m) | i18next-http-middleware | 3.9.3       | User-controlled language/namespace paths and SSRF   |
| [GHSA-c3h8-g69v-pjrg](https://github.com/advisories/GHSA-c3h8-g69v-pjrg) | i18next-http-middleware | 3.9.3       | Unsanitized Content-Language response headers       |
| [GHSA-5fgg-jcpf-8jjw](https://github.com/advisories/GHSA-5fgg-jcpf-8jjw) | i18next-http-middleware | 3.9.3       | Prototype pollution and path traversal              |
| [GHSA-f49m-vf83-692w](https://github.com/advisories/GHSA-f49m-vf83-692w) | i18next-http-middleware | 3.9.7       | Prototype-polluting missing-key segments            |

GitHub advisory records were checked on 2026-10-10. The original locked versions
match these advisory ranges; the selected versions are outside them. This is
version-range evidence, not proof that each vulnerable path was reachable or
that the full application is free of vulnerabilities. Missing-key/detector
surfaces are not enabled solely to exercise advisories.

## Runtime validation boundary

The baseline final Docker stage does not install production dependencies
([issue #2](https://github.com/DevSecNinja/OpenArchiver/issues/2)); an inventory
of that empty stage cannot establish an unaffected production installation.
SQLite's native build is also unapproved and outside this update's scope
([issue #28](https://github.com/DevSecNinja/OpenArchiver/issues/28)).

A production-dependency validation fixture may instead install from the frozen
lockfile with scripts disabled, copy this checkout's freshly compiled outputs
and test file, then run `node --test packages/backend/test/localization.test.mjs`
as UID/GID `12345:12345` with a read-only root filesystem and no external
network. Such a fixture checks actual installed localization versions and
packaged-resource reads without changing the application Dockerfile or native
build policy. It is **not a working full archive image** and does not establish
database, worker, archive-storage, or deployment readiness.

## Observed validation (2026-10-10)

A fresh Linux snapshot of foundation `d1f69c8` plus this focused change had no
inherited dependencies or build outputs. Node.js `22.23.3` and pnpm `12.10.1`
completed the frozen installation, full `build:oss`, and `test:oss`: all nine
tests passed (six existing policy tests and three localization tests).
The lockfile and strict workspace-policy hashes were unchanged by the build.
The existing frontend warnings were not treated as a standalone
`svelte-check` result.

The separate dependency fixture used the cached Node.js `22.23.3-alpine` base
at digest `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`,
a fresh `pnpm install --frozen-lockfile --prod --ignore-scripts`, and this
snapshot's newly compiled OSS outputs. It was not derived from another
application image. Podman server `5.8.6` produced fixture image
`sha256:6a66e5762539dbabef451183fa72d63abd004223af287799c48c167f1bd25de5`.

```sh
podman run --rm --read-only --read-only-tmpfs=false --user 12345:12345 \
  --network none --cap-drop ALL --security-opt no-new-privileges \
  localhost/open-archiver:issue9-localization-fixture
```

In-process assertions confirmed UID/GID `12345:12345`, a read-only root mount,
and actual backend-resolved package manifests: `i18next-fs-backend@2.6.8`,
`i18next-http-middleware@3.9.9`, and unchanged `i18next@25.4.2`. All three
localization tests passed in that runtime. A separate
`pnpm list --prod --recursive --depth Infinity --json` captured the installed
production graph; it was not an empty-image inventory.

These installed localization versions are outside the six advisory ranges
listed above. No full-image vulnerability clearance, native SQLite support,
or archive startup/integration claim follows from this fixture.
