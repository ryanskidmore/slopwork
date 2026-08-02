# Benchmarks — where slopwork's flatfile store stops being fast

Slopwork stores every ticket, session, and event as its own JSONC file under
`.slop/db/`, with a derived `index.jsonc` on top. That design buys the things
[Concurrency & merging](concurrency-and-merging.md) describes — git-mergeable
history, no daemon, no schema migrations — and it has to cost something
somewhere. This page measures where.

**Short answer:** comfortable to ~10,000 tickets, and usable but no longer
pleasant at ~100,000 — `slop show`/`slop search` cross into tens-of-seconds
territory there once the event log is realistically sized (see the
methodology note below for why that changed). Nothing corrupts at any scale;
the failure mode under overload is a clean refusal, not damage. Since the
stated design target is one engineer running 2–3 agents (§2 of the [design
spec](design.md)) — hundreds to low thousands of tickets — the practical
ceiling still sits comfortably above the target, just closer to it than the
previous version of this page suggested.

## Methodology note (G5, t-ukxun)

This page's numbers were regenerated for three reasons, all part of the same
simplification-sweep audit:

1. **Realistic event ratio.** The harness used to seed 2 events per ticket
   (capped at 200,000 total) — a number nobody had actually measured against
   anything. This repo's own dogfood `.slop/db/` runs close to **9 events per
   ticket** (progress notes, state changes, plan revisions, review requests,
   and now `ask`/`answer` events, all accumulating over a real ticket
   lifecycle), so the harness now seeds at that ratio, uncapped. This matters
   more than it sounds: `slop show`/`slop search` both scan the *entire*
   event log unconditionally (`show` to fold a ticket's effective
   `latest_note` and progress history; `search` to scan every progress note
   ever written), so their cost is driven by total event count, not just
   ticket count. The 2:1 ratio was quietly understating exactly this cost —
   see "What changed most" below.
2. **Real event storage layout.** Seeded events now land in their real
   `events/<YYYY-MM>/` shard (the G2 physical layout), not a flat directory
   the shipped code never actually produces — see `bench/seed.ts`.
3. **The 1,000,000-ticket rung is gone.** It measured a scale one to two
   orders of magnitude past where slopwork is designed to run, at real cost
   (tens of minutes to seed, gigabytes of fixture disk) — a number this page
   already told readers not to live at. Dropped rather than kept as
   scaffolding nobody should run. If it's ever needed again, `bench/run.ts`
   and `bench/seed.ts` still support arbitrary `--scales`; only the
   convenience of a pre-generated, checked-in result is gone.

## How to reproduce

```sh
bun run build                                    # the CLI timings drive dist/slop
bun bench/run.ts --scales 1000,10000,100000 --workers 64 --out bench/results-ladder.json
```

The harness (`bench/`) seeds a database by writing entity files directly, then
measures the real code paths. Two deliberate guards, because both are easy ways
to publish a flattering lie:

- It **verifies a seeded ticket against the real `ticketSchema`**, so a seeding
  bug cannot masquerade as speed.
- It **refuses to present tmpfs numbers as real** — it prints a loud warning if
  the fixture directory is RAM-backed. (`/tmp` is tmpfs on many Linux setups,
  including this machine. All numbers below are from ext4 on a real disk.)

Seeding cost is reported but never counted as an operation: it bypasses the CLI
on purpose, so it measures fixture construction, not slopwork.

**Machine:** 32× AMD Ryzen 9 9950X3D, 30 GB RAM, ext4, Bun 1.3.11, Linux
(WSL2). Medians of 3–5 runs, one run each at 1k/10k/100k on this machine on
2026-08-02.

## Scaling: everything is linear, and the event log is now visibly the cost

In-process engine timings — no process-startup floor underneath them:

| Operation | 1k | 10k | 100k |
|---|---:|---:|---:|
| Index: cold build (no `index.jsonc`) | 164 ms | 2.03 s | 20.6 s |
| Index: warm load (fingerprint + parse) | 21 ms | 200 ms | 2.21 s |
| Resolve ref by slug | 21 ms | 216 ms | 2.36 s |
| Resolve ref by id prefix† | 0.13 ms | 0.13 ms | 0.19 ms |
| Parse + validate every ticket (`listTicketsTolerant`) | 16 ms | 152 ms | 1.74 s |
| `index.jsonc` size | 0.75 MiB | 7.6 MiB | 75.7 MiB |
| `.slop/` on disk | 4.6 MiB | 46.1 MiB | 462 MiB |

† In this harness's fixtures, `shortestUniquePrefix` (bulk-seeded ids minted
in one tight burst share almost their whole ULID) always comes out to the
full id length at every scale here — see "An artifact worth knowing about"
below — so this row is effectively measuring the fast, O(1) full-id path
(`ref` matches `ticket_<ULID>` exactly, no index scan at all), not a genuine
partial-prefix row scan.

End-to-end CLI latency (spawns `dist/slop`, so it includes a startup floor
that dominates at small scales):

| Command | 1k | 10k | 100k |
|---|---:|---:|---:|
| `slop status` | 110 ms | 379 ms | 2.59 s |
| `slop ready --json` | 105 ms | 421 ms | 3.03 s |
| `slop show <slug>` | 305 ms | 1.85 s | 20.5 s |
| `slop search` | 293 ms | 2.00 s | 23.1 s |
| `slop new` (write path) | 352 ms | 2.43 s | 27.6 s |

### What changed most: `show`/`search` at the realistic event ratio

