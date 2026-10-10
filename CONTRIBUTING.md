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

Validate configuration changes with:

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
or authentication middleware.

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

## Contributor License Agreement

By submitting a pull request to this repository, you agree to the terms and conditions of our [Contributor License Agreement](./.github/CLA.md)

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

We use Prettier for code formatting. Before you commit new code, it is necessary to check code format by running this command from the root folder:

`pnpm run lint`

If there are any format issues, you can use the following command to fix them

`pnpm run format`
