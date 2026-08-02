# Concurrency & merging

Slopwork's target scenario is one engineer (or a small team) running two
or three agents on parallel branches against the *same* `.slop/db/`. This
doc explains the mechanisms that make that safe: why the git merge story
works, how entity/event pairs recover after a crash, the write-path lock
that serializes every mutating command, the lock-free path for progress
notes, and how `slop start`/`--takeover` handle two agents wanting the
same ticket.

## Why `.slop/db/` merges cleanly

```
.slop/db/
  tickets/ticket_<ulid>.jsonc
  sessions/session_<ulid>.jsonc
  events/event_<ulid>.jsonc
  mutation-journal/event_<ulid>.jsonc  # pending only, GITIGNORED
  event-cursors/cursor_v1_<hex>.jsonc  # polling state, GITIGNORED
  index.jsonc      # derived, GITIGNORED
  .lock            # never committed
  .event-cursors.lock # never committed
```

Four properties combine to make this git-mergeable across branches with
essentially no manual conflict surgery:

1. **ULID filenames make create-conflicts impossible.** Every ticket,
   session, and event is minted a globally unique, monotonically-ordered
   ULID at creation (`src/core/ids.ts` — all three id kinds share one
   monotonic sequence, so even ids minted in the same millisecond stay
   strictly ordered). Two agents on two branches creating two different
   tickets always produce two different filenames — there is no shared
   counter, no "next id" to race over, and so no way for git to see a
   file *added* on both sides at the same path with different content.

2. **Events are immutable and append-only.** `events/` files are written
   once and never updated or deleted (`src/repo/events.ts`). An event
   file can never conflict on merge for the same reason two independent
   commits adding two different files never conflict — there is nothing
   to reconcile.

