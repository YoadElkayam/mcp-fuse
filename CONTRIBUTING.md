# Contributing to mcp-fuse

Thanks for helping make MCP failure handling deterministic.

## Setup

```bash
pnpm install
pnpm build
pnpm test
```

Node ≥ 20 and pnpm ≥ 9 required.

## The cheapest valuable contribution: classifier corpus

The zero-config classifier lives in
[`packages/core/src/classifier.ts`](packages/core/src/classifier.ts). If you've seen
an MCP server emit an error string that gets misclassified (or lands in `unknown`),
open a PR that:

1. Adds the real-world error text as a test case in
   [`packages/core/src/core.test.ts`](packages/core/src/core.test.ts)
2. Adds/adjusts a rule so it classifies correctly

Rules must be conservative: when in doubt, prefer `unknown` (one retry) over a
confident wrong category.

## Spec changes

The MEP schema ([`spec/`](spec/)) is the contract for every implementation, including
the future Java port. Schema changes require:

- An issue describing the use case first
- Additive-only changes within version `1`
- A new example payload in `spec/examples/` exercising the new field

## Releasing (maintainers)

Versions follow semver; `mcp-fuse` and `mcp-fuse-core` release together.

1. Bump `version` in `packages/core/package.json` and `packages/proxy/package.json`.
2. Commit, then tag: `git tag v0.x.y && git push --tags`.
3. The `Release` workflow builds, tests, and publishes both packages to npm with
   provenance via npm Trusted Publishing (OIDC) — no tokens involved. The trusted
   publisher for each package is configured on npmjs.com to this repo's
   `release.yml`.

Manual fallback: `npm login`, then `pnpm -r publish --access public` from a clean
checkout.

## Conventions

- Commits: `type(scope): message` — e.g. `feat(core): classify grpc RESOURCE_EXHAUSTED`
- Branches: `feat/`, `fix/`, `chore/`
- All code TypeScript-strict; `mcp-fuse-core` stays zero-runtime-dependency.
