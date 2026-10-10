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
the frontend's Vite/Node-adapter build. `pnpm test:oss` uses Node's built-in test runner against the
real compiled `createAbilityFor` function and installed CASL dependency; build first, including after
source changes. The runner discovers both CommonJS (`*.test.cjs`) and ESM (`*.test.mjs`) tests under
`packages/backend/test`. Its synthetic policy/subject fixtures cover default denial, mailbox and source
boundaries, action isolation, explicit denial, no implicit ingestion-to-archive grants, and administrator
wildcards. No real mailboxes, mail contents, attachments, or cloud credentials are used.

### Coverage limits and follow-up work

This is a build and policy-unit-test gate, not end-to-end archive validation. It does not establish
authentication/session behavior, policy interpolation or database query filtering, ingestion, MIME or
attachment parsing, indexing/search, export, deletion, or matching database/archive restoration.
The tests deliberately import only the compiled policy module, not the application entry point.

At this baseline, only `esbuild` is approved in `pnpm.onlyBuiltDependencies`, so a normal locked
installation does not build the SQLite native binding. A passing source build does not prove that
SQLite or the production application can start. Native-module checks, image builds, non-root startup,
migrations, synthetic ingestion/search, and restore integration coverage belong to
[issue #2](https://github.com/DevSecNinja/OpenArchiver/issues/2). Do not bypass native checks or treat
this workflow as evidence that the runtime gap is fixed.

The frontend build is not a standalone `svelte-check` pass; full frontend type and behavior validation
belongs to [issue #6](https://github.com/DevSecNinja/OpenArchiver/issues/6). This baseline also does not
run repository-wide Prettier checks because inherited formatting warnings would obscure the focused
gate. Check formatting only for files you change; do not mass-format unrelated source.

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
