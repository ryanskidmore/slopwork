# slopwork

Slopwork (`slop`) is a free, open-source work tracker built for agents. Engineers break work
into a dependency graph of tickets; coding agents pick tickets up, plan their approach, work
through a session, and leave an auditable trail — progress notes, plan checkpoints, an MR, and a
transcript — ending in `done`. v0 is a local CLI backed by a flatfile JSONC database
(`.slop/db/`) designed to be git-mergeable across parallel agent streams, plus a read-only local
web explorer (`slop web`). See `design.md` for the full spec and `v0-implementation-plan.md` for
how it was built.

This repo is itself the implementation, and v0 ships complete: all 22 commands are implemented
and covered by acceptance tests — setup (`init`, `instructions`, `reindex`), ticket shaping
(`new`, `split`, `draft`, `undraft`, `edit`, `update`), the agent loop (`ready`, `start`,
`context`, `plan`, `review`, `stop`, `done`, `drop`), and inspection (`status`, `show`, `search`,
`events`, `web`). See `v0-implementation-plan.md` §3 for the work-item breakdown behind each one.

## Installation

Slopwork needs **Bun ≥ 1.3 at runtime** no matter which install channel you use — the CLI is
Bun-native (`Bun.serve`, `Bun.file`, `Bun.YAML`, and text-imports throughout `src/`), so there is
no pure-Node build.

```sh
# Bun (recommended — the tool needs Bun at runtime)
curl -fsSL https://bun.sh/install | bash    # if Bun isn't installed
bun add -g slopwork

# Node users: works too, via a launcher that delegates to Bun
npm i -g slopwork       # (still requires Bun installed; prints a clear message if missing)
```

## Quickstart

```sh
slop init --yes
slop new "My first ticket"
slop ready
slop start <slug>        # -> plan -> update --progress -> review --mr -> done
slop web                 # read-only explorer at http://localhost:4553
```

Run `slop instructions` for the full agent loop and house rules, or `slop <command> --help` for
any command's options.

## Development

Requires [Bun](https://bun.sh) ≥ 1.3. Developed and tested on Linux and macOS; Windows is
best-effort (untested), with platform guards in place so it degrades gracefully rather than
crashing.

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

## Lifecycle: `review` → `done` (C3)

Stored ticket states: `draft ⇄ open → in_progress → review → done`, plus `dropped` (wontdo) from
any non-terminal state (design.md §2). The three closing commands:

- **`slop review <ref> --mr <url>`** — `in_progress → review` only. `--mr` is
  required-*with-warning* (D15/§8.1 item 3): omit it and the command still succeeds, but nags on
  stderr; `ticket.review.mr` is left absent, not `null`. The session stays **active** across a
  review round-trip — `review` only captures a fresh transcript snapshot into it, never sets
  `ended_at`. See `DECISIONS.md`'s C3 entries for the full session-model writeup.
- **`slop done <ref> [--note]`** — `review → done` **only**; there is no direct
  `in_progress → done` shortcut (§2's diagram draws none, and §5's house rule says "open an MR and
  call review before claiming done"). Finalizes the session (end summary from `--note`, transcript
  captured per D16, `active_session` cleared) and runs B4's done-cascade exactly once, emitting
  `ticket.ready` for any dependent this ticket was blocking.
- **`slop drop <ref> --reason "…"`** — `→ dropped` from any non-terminal state; `--reason` is
  required. Finalizes the session if one is active (a `dropped` ticket also stops blocking its
  dependents — same cascade as `done`, called exactly once).
- **Re-`start` from `review`** — `slop start <ref>` on a `review`-state ticket is D15's
  changes-requested re-entry: `review → in_progress`, `review` cleared, a fresh session started, no
  `--takeover` needed, logged as a re-entry (`re_entry: true` on the relevant events).

`src/tickets/state.ts` is the single source of truth for which of these transitions are legal;
`tests/acceptance/C3.test.ts` includes a `fast-check` property test that drives the compiled
binary through random operation sequences and checks every result against an independently
transcribed copy of §2's legal-transition table.

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
    errors.ts            SlopError + reportError — shared error-reporting used by every command
    commands/
      index.ts            registers all 22 commands, grouped as in design.md §4.2
      <command>.ts          one file per command (new.ts, start.ts, review.ts, ...)
      shared.ts             tiny option-parsing helpers (collect, parseIntegerOption)
  core/                 entity types, schemas, ids, serialization, exit codes
    exit-codes.ts         the exit-code table above
    index.ts               module re-exports; entity types/schemas/ULIDs/JSONC live here
  repo/                 flatfile store: atomic writes (tmp+rename), `.slop/db/.lock`, ref
                        resolution, the derived index, and the event writer
    index.ts               re-exports the repo layer (atomic-write, db-index, events, refs,
                            sessions, tickets, ...); ticket/session CRUD is built on this
  tickets/              ticket-domain logic on top of repo/: state machine, done-cascade,
                        staleness, search, ancestry/tree, jira ref parsing
  sessions/             session lifecycle: harness/git capture, plan versioning + diff,
                        context pack, start/stop/finalize, transcript capture
  web/                  read-only local web explorer (`slop web`)
    index.ts               re-exports the HTTP server + data source; serves any real `.slop`
                            directory (not just fixtures) at http://localhost:4553 by default
tests/
  acceptance/            one file per work item — <ITEM-ID>.test.ts
```

## License

MIT — see `LICENSE`.
