# slopworks

Slopworks (`slop`) is a free, open-source work tracker built for agents. Engineers break work
into a dependency graph of tickets; coding agents pick tickets up, plan their approach, work
through a session, and leave an auditable trail — progress notes, plan checkpoints, an MR, and a
transcript — ending in `done`. v0 is a local CLI backed by a flatfile JSONC database
(`.slop/db/`) designed to be git-mergeable across parallel agent streams, plus a read-only local
web explorer (`slop web`). See `design.md` for the full spec and `v0-implementation-plan.md` for
how it's being built.

This repo is itself the implementation. **A1 (this scaffold) only registers the full v0 command
surface and wires up build/test/lint tooling — command bodies are implemented by later work
items** (see `v0-implementation-plan.md` §3) and currently print `not yet implemented (work item
<ID>)` to stderr with exit code `3`.

## Development

Requires [Bun](https://bun.sh) ≥ 1.3.

```sh
bun install            # install dependencies
bun run test           # run the test suite (vitest)
bun run lint            # lint src/ and tests/ (biome)
bun run format          # apply formatting (biome, --write)
bun run format:check     # check formatting without writing
bun run typecheck        # tsc --noEmit
bun run build            # compile the standalone binary to dist/slop
bun run start            # run the CLI from source (bun src/cli/index.ts ...)
```

`bun run build` produces a **standalone, dependency-free executable** at `dist/slop` via
`bun build --compile`. That's the binary the acceptance criteria and CI check — not
`bun src/cli/index.ts`. After building:

```sh
./dist/slop --help
```

CI (`.github/workflows/ci.yml`) runs on every push and pull request: install → lint → format
check → typecheck → test → build → smoke-test the compiled binary.

## Exit codes

Every `slop` command exits with exactly one of the following codes (defined in
`src/core/exit-codes.ts`), so an agent driving the CLI can reliably branch on `$?` instead of
scraping output:

| Code | Name              | Meaning                                                    |
| ---- | ----------------- | ----------------------------------------------------------- |
| 0    | `SUCCESS`         | Command completed successfully.                            |
| 1    | `GENERIC_ERROR`   | Unexpected runtime error (I/O failure, bug, etc).           |
| 2    | `USAGE_ERROR`     | Bad invocation — missing/invalid arguments or flags.        |
| 3    | `NOT_IMPLEMENTED` | Command is registered but its body isn't built yet.         |
| 4    | `NOT_FOUND`       | A `<ref>` did not resolve to any entity.                    |
| 5    | `AMBIGUOUS_REF`   | A short-prefix or slug `<ref>` matched more than one entity.|
| 6    | `CONFLICT`        | Illegal state transition or other conflicting operation.    |

Command implementations should throw a `SlopError` (`src/cli/errors.ts`) carrying one of these
codes rather than calling `process.exit()` directly; the top-level handler in `src/cli/index.ts`
converts it to the process exit code (and does the same for Commander's own usage errors, help,
and `--version`).

## Testing

- **Unit tests live beside the code as `*.test.ts`** (e.g. `src/core/exit-codes.test.ts`).
- **Acceptance tests live in `tests/acceptance/<ITEM-ID>.test.ts`** — one file per
  `v0-implementation-plan.md` §3 work item (e.g. `A1.test.ts`, `A3.test.ts`, `B4.test.ts`). Each
  file's top-level `describe` is named `<ITEM-ID>: <item title>`, and a comment quotes that item's
  acceptance criterion verbatim from the plan. This convention is load-bearing — project
  verification greps for exactly one acceptance file per work item — so every new work item must
  land its `tests/acceptance/<ID>.test.ts` alongside its implementation.
- The test runner is **vitest** (`bun run test` → `vitest run`), which runs cleanly under Bun; no
  fallback to `bun test` was needed. See `vitest.config.ts`.

## Source layout

```
src/
  cli/                 CLI entrypoint + one module per command
    index.ts            entrypoint: builds the Commander program, top-level exit-code mapping
    errors.ts            SlopError + reportError + notImplemented — shared by every command
    commands/
      index.ts            registers all 22 commands, grouped as in design.md §4.2
      <command>.ts          one file per command (new.ts, start.ts, review.ts, ...)
      shared.ts             tiny option-parsing helpers (collect, parseIntegerOption)
  core/                 entity types, schemas, ids, serialization (A2), exit codes (A1)
    exit-codes.ts         the exit-code table above
    index.ts               module re-exports; A2 lands entity types/schemas/ULIDs/JSONC here
  repo/                 flatfile store, locking, ref resolution, index, events (A3/A4)
    index.ts               placeholder; nothing implemented yet
  web/                  read-only local web explorer (D5)
    index.ts               placeholder; nothing implemented yet
tests/
  acceptance/            one file per work item — <ITEM-ID>.test.ts
```

## License

MIT — see `LICENSE`.
