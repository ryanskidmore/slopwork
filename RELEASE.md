# Release procedure

How to cut a release of `slopwork` and publish it to npm.

## Prerequisites

- **Bun ≥ 1.3 required at runtime.** The CLI is Bun-native (no pure-Node build), and CI/release
  pin `bun-version: "1.3.11"` in `.github/workflows/`.
- **npm trusted publisher configured on npmjs.com.** Publishing uses [npm trusted publishing via
  OIDC][npm-trusted-publishers] — no npm token secret is stored in this repo. A maintainer with
  publish access on the `slopwork` package must add a trusted publisher at
  npmjs.com → package `slopwork` → Settings → Trusted Publisher, pointing at this GitHub repo,
  the `.github/workflows/release.yml` workflow file, and (if used) the deploy environment. This is
  a one-time human setup step — it cannot be created from a workflow. The workflow authenticates
  by minting a short-lived OIDC token (via the `id-token: write` permission) that npm exchanges
  for a publish credential at run time; this requires **npm CLI ≥ 11.5.1**, which the release
  workflow installs explicitly before publishing since the Node LTS default npm can be older.

[npm-trusted-publishers]: https://docs.npmjs.com/trusted-publishers/

## Cutting a release

1. **Cut the changelog.** Move `CHANGELOG.md`'s `## Unreleased` content under a new
   `## X.Y.Z — YYYY-MM-DD` heading and leave a fresh empty `Unreleased` section. The release
   workflow extracts this exact section as the GitHub Release notes and **fails the release if the
   section is missing**, so this step must land before the tag.

2. **Bump the version.** On `main`, with a clean working tree:

   ```sh
   npm version patch   # or: minor / major / 1.2.3
   ```

   This updates `package.json`'s `version` field, commits it (`vX.Y.Z`), and creates a matching
   annotated git tag — do not hand-edit the `version` field.

3. **Push the commit and the tag:**

   ```sh
   git push origin main
   git push origin vX.Y.Z
   ```

   Pushing the `vX.Y.Z` tag is what triggers `.github/workflows/release.yml`.

4. **Watch the release run** (Actions tab → Release). It runs the same `bun run check:required`
   gate as CI (lint, format check, typecheck, coverage thresholds, frontend component tests, build,
   browser smoke tests, compiled-binary smoke, and installed-tarball verification), confirms the
   pushed tag matches `package.json`'s version, then runs `npm publish --access public`,
   authenticating via OIDC trusted publishing (no token secret involved). Provenance attestation
   is generated automatically as part of trusted publishing. Any gate failure aborts the release
   before anything is published. After a successful publish it creates the matching **GitHub
   Release**, with notes extracted verbatim from the version's `CHANGELOG.md` section.

5. **Verify** on [npmjs.com/package/slopwork](https://www.npmjs.com/package/slopwork) that the
   new version, and its provenance attestation, are live, and that the GitHub Releases page shows
   the new tag with its changelog notes.

### Manual / dry-run publish

The same workflow can be run by hand from the Actions tab → Release → **Run workflow**, e.g. to
verify the gate and tarball on a branch without needing a tag. A manual dispatch is always a dry
run: it executes the full validation and installed-tarball checks but never invokes `npm publish`
(even npm's `--dry-run` rejects versions that are already published). Publishing for real requires
pushing a matching `v*` tag; there is no manual override for an arbitrary ref.

## What v0 ships

`package.json`'s `files` list ships `bin/`, `src/` (minus `src/**/*.test.ts` — the co-located
tests were roughly half the tarball and are useless to an installer), `README.md`,
`CHANGELOG.md`, and `LICENSE` — **source, not the compiled `dist/` binary**. The source payload
includes the generated web assets built by the `prepack` lifecycle hook. `npm i -g slopwork`
installs a small launcher (`bin/slop.mjs`) that runs the TypeScript sources directly via Bun;
there is no build step for npm consumers. `bun run build` (used in CI/release for the compiled
smoke test) is a quality gate, not a publish artifact.

`bun run verify:package` creates the real `.tgz`, rejects missing or disallowed files, installs
that archive into a clean temporary project, checks the installed source entry and generated web
assets, and runs the installed `slop --version` and `slop --help`. CI and release both reach it
through `check:required`; a metadata-only `npm pack --dry-run` is not considered package proof.

## Dependency-audit disposition

As of 2026-08-02, `bun audit` reports
[GHSA-qwww-vcr4-c8h2](https://github.com/advisories/GHSA-qwww-vcr4-c8h2) through React Router. The
advisory concerns RSC-mode action execution. Slopwork uses a browser-only router with element
routes and a read-only GET API; it has no RSC mode or route actions, so the vulnerable path is not
present. Do not upgrade React Router solely to silence this non-applicable advisory. Re-evaluate
the disposition if the web application adopts RSC mode, route actions, or server-side mutations.

## Version scheme

Plain [semver](https://semver.org/), no `v0`/prerelease conventions beyond what `npm version`
gives you. While the package is pre-1.0 (`0.x.y`), treat minor bumps as potentially breaking.