3. **The index doesn't exist in git.** `index.jsonc` — the one file that
   *would* conflict on almost every merge, since it's rebuilt from
   everything — is gitignored (D14) and purely derivative. It's never
   merged because it's never committed. See
   [Self-healing after a merge](#self-healing-after-a-merge) for what
   makes this safe rather than just convenient.

4. **Same-ticket edits are small, ordinary JSONC diffs.** Two agents
   editing *different* tickets never touch the same file at all. Two
   agents editing the *same* ticket concurrently (rare, but possible)
   produce a normal small-file merge conflict a human resolves the usual
   way — no different from any other structured text file.

Atomic writes (temp file + rename, `src/repo/atomic-write.ts`) mean a
process crash mid-write never leaves a half-written entity file on disk
either — a reader always sees the old content or the new content, never a
torn write.

## Polling after merges

Event ULIDs define a useful deterministic order, but they are not a safe
distributed high-water mark. Clone B can author an event with an older clock,
or simply before clone A's latest event, and merge it only after clone A has
advanced a scalar `--since` cursor. That event then sorts before the cursor
and is permanently invisible to scalar polling.

`slop events --poll` solves this with an opaque, versioned checkpoint backed
by the exact IDs returned to that consumer. Every call scans the merged event
set for IDs absent from the checkpoint, applies filters and limits, renders
the page, then atomically unions only the IDs that were actually returned.
This makes late origins, clock rollback, same-millisecond independent writers,
empty polls, and limited pages no-miss cases. `--since` remains available only
for static-snapshot compatibility and prints a warning.

The flatfile checkpoint lives under gitignored `event-cursors/`, so tokens are
local to that clone; a remote backend owns the equivalent server-side state.
The token is constant-size, while exact state grows with consumed history, the
deliberate storage cost of supporting arbitrary legacy IDs without origin or
sequence metadata. Delete retired cursors. Delivery is at-least-once: a crash
between presenting a page and advancing state, or simultaneous reads using
one token, may repeat an ID. Atomic union prevents lost checkpoint state, and
consumers should deduplicate by event ID and use one token per logical worker.

## Crash recovery for entity + event pairs

Atomic rename protects one file, but a normal ticket or session mutation
changes an entity file **and** appends the audit event that describes it.
Those two renames cannot be one filesystem operation. The flatfile driver
therefore uses a small write-ahead journal under
`.slop/db/mutation-journal/` for every `createTicket`, `updateTicket`,
`createSession`, and `updateSession` call:

1. Pre-mint the event id and durably write one ignored journal file. It
   records the validated entity identity, operation (`create`, `update`,
   or `delete`), the exact before/after entity text, and the complete
   event.
2. Atomically apply the entity's after state.
3. Atomically write that same pre-minted event.
4. Durably remove the journal only after both files are present.

If the process dies between any two steps, opening the flatfile backend
or entering the next write transaction replays pending journals under the
normal db lock. Replay is compare-and-apply: an entity matching the
recorded before state is advanced; one already matching the after state
is accepted; the event is created only if absent and accepted only if its
content exactly matches. Replaying the same intent repeatedly therefore
does not duplicate or replace the event.

Recovery deliberately fails closed. A corrupt journal, a target matching
neither recorded state, or an existing event id with different content
stops the open/transaction with an actionable error and leaves the
journal and conflicting data untouched. Back up the repo and inspect all
three files before resolving such a conflict; deleting the journal alone
can discard the only durable evidence of an incomplete audit write.

The journal is local coordination state, like `.lock` and `index.jsonc`,
so `slop init` always gitignores it. It guarantees roll-forward of each
entity/event pair, **not rollback of an entire multi-entity command**. A
crash halfway through a cascade can still leave earlier logical mutations
committed and later ones unstarted; every pair that did start is either
complete already or recoverable. Pure `update --progress` writes only an
event and consequently needs no paired journal.

## Self-healing after a merge

`index.jsonc` is a pure function of the entity files on disk, so it's
always safe to throw away and rebuild — and the CLI does exactly that
transparently. `loadIndex()` (`src/repo/db-index.ts`) computes a cheap
**content fingerprint** (a hash over every tracked file's name, mtime, and
size — no file content is read to compute it) and rebuilds whenever the
recorded fingerprint doesn't match what's actually on disk: missing index,
unparseable index, a schema-version bump, or — the case that matters
here — a `git pull`/`git merge`/`git checkout` that changed ticket files
out from under a stale index. You never need to remember to run
`slop reindex` after a merge; the next `slop` command that reads the index
rebuilds it itself. `slop reindex` remains the explicit manual escape
hatch (e.g. to force-surface every unreadable ticket file in one pass).

## The db lock: serializing the write path

Single-file writes never need locking — an atomic rename already makes
any *one* file's write all-or-nothing. But `.slop/db/.lock` isn't scoped
to multi-file operations alone: it serializes the **whole write path** —
every one of the 14 mutating commands (`new`, `update` with any real
field, `edit`, `draft`, `undraft`, `start`, `stop`, `review`, `done`,
`drop`, `plan`, `split`, `reindex --heal`, `answer` — the last closing the
race between two concurrent answers to the same question) takes it around
its read-modify-write, both for genuine multi-file units (the
done-cascade, a reparent) AND to keep a plain single-ticket
read-modify-write from clobbering a concurrent writer's change. Two
mutating operations skip it, both lock-free pure event appends needing no
read-modify-write of the ticket file itself: `update --progress` (below)
and `ask` (src/cli/commands/ask.ts). Through the [storage-backend
interface](storage-backends.md), this is
`StorageBackend.transact(fn)` — the flatfile driver implements it as the
lock acquisition described here; a remote backend implements the
equivalent exclusivity server-side (see
[storage-backends.md → Transactions](storage-backends.md#transactions)).

- **Acquisition** is exclusive file creation (`O_EXCL`) — atomic at the OS
  level, so it's never a check-then-create race between two processes.
  Every acquisition records `{pid, acquired_at, token}` — `token` is a
  fresh random value, unique even across successive acquisitions by the
  same pid (t-cloj2 follow-up, "make acquisition and release token-safe";
  see below). Retries with capped backoff until the configured timeout
  elapses (`5s` by default — configurable per repo via `config.yaml`'s
  `defaults.lock_timeout`, see
  [Configuration](configuration.md#slopconfigyaml)) before giving up
  with a `CONFLICT` (exit `6`) naming what's blocking it.
- **Stale-lock recovery**: if the lock file already exists, it's
  breakable if its recorded pid is no longer alive, or it's older than a
  5-minute staleness timeout (also covers pid reuse after a crash) — an
  unparseable lock file is breakable the same way, judged by its file
  mtime instead. Breaking is an atomic rename-away plus a
  verify-by-content-match, not a plain `rm` (which would itself be a race
  between two contenders that both judge the same lock breakable, one of
  which could otherwise delete the other's fresh, already-reacquired
  lock). This is what stops one `kill -9` from bricking the repo
  permanently.
- **Release** always runs in a `finally`, so a thrown error mid-transaction
  still releases the lock; release itself is the SAME rename-away
  -then-verify shape as stale-breaking above (t-cloj2 follow-up), keyed
  on the acquisition's `token` rather than a blind `rm`. A `pid`-only
  compare-then-delete (the pre-follow-up shape) is a distinct TOCTOU: if
  this process's own release call is running late — because it stalled
  long enough for someone else to legitimately declare its lock stale,
  break it, and reacquire — a same-pid reacquisition reads as "still
  mine" under a `pid`-only check, so a plain `rm` would delete the *new*
  rightful holder's lock instead of this process's own (already-gone)
  one. `token` distinguishes the two acquisitions where `pid` alone
  can't; renaming away and re-verifying before discarding — restoring it
  untouched otherwise — closes the gap the same way it's already closed
  for breaking.

There is no per-acquisition fencing token that a holder checks back in
between writes, no mid-transaction renewal, and no dispossession
callback — an earlier design had all three (a holder doing multiple
writes checked back in between each one, and a dispossessed holder failed
loudly on its next check), removed because no real transaction in this
codebase runs anywhere near the 5-minute stale timeout (every one is a
handful of millisecond-scale file writes); the accepted trade-off is that
a holder that genuinely runs that long could have its lock broken while
still alive, with nothing to detect the overlap. The token this doc
describes above is narrower and purely about release/break safety
(telling two acquisitions apart), not that removed fencing protocol. If a
future transaction ever needs to run long, that transaction needs
redesigning, not this lock re-complicating.

You'll only ever see this surface as an occasional retry delay under real
contention, or a `CONFLICT` if something is genuinely stuck for the
configured timeout — it's not something you interact with directly, only
(optionally) configure.

## Lock-free progress updates

`slop update <ref> --progress "…"` with **no other flag** — the single
most frequent write an agent makes while working a ticket — takes **no
lock at all** and never rewrites the ticket file:

```sh
slop update <ref> --progress "token model done, writing email send next"
```

It appends one `ticket.updated` event (payload: `{progress: "…"}`) and
returns. Since every event gets its own ULID filename, any number of
agents can do this against the *same* ticket at the *same* instant with
**zero write contention** — there's nothing to serialize, because nothing
is read-modify-written.

The catch: this means the ticket *file's* own `latest_note`/
`last_activity_at` fields can lag behind reality — exactly the same way
`index.jsonc` itself can lag a `git pull`. The fix is the same shape as
the index's own self-healing: `latest_note`/`last_activity_at` are
**effective, not stored-verbatim** values. Every read path (`slop show`,
`slop status`, `slop ready`, `slop web`, staleness computation) folds the
ticket's stored baseline together with every `progress`-carrying event for
it, keeping whichever is more recent (`deriveEffectiveOverlay` in
`src/repo/db-index.ts`, mirrored for the web UI in `src/web/overlays.ts`).
A stale-detection deadline is computed against this effective value too,
so a lock-free progress note un-stales an `in_progress` ticket exactly
like a locked update always did.

**A `--progress` call combined with any other flag** (`--state`,
`--priority`, `--label`, `--name`, `--spec`, `--summary`, `--details`,
`--acceptance`, `--context`) is *not* lock-free — it takes the ordinary
locked read-modify-write path and rewrites the ticket file directly, same
as any other field change. Only the pure, no-other-flags case gets the
lock-free treatment.

## The parallel-agents model

There are no leases or claims separate from a session. Starting a ticket
*is* claiming it:

- `slop start <ref>` under lock re-reads the ticket, checks
  `active_session`, and either proceeds (nothing active) or refuses with
  a `CONFLICT` (exit `6`) naming the active session — unless `--takeover`
  is passed, in which case it proceeds and logs a `session.takeover`
  event naming the previous actor. Two concurrent `start`s on the same
  ticket race for the lock; the loser sees a normal, honest conflict
  error, never a silently-clobbered write.
- `slop ready` already excludes any ticket with an active session, so the
  common case (two agents both asking "what's next") naturally steers
  them apart without either one needing to know about the other.
- Re-entering a `review`-state ticket via `slop start` (changes
  requested) is **not** a takeover — it's expected, logged with
  `re_entry: true`, and needs no `--takeover` flag, since it's the same
  agent's own ticket continuing, not seizing someone else's active work.
- `slop status`/`slop web` show every active session, its actor, and its
  harness, so a human can see at a glance who is working what across all
  running agents.

## Known cross-clone limitations (G5, t-drz1d)

Everything above is true and load-bearing, but it describes what's
*handled*. Three cross-clone scenarios are worth being honest about
rather than implying the merge story above covers everything:

- **Same-slug creation on two clones is now detected and healable.**
  Two clones creating a ticket with the same auto-generated or explicit
  slug at the same time both write successfully (different ULID
  filenames, property 1 above) — but the two files then collide on
  `slug`. `slop reindex` (with or without `--heal`) detects this loudly
  on stderr, and `slop reindex --heal` repairs it deterministically (the
  older ticket, by id, keeps the bare slug; younger duplicates get
  git-style `-2`/`-3` suffixes) — see [`reindex`](cli-reference.md#reindex)
  and [Concepts → slug uniqueness](concepts.md#slug-uniqueness). Handled,
  not a gap.
- **`active_session` double-claims across clones are unhandled.** Two
  clones can both `slop start` the same ticket before either one's
  branch is merged into the other — each clone's own lock only serializes
  writers *within that clone*, not across clones that haven't seen each
  other's commits yet. Whichever ticket file merges in last silently wins
  the `active_session` field; `ready`/`status` on either clone confidently
  report whatever that file says, with no indication a second, now-hidden
  session also claims to be active. There is no detection today — tracked
  as ticket `t-621mr` ("Cross-clone active_session honesty"): detect the
  double-claim on merge (as an index problem + warning) and define
  resolution semantics, mirroring how same-slug creation is already
  handled above.
- **Unconditional `updated_at` merge conflicts are accepted v0 behavior,
  not a bug.** Two clones editing *different* fields of the *same* ticket
  still conflict on merge — every write bumps `updated_at`, always the
  ticket file's last line, so that line collides even when the clones'
  real edits don't overlap at all. This is a deliberate, documented
  trade-off (DECISIONS.md's "Fix 5"), not silent data loss: git surfaces
  a normal one-hunk conflict a human resolves same as any other
  same-ticket edit, both clones' real changes are visible in the conflict
  markers, and nothing is dropped. The principled fix — deriving
  `updated_at` from the immutable event log instead of stamping it on
  every write, so this bookkeeping field stops colliding too — is tracked
  as ticket `t-687rg` ("Derive updated_at from the event log").

## See also

- [Concepts → the flatfile database](concepts.md#the-flatfile-database)
  for the on-disk layout these mechanisms operate on.
- [Configuration](configuration.md#actor--harness-identity-d17) for how
  an actor's identity is resolved — the audit trail every event above
  carries.
- [Storage backends](storage-backends.md) for how this lock generalizes
  to `StorageBackend.transact` and a remote backend's server-side lease.
