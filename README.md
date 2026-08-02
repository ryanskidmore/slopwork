# slopwork

Slopwork (`slop`) is a free, open-source work tracker built for agents. Engineers break work
into a dependency graph of tickets; coding agents pick tickets up, plan their approach, work
through a session, and leave an auditable trail — progress notes, plan checkpoints, and an
MR — ending in `done`. v0 is a local CLI backed by a flatfile JSONC database
(`.slop/db/`) designed to be git-mergeable across parallel agent streams, plus a read-only local
web explorer (`slop web`). See [`docs/design.md`](docs/design.md) for the full spec and
[`docs/v0-implementation-plan.md`](docs/v0-implementation-plan.md) for how it was built.

This repo is itself the implementation, and v0 shipped complete: all 22 commands from
design.md §4.2 are implemented and covered by acceptance tests — setup (`init`, `instructions`,
`reindex`), ticket shaping (`new`, `split`, `draft`, `undraft`, `edit`, `update`), the agent loop
(`ready`, `start`, `context`, `plan`, `review`, `stop`, `done`, `drop`), and inspection (`status`,
`show`, `search`, `events`, `web`). See
[`docs/v0-implementation-plan.md`](docs/v0-implementation-plan.md) §3 for the work-item breakdown
behind each one. Since then, `slop list` (filtered ticket enumeration, G3) joined the inspection
group, and `slop ask`/`answer`/`questions` (elicitations, G4) joined the agent loop and inspection
groups respectively, bringing the current total to 26 — see
[`docs/cli-reference.md`](docs/cli-reference.md) for the full, up-to-date command reference.

## Installation

Slopwork needs **Bun ≥ 1.3 at runtime** no matter which install channel you use — the CLI is
Bun-native (`Bun.serve`, `Bun.file`, and text-imports throughout `src/`), so there is
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

## Documentation

The [`docs/`](docs/README.md) directory has the full user + operator documentation, verified
against the shipped CLI:

- [`docs/getting-started.md`](docs/getting-started.md) — install, `slop init`, a full walkthrough
- [`docs/concepts.md`](docs/concepts.md) — the data model, state machine, and derived overlays
- [`docs/cli-reference.md`](docs/cli-reference.md) — every command, every flag, exit codes
- [`docs/agent-workflow.md`](docs/agent-workflow.md) — the loop agents follow and the house rules
- [`docs/web-ui.md`](docs/web-ui.md) — what `slop web` shows
- [`docs/configuration.md`](docs/configuration.md) — `config.yaml`, actor/harness identity, env vars
- [`docs/concurrency-and-merging.md`](docs/concurrency-and-merging.md) — the git-merge story, the
  db lock, and lock-free progress updates
- [`docs/storage-backends.md`](docs/storage-backends.md) — the pluggable storage-backend
  interface, selecting flatfile vs. remote, and the remote wire contract
- [`docs/benchmarks.md`](docs/benchmarks.md) — measured scaling limits (1k → 100k tickets) and
  behavior under concurrent writers

[`CHANGELOG.md`](CHANGELOG.md) records what changed in each release, including the breaking
changes in the current unreleased line.

The same directory's [History & internals](docs/README.md#history--internals) section holds the
original spec, decision log, and implementation plan this doc set distills from — read those for
the *why* behind a design choice, the docs above for how to actually use the tool.

## Development

