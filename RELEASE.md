# Release procedure

How to cut a release of `slopwork` and publish it to npm.

## Prerequisites

- **Bun ≥ 1.3 required at runtime.** The CLI is Bun-native (no pure-Node build), and CI/release
  pin `bun-version: "1.3.11"` in `.github/workflows/`.
- **`NPM_TOKEN` repo secret.** An npm [automation or granular access token][npm-tokens] with
  publish rights on the `slopwork` package, added at
  Settings → Secrets and variables → Actions → `NPM_TOKEN`. This is a one-time human setup step —
  it cannot be created from a workflow.

[npm-tokens]: https://docs.npmjs.com/creating-and-viewing-access-tokens

## Cutting a release

1. **Bump the version.** On `main`, with a clean working tree:

   ```sh
   npm version patch   # or: minor / major / 1.2.3
   ```

   This updates `package.json`'s `version` field, commits it (`vX.Y.Z`), and creates a matching
   annotated git tag — do not hand-edit the `version` field.

2. **Push the commit and the tag:**

   ```sh
   git push origin main
   git push origin vX.Y.Z
   ```

   Pushing the `vX.Y.Z` tag is what triggers `.github/workflows/release.yml`.

3. **Watch the release run** (Actions tab → Release). It re-runs the full gate (lint,
   format:check, typecheck, test, build) plus a smoke test of the compiled binary, confirms the
   pushed tag matches `package.json`'s `version`, then runs `npm publish --provenance
   --access public` using `NPM_TOKEN`. Any gate failure aborts the release before anything is
   published.

4. **Verify** on [npmjs.com/package/slopwork](https://www.npmjs.com/package/slopwork) that the
   new version, and its provenance attestation, are live.

### Manual / dry-run publish

The same workflow can be run by hand from the Actions tab → Release → **Run workflow**, e.g. to
verify the gate + tarball on a branch without needing a tag. Tick **dry_run** to run the full gate
and `npm publish --dry-run` (nothing actually published) — leave it unticked to publish for real
from that ref.

## What v0 ships

`package.json`'s `files` list ships `bin/`, `src/`, `README.md`, and `LICENSE` — **source, not
the compiled `dist/` binary**. `npm i -g slopwork` installs a small launcher (`bin/slop.mjs`) that
runs the TypeScript sources directly via Bun; there is no build step for npm consumers. `bun run
build` (used in CI/release for the smoke test) is a quality gate, not a publish artifact.

## Version scheme

Plain [semver](https://semver.org/), no `v0`/prerelease conventions beyond what `npm version`
gives you. While the package is pre-1.0 (`0.x.y`), treat minor bumps as potentially breaking.
