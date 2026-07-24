# Benchmarks — where slopwork's flatfile store stops being fast

Slopwork stores every ticket, session, and event as its own JSONC file under
`.slop/db/`, with a derived `index.jsonc` on top. That design buys the things
[Concurrency & merging](concurrency-and-merging.md) describes — git-mergeable
history, no daemon, no schema migrations — and it has to cost something
somewhere. This page measures where.

**Short answer:** comfortable to ~10,000 tickets, usable to ~100,000, and it
does not fall over at 1,000,000 — it just gets slow enough that you would not
want to live there. Nothing corrupts at any scale; the failure mode under
overload is a clean refusal, not damage. Since the stated design target is one
engineer running 2–3 agents (§2 of the [design spec](design.md)) — hundreds to
low thousands of tickets — the practical ceiling sits one to two orders of
magnitude above the target.

## How to reproduce

```sh
bun run build                                    # the CLI timings drive dist/slop
bun bench/run.ts --scales 1000,10000,100000 --workers 64 --out bench/results-ladder.json
bun bench/run.ts --scales 1000000 --events 200000 --workers 32 --skip-subprocess --out bench/results-1m.json
```

The harness (`bench/`) seeds a database by writing entity files directly, then
measures the real code paths. Two deliberate guards, because both are easy ways
to publish a flattering lie:

- It **verifies a seeded ticket against the real `ticketSchema`**, so a seeding
  bug cannot masquerade as speed.
- It **refuses to present tmpfs numbers as real** — it prints a loud warning if
  the fixture directory is RAM-backed. (`/tmp` is tmpfs on many Linux setups,
  including this machine. All numbers below are from ext4 on an NVMe SSD.)

Seeding cost is reported but never counted as an operation: it bypasses the CLI
on purpose, so it measures fixture construction, not slopwork.

**Machine:** 32× AMD Ryzen 9 9950X3D, 30 GB RAM, ext4, Bun 1.3.11, Linux.
Medians of 3–5 runs. The machine was not perfectly idle (an unrelated agent was
active), which mostly affects the end-to-end CLI numbers; the engine timings are
stable across runs.

## Scaling: everything is linear, and the index is the cost

In-process engine timings — no process-startup floor underneath them:

| Operation | 1k | 10k | 100k | 1M |
|---|---:|---:|---:|---:|
| Index: cold build (no `index.jsonc`) | 48 ms | 441 ms | 4.8 s | 31.2 s |
| Index: warm load (fingerprint + parse) | 14 ms | 122 ms | 1.35 s | 13.2 s |
| Resolve ref by slug | 14 ms | 123 ms | 1.30 s | 14.1 s |
| Resolve ref by **full id** | 0.15 ms | 0.14 ms | 0.17 ms | **0.25 ms** |
| Parse + validate every ticket | 16 ms | 154 ms | 1.52 s | 17.5 s |
| `index.jsonc` size | 0.6 MiB | 6.4 MiB | 64 MiB | **624 MiB** |
| `.slop/` on disk | 2.2 MiB | 22 MiB | 224 MiB | 1.6 GiB |

End-to-end CLI latency (spawns `dist/slop`, so it includes a ~70 ms startup
floor that dominates at small scales):

| Command | 1k | 10k | 100k |
|---|---:|---:|---:|
| `slop status` | 85 ms | 246 ms | 1.54 s |
| `slop ready --json` | 88 ms | 283 ms | 1.97 s |
| `slop show <slug>` | 111 ms | 431 ms | 3.49 s |
| `slop search` | 122 ms | 538 ms | 4.51 s |
| `slop new` (write path) | 203 ms | 916 ms | 8.68 s |

### What these numbers mean

**The warm index load is the ceiling, and every read pays it.** Before serving a
cached index, `loadIndex` re-derives a content fingerprint — a `readdir` plus a
`stat` per ticket file — and then parses `index.jsonc`. Both are O(n), so *every*
`status`, `ready`, `show`, and `search` carries the whole database's weight even
when it needs one row. That is the 13.2 s at 1M, and it is why `slop status`
cannot be fast there no matter what else improves.