Requires [Bun](https://bun.sh) ≥ 1.3. Developed and tested on Linux and macOS; Windows is
best-effort (untested), with platform guards in place so it degrades gracefully rather than
crashing.

```sh
bun install            # install dependencies
bun run test           # run the test suite (vitest)
bun run test:web       # run frontend component tests (vitest + jsdom)
bun run test:browser   # run browser tests (requires Chromium below)
bun run lint            # lint src/ and tests/ (oxlint)
bun run format          # apply formatting (oxfmt, in place)
bun run format:check     # check formatting without writing
bun run typecheck        # tsc --noEmit (src/ + src/web/frontend/'s own tsconfig)
bun run build            # compile the standalone binary to dist/slop
bun run verify:package   # pack, install, and execute the npm tarball in a temp project
bun run check:required   # the complete CI/release gate
bun run start            # run the CLI from source (bun src/cli/index.ts ...)
```

`bun run build` produces a **standalone, dependency-free executable** at `dist/slop` via
`bun build --compile`. That's the binary the acceptance criteria and CI check — not
`bun src/cli/index.ts`. After building:

```sh
./dist/slop --help
```

CI (`.github/workflows/ci.yml`) runs `check:required` on every push and pull request: lint → format
check → typecheck → tests with coverage thresholds → build → compiled-binary smoke → installed
npm-tarball verification. The release workflow invokes the same script rather than maintaining a
second, weaker command list.

### Web UI development

`slop web` is a React + Tailwind v4 + shadcn/ui-style SPA (`src/web/frontend/`) served by the
same `Bun.serve` instance as its read-only JSON API (`src/web/api/`). The SPA is bundled at build
time — via `bun run build:web` (`scripts/build-frontend.ts`, a `bun-plugin-tailwind`-powered
`Bun.build()` call) — into `src/web/generated/{app.js,app.css}`, which `src/web/server.ts` embeds
into the binary the same way it always embedded static assets (Bun's `with { type: "text" }`
import). Nothing is fetched from a CDN at build *or* run time: Tailwind compiles locally, and the
one bundled webfont (JetBrains Mono, for identifiers/ids/code — see `src/web/frontend/index.css`)
is base64-inlined straight into the generated CSS.

```sh
bun run build:web        # one-shot: regenerate src/web/generated/{app.js,app.css}
bun run dev:web           # same, but rebuilds on every src/web/frontend/ change
bun run typecheck:web      # tsc --noEmit against src/web/frontend/tsconfig.json (DOM libs, react-jsx —
                            # deliberately separate from the root tsconfig's Bun-only setup)
bun run test:web           # component behavior under jsdom
bunx playwright install chromium  # one-time local browser install
bun run test:browser       # desktop/mobile flows against a real fixture server
```

`build:web` is also a `pretest`/`prebuild` hook (see `package.json`), so `bun run test` and
`bun run build` always run against freshly generated assets — `src/web/generated/` and
`src/web/frontend/fonts.generated.css` are build output, gitignored like `dist/`, never hand-edited.

For the actual dev loop: run `bun run dev:web` in one terminal (rebuilds the SPA on every save)
and `bun src/cli/index.ts web` in another. The server reads `src/web/generated/{app.js,app.css}`
once, at its own startup (the same static import that lets `bun build --compile` embed them into
the binary) — so after a frontend change, restart the `slop web` process to pick up the new
bundle; a backend (`src/web/api/`) change needs the same restart, same as any other CLI command.

## Lifecycle: `review` → `done` (C3)

Stored ticket states: `draft ⇄ open → in_progress → review → done`, plus a direct
`in_progress → done` edge (review is an **optional** checkpoint, not a required one) and `dropped`
(wontdo) from any non-terminal state (design.md §2). The three closing commands:

- **`slop review <ref> --mr <url>`** — `in_progress → review` only. `--mr` is
  required-*with-warning* (D15/§8.1 item 3): omit it and the command still succeeds, but nags on
  stderr; `ticket.review.mr` is left absent, not `null`. The session stays **active** across a
  review round-trip — `review` never sets
  `ended_at`. See `DECISIONS.md`'s C3 entries for the full session-model writeup.
- **`slop done <ref> [--note]`** — `review → done` **or** directly `in_progress → done`; review is
  optional, not required. Completing a non-`adhoc` ticket directly from `in_progress` (i.e. it
  never went through `review`) still succeeds, but nags on stderr suggesting `slop review --mr
  <url>` next time; `adhoc` tickets (D13) and the `review → done` path never nag. Either way,
  `done` finalizes the session (end summary from `--note`,
  `active_session` cleared) and runs B4's done-cascade exactly once, emitting `ticket.ready` for
  any dependent this ticket was blocking.
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
| 4    | `NOT_FOUND`       | A `<ref>` did not resolve to any entity, or no `.slop/` repo was found (see below). |
| 5    | `AMBIGUOUS_REF`   | A short-prefix or slug `<ref>` matched more than one entity.|
| 6    | `CONFLICT`        | Illegal state transition or other conflicting operation.    |

Code `3` is intentionally absent — it was `NOT_IMPLEMENTED`, reserved-but-unreachable scaffolding
no command ever threw, removed entirely rather than kept around. `4`/`5`/`6` keep their original
numbers (not renumbered down to fill the gap).

`NOT_FOUND` (4) also covers "not a slopwork repo" — every command that needs `.slop/` (including
`slop web`) discovers it via the shared `requireRepoRoot` walk-up (`src/repo/paths.ts`, the same
convention `git` uses for `.git/`) and throws exit 4 if none is found before the filesystem root,
never a bare `GENERIC_ERROR` (1).

Command implementations should throw a `SlopError` (`src/cli/errors.ts`) carrying one of these
codes rather than calling `process.exit()` directly; the top-level handler in `src/cli/index.ts`
converts it to the process exit code (and does the same for Commander's own usage errors, help,
and `--version`).

## Testing

- **Unit tests live beside the code as `*.test.ts`** (e.g. `src/core/exit-codes.test.ts`).
- **Acceptance tests live in `tests/acceptance/<ITEM-ID>.test.ts`** — one file per
  `docs/v0-implementation-plan.md` §3 work item (e.g. `A1.test.ts`, `A3.test.ts`, `B4.test.ts`). Each
  file's top-level `describe` is named `<ITEM-ID>: <item title>`, and a comment quotes that item's
  acceptance criterion verbatim from the plan. This convention is load-bearing — project
  verification greps for exactly one acceptance file per work item — so every new work item must
  land its `tests/acceptance/<ID>.test.ts` alongside its implementation.
- The test runner is **vitest** (`bun run test` → `vitest run`), which runs cleanly under Bun; no
  fallback to `bun test` was needed. See `vitest.config.ts`.
- **Frontend component tests** use their own jsdom config (`bun run test:web`) so DOM behavior is
  covered without weakening the root suite's Bun-only environment. **Browser tests** use
  Playwright (`bun run test:browser`) against `tests/fixtures/web-db`, with desktop/mobile layout,
  keyboard, retry, persistence, and screenshot checks. Install its browser once with
  `bunx playwright install chromium` (`--with-deps` is used by CI/release runners).
- **Sandboxing**: every test runs against an isolated `mkdtemp()` temp directory, never this repo's
  own root, and a `globalSetup` hook (`tests/support/repo-slop-guard.ts`) hashes this repo's own
  `.slop/` before and after the whole suite, failing the run loudly if anything touched it.
- **Coverage**: `bun run test:coverage` (`vitest run --coverage`, v8 provider) enforces the
  thresholds in `vitest.config.ts` — a global floor plus stricter per-directory floors for
  `src/core/`, `src/repo/`, `src/sessions/`, and `src/tickets/`; reports land in `coverage/`
  (gitignored). `src/cli/commands/**` reads as ~0% there on purpose — those are exercised via
  spawned-subprocess acceptance tests (see `tests/acceptance/`), which v8 can't instrument across a
  process boundary, not because they're untested.

## Source layout

```
src/
  cli/                 CLI entrypoint + one module per command
    index.ts            entrypoint: builds the Commander program, top-level exit-code mapping
    errors.ts            SlopError + reportError — shared error-reporting used by every command
    commands/
      index.ts            registers all 26 commands, grouped as in design.md §4.2 (plus G3's `list`, G4's `ask`/`answer`/`questions`)
      <command>.ts          one file per command (new.ts, start.ts, review.ts, ...)
      shared.ts             tiny option-parsing helpers (collect, parseIntegerOption)
  core/                 entity types, schemas, ids, serialization, exit codes
    exit-codes.ts         the exit-code table above
    index.ts               module re-exports; entity types/schemas/ULIDs/JSONC live here
  repo/                 the flatfile DRIVER's internals: atomic writes (tmp+rename),
                        `.slop/db/.lock`, ref resolution, the derived index, the event writer
                        (month-sharded, docs/storage-backends.md). Not imported outside
                        src/storage/ — commands and src/web/ go through the interface below.
    index.ts               re-exports the repo layer (atomic-write, db-index, events, refs,
                            sessions, tickets, ...); ticket/session CRUD is built on this
  storage/              the pluggable storage-backend interface (docs/storage-backends.md):
                        commands/web construct one via `openStorage(paths)` and never import
                        repo/ directly
    backend.ts              the StorageBackend interface + transaction model
    flatfile.ts              the default driver — repo/ wrapped behind the interface, plus an
                            in-process read cache
    remote.ts                 stub remote driver (every call fails with a clear "see
                            docs/storage-backends.md" error) selected via config.yaml's `backend:`
    open.ts                  `openStorage(paths)` — reads config.yaml, picks flatfile/remote
  tickets/              ticket-domain logic on top of storage/: state machine, done-cascade,
                        staleness, search, ancestry/tree, jira ref parsing
  sessions/             session lifecycle: harness/git capture, plan versioning + diff,
                        context pack, start/stop/finalize
  web/                  read-only local web explorer (`slop web`) — React SPA + JSON API
    index.ts               re-exports the HTTP server + data source; serves any real `.slop`
                            directory (not just fixtures) at http://localhost:4553 by default
    server.ts               Bun.serve wiring: Host-header allowlist, HEAD support, reusePort:false,
                            /api/* routes, static SPA-shell fallback for everything else
    data-source.ts           the WebDataSource seam; storage-data-source.ts is the real,
                            StorageBackend-backed impl; fixture-data-source.ts backs tests only
    api/                    read-only JSON API route handlers + the wire-contract types (types.ts)
    frontend/                the React + Tailwind v4 + shadcn/ui-style SPA source (own tsconfig —
                            see "Web UI development" above); bundled by scripts/build-frontend.ts
    generated/                build output (gitignored): app.js/app.css, embedded into dist/slop
tests/
  acceptance/            one file per work item — <ITEM-ID>.test.ts
```

## License

MIT — see `LICENSE`.