**This is the headline finding the ratio fix surfaces.** At the old 2:1
ratio (capped 200k events total), `slop show`/`slop search` at 100k tickets
measured ~3.5 s / ~4.5 s. At the realistic 9:1 ratio (900k events, no cap),
the same two commands measure **20.5 s / 23.1 s** — a ~6× jump driven
entirely by event count, not ticket count. Both commands scan the *entire*
event log unconditionally: `show <ref>` folds every event for the ticket
into its effective `latest_note`/progress history (`queryEvents({ticket})`,
no `limit`, reads and parses every event file before filtering); `search`
scans every progress note ever written, across every ticket, to build its
searchable text (`listEvents()`, module doc: "a naive scan"). Neither has an
early exit. The 2:1-ratio benchmark was, in effect, quietly hiding the
dominant real-world cost of these two commands — this is exactly why the
audit called the old ratio out as unrepresentative.

### What these numbers mean more generally

**The warm index load is a real floor, and every read pays it.** Before
serving a cached index, `loadIndex` re-derives a content fingerprint — a
`readdir` plus a `stat` per ticket file — and then parses `index.jsonc`.
Both are O(n) in ticket count. That's 2.2 s at 100k just to confirm the
cached index is still valid, before a command has done anything else.

**`index.jsonc` growing to 75.7 MiB at 100k is a real cost, not yet an
alarming one.** It's a single JSON document read and parsed in full, in
memory, on every command. Bun parses it without difficulty at this size;
this is the thing that would eventually need sharding (or a real embedded
store — [F8](design.md#6-feature-menu)) at a much larger scale than this
page measures.

**Cold rebuild is roughly linear** (10× the tickets from 10k → 100k costs
~10× the time, 2.0 s → 20.6 s) — a fresh clone of a 100k-ticket repo pays
~20 s once, dominated by reading and validating every ticket and event file
on disk.

**Where the knee is.** At 10k, everything CLI-facing is under 2.5 s. At
100k, `status`/`ready` (2.6 s / 3.0 s) are tolerable but no longer snappy,
while `show`/`search`/`new` — the commands that touch the full event log —
cross into tens of seconds, per the ratio finding above. Past that it
degrades smoothly (linearly in event count) rather than cliff-edging.

## Concurrency: the lock-free path is real, and the lock is the limiter

The design splits writes deliberately: a bare `slop update --progress` appends an
event and never takes the database lock, while everything that mutates a ticket
file serializes through `.slop/db/.lock`. The measurements confirm both halves.

| Phase (2,000-ticket db, fixed) | Workers | Wall time | Succeeded | Refused (exit 6) | Corrupted |
|---|---:|---:|---:|---:|---:|
| `update --progress` (lock-free) | 64 | 1.29 s | **64 / 64** | 0 | 0 |
| `new` (takes the lock) | 64 | 5.60 s | 15 / 64 | 49 | 0 |
| `start` on **one** ticket (race) | 64 | — | **1 winner** | 63 | 0 |

**The lock-free claim survives contact.** 64 concurrent progress writers, zero
failures, zero contention — each mints its own ULID-named event file, so there is
nothing to serialize on. This is the path agents use most while working, and it
genuinely does not care how many of them there are.

**Concurrent ticket *mutations* top out around a few dozen at once.** The
lock has a 5-second acquisition timeout; 15 of 64 concurrent `slop new`
calls succeed against this fixture, because each holder spends time inside
the lock and the queue behind it exceeds 5 s. The refused writers exit
**6 (CONFLICT)** with `timed out waiting for the db lock ... (held by pid N,
held since ...)`.

**This is graceful degradation, not breakage — which is the part that matters.**
Every refusal was a clean exit-6 timeout: no partial writes, no corrupted files,
no index damage, and never a wrong winner. The `start` race is exactly-one-winner
at 64-way contention. An agent that hits this can simply retry; nothing needs
repair.

If you are driving dozens of simultaneous ticket-creating writers, batch them or
retry on exit 6 — but note that this is far outside the "2–3 agents" the tool is
built for, where lock contention never appears at all.

## An artifact worth knowing about: short refs and creation *rate*

`shortestUniquePrefix` in the harness reports how short a ref could be before
`AMBIGUOUS_REF`. In these fixtures the answer was always "the whole id" at
every scale (1k/10k/100k) — because seeding mints tickets in one tight burst,
and the monotonic ULID factory holds the timestamp and randomness fixed
within a millisecond, then increments only the low bits. Tickets created in
one burst therefore share nearly their entire prefix.

This is mostly a seeding artifact — real tickets are created seconds or
minutes apart and diverge almost immediately — but it is a real property of
bursts: `slop split` creating several sub-tickets at once, or a bulk import,
will produce ids that need long prefixes to disambiguate. Slugs and
`t-<code>` handles are unaffected, and both remain the ergonomic way to
refer to work.

## What would have to change to go further

In rough order of value, if a repo ever genuinely needed to live at 10⁵ tickets
with a realistically-sized event log:

1. **Give `show`/`search` a way to not scan the whole event log.** Both are
   currently a naive, unconditional full scan (module docs call this out
   explicitly as the v0 scope) — a per-ticket or per-shard event index would
   remove the now-dominant cost this page's ratio fix surfaced.
2. **Make reads not pay for the whole database.** The fingerprint scan and the
   monolithic `index.jsonc` parse are both O(n) on every command. Sharding the
   index, or keeping a small header that lets a read skip the full parse, removes
   the next-largest cost for `status`/`ready`.
3. **Make the lock timeout configurable** (and document retry-on-6), so heavy
   fleets can trade latency for throughput instead of being refused.
4. **A real embedded store behind the existing repo interface** — the
   [F8](design.md#6-feature-menu) shared-mode work — which is the honest answer
   past a few hundred thousand tickets.

None of these are v0 work. The measured ceiling is comfortably above the
scale slopwork was designed for, and the failure behavior at the ceiling is
clean.