**`index.jsonc` growing to 624 MiB at 1M is the more alarming half.** It is a
single JSON document that must be read and parsed in full, in memory, on every
command. It survived — Bun parsed it without exhausting 30 GB — but this is the
first thing that would need to change (sharding, or a real embedded store, which
is what [F8](design.md#6-feature-menu) contemplates) before anyone should run at
this size.

**Full ids stay O(1) at every scale — 0.25 ms at a million tickets.** A ref that
is already a complete `ticket_<ULID>` skips index resolution entirely and reads
one file by name. This is the one operation that does not care how big the
database is, and it is worth knowing: scripts and agents that carry full ids
around are immune to everything else on this page.

**Cold rebuild is sublinear-ish and cheaper than you would guess** (10× the
tickets from 100k → 1M costs only ~6.5×, since the per-file reads parallelize).
A fresh clone of a 100k-ticket repo pays ~5 s once. That is fine.

**Where the knee is.** At 10k, everything is under a third of a second and feels
instant. At 100k, `status` at 1.5 s is tolerable but no longer pleasant, and
`slop new` at 8.7 s is genuinely annoying — the write path invalidates the index,
so the next read rebuilds it. Past that it degrades smoothly rather than
cliff-edging.

## Concurrency: the lock-free path is real, and the lock is the limiter

The design splits writes deliberately: a bare `slop update --progress` appends an
event and never takes the database lock, while everything that mutates a ticket
file serializes through `.slop/db/.lock`. The measurements confirm both halves.

| Phase (100k-ticket db) | Workers | Wall time | Succeeded | Refused (exit 6) | Corrupted |
|---|---:|---:|---:|---:|---:|
| `update --progress` (lock-free) | 64 | 1.11 s | **64 / 64** | 0 | 0 |
| `new` (takes the lock) | 64 | 5.55 s | 14 / 64 | 50 | 0 |
| `start` on **one** ticket (race) | 64 | — | **1 winner** | 63 | 0 |

At 1M with 32 workers the pattern holds: lock-free 32/32 in 664 ms; `new`
14/32 with 18 refusals; the start race still exactly 1 winner, 31 clean
refusals.

**The lock-free claim survives contact.** 64 concurrent progress writers, zero
failures, zero contention — each mints its own ULID-named event file, so there is
nothing to serialize on. This is the path agents use most while working, and it
genuinely does not care how many of them there are.

**Concurrent ticket *mutations* top out around a few dozen, and the ceiling drops
as the database grows.** The lock has a 5-second acquisition timeout. On an empty
repo, 55 of 64 concurrent `slop new` calls succeed; at 100k tickets only 14 do,
because each holder now spends longer inside the lock and the queue behind it
exceeds 5 s. The refused writers exit **6 (CONFLICT)** with
`timed out waiting for the db lock ... (held by pid N, held since ...)`.

**This is graceful degradation, not breakage — which is the part that matters.**
Across every run at every scale, refusals were *always* clean exit-6 timeouts:
no partial writes, no corrupted files, no index damage, and never a wrong
winner. The `start` race is exactly-one-winner at 64-way contention, every time.
An agent that hits this can simply retry; nothing needs repair.

If you are driving dozens of simultaneous ticket-creating writers, batch them or
retry on exit 6 — but note that this is far outside the "2–3 agents" the tool is
built for, where lock contention never appears at all.

## An artifact worth knowing about: short refs and creation *rate*

`shortestUniquePrefix` in the harness reports how short a ref could be before
`AMBIGUOUS_REF`. In these fixtures the answer was always "the whole id" — because
seeding mints a million ULIDs in the same few milliseconds, and the monotonic
factory holds the timestamp and randomness fixed within a millisecond, then
increments only the low bits. Tickets created in one burst therefore share nearly
their entire prefix.

This is mostly a seeding artifact — real tickets are created seconds or minutes
apart and diverge almost immediately — but it is a real property of bursts:
`slop split` creating ten sub-tickets at once, or a bulk import, will produce ids
that need long prefixes to disambiguate. Slugs and `t-<code>` handles are
unaffected, and both remain the ergonomic way to refer to work.

## What would have to change to go further

In rough order of value, if a repo ever genuinely needed to live at 10⁵–10⁶:

1. **Make reads not pay for the whole database.** The fingerprint scan and the
   monolithic `index.jsonc` parse are both O(n) on every command. Sharding the
   index, or keeping a small header that lets a read skip the full parse, removes
   the dominant cost for `show`/`ready`/`status`.
2. **Stop rebuilding the world after a write.** `slop new` at 8.7 s on 100k is
   almost entirely index invalidation; an incremental index update would make
   writes O(1)-ish.
3. **Make the lock timeout configurable** (and document retry-on-6), so heavy
   fleets can trade latency for throughput instead of being refused.
4. **A real embedded store behind the existing repo interface** — the
   [F8](design.md#6-feature-menu) shared-mode work — which is the honest answer
   past a few hundred thousand tickets.

None of these are v0 work. The measured ceiling is comfortably above the
scale slopwork was designed for, and the failure behavior at the ceiling is
clean.
