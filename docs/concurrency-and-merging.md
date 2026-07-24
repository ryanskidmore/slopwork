# Concurrency & merging

Slopwork's target scenario is one engineer (or a small team) running two
or three agents on parallel branches against the *same* `.slop/db/`. This
doc explains the four mechanisms that make that safe: why the git merge
story works, the multi-file transaction lock, the lock-free path for
progress notes, and how `slop start`/`--takeover` handle two agents
wanting the same ticket.

## Why `.slop/db/` merges cleanly

```
.slop/db/
  tickets/ticket_<ulid>.jsonc
  sessions/session_<ulid>.jsonc
  events/event_<ulid>.jsonc
  index.jsonc      # derived, GITIGNORED
  .lock            # never committed
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

## The db lock: multi-file transactions

Single-file writes never need locking — an atomic rename already makes
any *one* file's write all-or-nothing. The lock at `.slop/db/.lock` exists
purely for operations that must change **more than one file as one
logical unit**: today, the done-cascade (closing a ticket, then updating
whichever dependents just became unblocked).

- **Acquisition** is exclusive file creation (`O_EXCL`) — atomic at the OS
  level, so it's never a check-then-create race between two processes.
  Retries with capped backoff for up to 5 seconds by default before
  giving up with a `CONFLICT` (exit `6`) naming what's blocking it.
- **Stale-lock recovery**: if the lock file already exists, it's
  breakable if its recorded pid is no longer alive, or it's older than a
  5-minute default staleness timeout — broken via an atomic rename-away,
  not a plain `rm` (which would be its own race between two contenders
  that both judge the same lock breakable). This is what stops one
  `kill -9` from bricking the repo permanently.
- **Fencing**: every acquisition mints a unique token recorded in the
  lock file. A holder doing multiple writes inside one lock acquisition
  calls `assertHeld()` between them, which re-checks its token is still
  current and — on success — **renews** the lock's timestamp. A holder
  that's merely slow (contended, I/O-stalled) and keeps checking in is
  never treated as dead just for running long; a holder that genuinely
  vanishes is still recoverable after the timeout. A dispossessed holder
  (its lock was declared stale and taken by someone else) fails loudly on
  its next `assertHeld()` rather than silently continuing to write.
- Release always runs in a `finally`, so a thrown error mid-transaction
  still releases the lock; release itself is a compare-and-delete against
  the holder's own token, not a blind delete.

You'll only ever see this surface as an occasional retry delay under real
contention, or a `CONFLICT` if something is genuinely stuck for minutes —
it's not something you configure or interact with directly.

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
`--priority`, `--label`, `--name`, `--spec`) is *not* lock-free — it takes
the ordinary locked read-modify-write path and rewrites the ticket file
directly, same as any other field change. Only the pure, no-other-flags
case gets the lock-free treatment.

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

## See also

- [Concepts → the flatfile database](concepts.md#the-flatfile-database)
  for the on-disk layout these mechanisms operate on.
- [Configuration](configuration.md#actor--harness-identity-d17) for how
  an actor's identity is resolved — the audit trail every event above
  carries.
