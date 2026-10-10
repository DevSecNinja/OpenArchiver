# Open Archiver frontend

Use the Node and pnpm versions declared in the root `package.json`. Install from
the repository root with `pnpm install --frozen-lockfile`, then run
`pnpm --filter @open-archiver/frontend dev`. Development uses Vite's proxy;
production uses the compiled SvelteKit API route and Node adapter instead.

## Building and checking

From the repository root:

```sh
pnpm --filter @open-archiver/frontend check
pnpm build:oss
```

Framework updates require a fresh source build. Installing a newer SvelteKit
beside an old `build/` directory does not replace framework code embedded in the
compiled output. Use a clean checkout without `node_modules`, `.svelte-kit`,
`build`, `dist`, or `*.tsbuildinfo` from a previous build.

## Production adapter regression

The regression runs the actual `build/index.js`, not Vite or a reimplementation
of the frontend. Run it in an isolated container with **no host ports published**
and **no external network**. From a clean checkout, build the existing OSS build
stage and run:

```sh
podman build --target build -f apps/open-archiver/Dockerfile -t localhost/openarchiver-frontend-test .
podman run --rm --network none --read-only --tmpfs /tmp \
  --workdir /app/packages/frontend \
  localhost/openarchiver-frontend-test node --test tests/production.test.mjs
```

The equivalent package command is
`pnpm --filter @open-archiver/frontend test:production`. It requires an existing
source build and the same isolation; it does not install packages or rebuild.
Remove the task-owned image after use.

The test starts its own frontend on loopback port 3000 and a synthetic HTTP API
on port 4000 in the same network namespace, preserving the production
`localhost:4000` contract. It does not start the real backend or require SQLite,
a mailbox, a database, cloud credentials, or a real JWT secret.
The frontend's unrelated GitHub release lookup receives a synthetic 404 through
a test-only preload; other external fetches fail explicitly.

Coverage includes configured `ORIGIN` and trusted reverse-proxy origin headers,
setup/sign-in rendering and synthetic login responses, production auth-cookie
handling, authorization/query/body forwarding, same-origin multipart uploads,
wrong/missing-origin rejection before forwarding, the SAML callback exception,
body-size boundaries (including chunked requests), and API error responses.

This verifies frontend transport and session handling only. The mock does not
prove backend authorization, password validation, archive parsing, or browser
interaction. Full application end-to-end testing and scanning the final
production image are separate checks; build-stage success is not evidence that
the production image has all its runtime dependencies.
