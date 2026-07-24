import { type SpawnSyncReturns, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type Ticket,
  type TicketId,
  newTicketId,
  parseJsonc,
  ticketSchema,
} from "../../src/core/index.js";
import type { EventContext, MutationEventSpec } from "../../src/repo/events.js";
import { ensureDbDirs } from "../../src/repo/paths.js";
import type { RepoPaths } from "../../src/repo/paths.js";
import { createTicket } from "../../src/repo/tickets.js";
import {
  EDGE_DEGREE_CAP,
  assertNoBlocksCycle,
  assertNoParentCycle,
} from "../../src/tickets/edges.js";
import { recomputeAncestry } from "../../src/tickets/parent.js";

// B3: Edges
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Cycle rejected with clear error; cap rejected at 500; property test
//   on random DAGs"
//
// Clauses 1 & 2 are driven through the compiled `dist/slop` binary as a
// real CLI (spawned subprocesses, asserting stdout/stderr/exit codes and
// the actual ticket files on disk) — per §4.2, `new`'s creation-time
// flags (`--blocks`/`--discovered-from`) are the only documented edge
// -mutation surface; `update` has none (B1's report, confirmed against
// design.md §4.2's closed flag list). This work item's brief explicitly
// permits NOT inventing new CLI surface for post-creation edge edits, and
// this file follows that: every post-creation edge mutation below goes
// through `slop edit` — the one command whose contract ("open the
// ticket's JSONC file in $EDITOR") already lets a user touch any field,
// edges included. The fake "$EDITOR" used throughout replaces the ticket
// file wholesale with a precomputed replacement (a plain `cp`), which is
// far more robust for constructing exact graph shapes (deep chains, self
// -loops, brand-new fields) than sed one-liners over JSON text.
//
// Clause 3 (the property test) is unit-level, exercising the graph module
// (`src/tickets/edges.ts`, `src/tickets/parent.ts`) directly with no I/O
// and no CLI spawn, per the brief's "unit-test the graph module directly
// for the property test."

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const binaryPath = join(repoRoot, "dist", "slop");

beforeAll(() => {
  if (!existsSync(binaryPath)) {
    execFileSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
  }
  if (!existsSync(binaryPath)) {
    throw new Error(
      `${binaryPath} is still missing after attempting "bun run build". ` +
        'Run "bun run build" manually and re-run the tests.',
    );
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Fixture + spawn helpers (same shape as tests/acceptance/B1.test.ts)
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

interface Fixture {
  root: string;
  paths: RepoPaths;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "slop-b3-"));
  scratchDirs.push(root);
  const paths = await ensureDbDirs(root);
  const lines = [
    "project: b3-fixture",
    "user: ryan",
    "remotes:",
    "defaults:",
    "  stale_after: 60m",
    "  review_stale_after: 24h",
    "transcripts: local",
  ];
  await writeFile(join(paths.slopDir, "config.yaml"), `${lines.join("\n")}\n`, "utf8");
  return { root, paths };
}

afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function runSlop(
  args: string[],
  cwd: string,
  envOverrides: Record<string, string | undefined> = {},
): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDECODE: undefined,
    OPENCODE: undefined,
    CODEX_SANDBOX: undefined,
    CODEX_SANDBOX_NETWORK_DISABLED: undefined,
  };
  for (const [k, v] of Object.entries(envOverrides)) env[k] = v;
  return spawnSync(binaryPath, args, { cwd, encoding: "utf8", env });
}

async function readTicketFile(paths: RepoPaths, id: string): Promise<Ticket> {
  const raw = await readFile(join(paths.ticketsDir, `${id}.jsonc`), "utf8");
  const { value, errors } = parseJsonc<unknown>(raw);
  expect(errors, `ticket file ${id} should be valid JSONC`).toEqual([]);
  return ticketSchema.parse(value);
}

const CREATED_LINE = /^created (ticket_[0-9A-Z]+)\s+\(slug: ([a-z0-9-]+)\)$/m;

function parseCreatedOutput(stdout: string): { id: string; slug: string } {
  const m = CREATED_LINE.exec(stdout);
  if (!m?.[1] || !m[2]) {
    throw new Error(`could not parse "created <id> (slug: <slug>)" out of stdout:\n${stdout}`);
  }
  return { id: m[1], slug: m[2] };
}

async function createTicketViaCli(
  fixture: Fixture,
  name: string,
  extraArgs: string[] = [],
): Promise<{ id: string; slug: string }> {
  const result = runSlop(["new", name, ...extraArgs], fixture.root);
  expect(result.status, result.stderr).toBe(0);
  return parseCreatedOutput(result.stdout);
}

let replacementCounter = 0;

/**
 * A fake `$EDITOR` that replaces the ticket file wholesale with
 * `mutatedTicket` (a plain `cp` of a precomputed replacement) — see this
 * file's header doc for why this is used instead of sed over raw JSON
 * text.
 */
async function makeReplacementEditor(fixture: Fixture, mutatedTicket: Ticket): Promise<string> {
  replacementCounter++;
  const replacementPath = join(fixture.root, `replacement-${replacementCounter}.jsonc`);
  await writeFile(replacementPath, `${JSON.stringify(mutatedTicket, null, 2)}\n`, "utf8");
  const editorPath = join(fixture.root, `fake-editor-${replacementCounter}.sh`);
  await writeFile(editorPath, `#!/bin/sh\ncp "${replacementPath}" "$1"\nexit 0\n`, "utf8");
  chmodSync(editorPath, 0o755);
  return editorPath;
}

async function editViaFakeEditor(
  fixture: Fixture,
  refId: string,
  mutatedTicket: Ticket,
): Promise<SpawnSyncReturns<string>> {
  const editorPath = await makeReplacementEditor(fixture, mutatedTicket);
  return runSlop(["edit", refId], fixture.root, { EDITOR: editorPath });
}

// ---------------------------------------------------------------------------
// Clause 1: "Cycle rejected with clear error"
// ---------------------------------------------------------------------------

describe("B3: Edges", () => {
  describe('"Cycle rejected with clear error"', () => {
    it("direct self-edge (blocks): exit 6, message names the ticket, db unchanged", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Self blocker");
      const before = await readTicketFile(fixture.paths, id);

      const mutated: Ticket = { ...before, blocks: [before.id] };
      const result = await editViaFakeEditor(fixture, id, mutated);

      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(/blocking cycle/);
      expect(result.stderr).toContain(before.slug);

      const after = await readTicketFile(fixture.paths, id);
      expect(after).toEqual(before); // no partial write
    });

    it("direct self-edge (parent): exit 6, message names the ticket, db unchanged", async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Self parent");
      const before = await readTicketFile(fixture.paths, id);

      const mutated: Ticket = { ...before, parent: before.id };
      const result = await editViaFakeEditor(fixture, id, mutated);

      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(/ancestry cycle/);
      expect(result.stderr).toContain(before.slug);

      const after = await readTicketFile(fixture.paths, id);
      expect(after).toEqual(before);
    });

    it("two-node cycle (blocks): exit 6, message shows both slugs in the closing path, db unchanged", async () => {
      const fixture = await makeFixture();
      const { id: aId } = await createTicketViaCli(fixture, "A");
      const { id: bId } = await createTicketViaCli(fixture, "B", ["--blocks", aId]); // B already blocks A
      const beforeA = await readTicketFile(fixture.paths, aId);
      const beforeB = await readTicketFile(fixture.paths, bId);

      // Now try to make A block B too — closes the cycle A -> B -> A.
      const mutated: Ticket = { ...beforeA, blocks: [beforeB.id] };
      const result = await editViaFakeEditor(fixture, aId, mutated);

      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(/blocking cycle/);
      expect(result.stderr).toContain(beforeA.slug);
      expect(result.stderr).toContain(beforeB.slug);

      expect(await readTicketFile(fixture.paths, aId)).toEqual(beforeA);
      expect(await readTicketFile(fixture.paths, bId)).toEqual(beforeB);
    });

    it("two-node cycle (parent): exit 6, message shows both slugs, db unchanged", async () => {
      const fixture = await makeFixture();
      const { id: aId } = await createTicketViaCli(fixture, "Alpha");
      const { id: bId } = await createTicketViaCli(fixture, "Beta", ["--parent", aId]); // B's parent is A
      const beforeA = await readTicketFile(fixture.paths, aId);
      const beforeB = await readTicketFile(fixture.paths, bId);

      // Now try to make A's parent B — closes the ancestry cycle A -> B -> A.
      const mutated: Ticket = { ...beforeA, parent: beforeB.id };
      const result = await editViaFakeEditor(fixture, aId, mutated);

      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(/ancestry cycle/);
      expect(result.stderr).toContain(beforeA.slug);
      expect(result.stderr).toContain(beforeB.slug);

      expect(await readTicketFile(fixture.paths, aId)).toEqual(beforeA);
      expect(await readTicketFile(fixture.paths, bId)).toEqual(beforeB);
    });

    it("a long chain closed at the end (blocks): exit 6, every link's slug appears in the path, db unchanged", async () => {
      const fixture = await makeFixture();
      const n = 8;
      const ids: string[] = Array.from({ length: n }, () => "");
      // Create back-to-front so each --blocks target already exists,
      // producing the forward chain T0 -> T1 -> ... -> T(n-1).
      for (let i = n - 1; i >= 0; i--) {
        const extraArgs = i < n - 1 ? ["--blocks", ids[i + 1] as string] : [];
        const { id } = await createTicketViaCli(fixture, `Chain ${i}`, extraArgs);
        ids[i] = id;
      }
      const befores = await Promise.all(ids.map((id) => readTicketFile(fixture.paths, id)));

      const lastId = ids[n - 1] as string;
      const beforeLast = befores[n - 1] as Ticket;
      const beforeFirst = befores[0] as Ticket;
      // Close the cycle at the far end: T(n-1) -> T0 (already T0 -> T1 -> ... -> T(n-1)).
      const mutated: Ticket = { ...beforeLast, blocks: [...beforeLast.blocks, beforeFirst.id] };
      const result = await editViaFakeEditor(fixture, lastId, mutated);

      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(/blocking cycle/);
      for (const t of befores) expect(result.stderr).toContain(t.slug);

      const afters = await Promise.all(ids.map((id) => readTicketFile(fixture.paths, id)));
      expect(afters).toEqual(befores);
    });

    it("a long chain closed at the end (parent): exit 6, every link's slug appears in the path, db unchanged", async () => {
      const fixture = await makeFixture();
      const n = 8;
      const ids: string[] = [];
      // Create front-to-back: each needs its immediate predecessor to exist.
      for (let i = 0; i < n; i++) {
        const extraArgs = i > 0 ? ["--parent", ids[i - 1] as string] : [];
        const { id } = await createTicketViaCli(fixture, `PChain ${i}`, extraArgs);
        ids.push(id);
      }
      const befores = await Promise.all(ids.map((id) => readTicketFile(fixture.paths, id)));

      const firstId = ids[0] as string;
      const beforeFirst = befores[0] as Ticket;
      const beforeLast = befores[n - 1] as Ticket;
      // Close the cycle at the far end: T0's parent becomes T(n-1)
      // (already T0 <- T1 <- ... <- T(n-1) via the parent chain).
      const mutated: Ticket = { ...beforeFirst, parent: beforeLast.id };
      const result = await editViaFakeEditor(fixture, firstId, mutated);

      expect(result.status).toBe(6);
      expect(result.stderr).toMatch(/ancestry cycle/);
      for (const t of befores) expect(result.stderr).toContain(t.slug);

      const afters = await Promise.all(ids.map((id) => readTicketFile(fixture.paths, id)));
      expect(afters).toEqual(befores);
    });
  });

  // -------------------------------------------------------------------------
  // Clause 2: "cap rejected at 500"
  // -------------------------------------------------------------------------

  describe('"cap rejected at 500"', () => {
    const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
    const createdEvent: MutationEventSpec = { verb: "ticket.created" };

    function minimalTarget(slug: string): Ticket {
      const id = newTicketId();
      return ticketSchema.parse({
        id,
        name: slug,
        slug,
        spec: { summary: slug },
        state: "open",
        root_id: id,
        provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
        last_activity_at: "2026-07-23T10:00:00.000Z",
        created_at: "2026-07-23T10:00:00.000Z",
        updated_at: "2026-07-23T10:00:00.000Z",
      });
    }

    it(`exactly ${EDGE_DEGREE_CAP} accepted, ${EDGE_DEGREE_CAP + 1} rejected — the exact boundary, via a real \`slop edit\``, async () => {
      const fixture = await makeFixture();
      const { id } = await createTicketViaCli(fixture, "Capped ticket");

      // 501 real target tickets, created directly through the repo
      // layer (fast — spawning `slop new` 501 times would make this
      // suite prohibitively slow) so this exercises a genuine "cap"
      // rejection, not a "dangling ref" one. The action actually under
      // test — the cap being enforced — still goes through a real
      // spawned `slop edit`.
      const targets: Ticket[] = [];
      for (let i = 0; i < EDGE_DEGREE_CAP + 1; i++) {
        const t = minimalTarget(`target-${i}`);
        await createTicket(fixture.paths, t, ctx, createdEvent);
        targets.push(t);
      }

      const before = await readTicketFile(fixture.paths, id);

      // --- exactly the cap: accepted ---
      const okIds = targets.slice(0, EDGE_DEGREE_CAP).map((t) => t.id);
      const okMutated: Ticket = { ...before, blocks: okIds };
      const okResult = await editViaFakeEditor(fixture, id, okMutated);
      expect(okResult.status, okResult.stderr).toBe(0);
      const afterOk = await readTicketFile(fixture.paths, id);
      expect(afterOk.blocks).toHaveLength(EDGE_DEGREE_CAP);
      expect(new Set(afterOk.blocks)).toEqual(new Set(okIds));

      // --- one more than the cap: rejected, clear message, db unchanged ---
      const tooManyIds = targets.slice(0, EDGE_DEGREE_CAP + 1).map((t) => t.id);
      const badMutated: Ticket = { ...afterOk, blocks: tooManyIds };
      const badResult = await editViaFakeEditor(fixture, id, badMutated);
      expect(badResult.status).toBe(6);
      expect(badResult.stderr).toContain(before.slug);
      expect(badResult.stderr).toMatch(/blocks/);
      expect(badResult.stderr).toContain(String(EDGE_DEGREE_CAP));
      expect(badResult.stderr).toContain(String(EDGE_DEGREE_CAP + 1));

      const afterBad = await readTicketFile(fixture.paths, id);
      expect(afterBad).toEqual(afterOk); // unchanged from the accepted 500-state
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // Reparenting: root_id/path cascade to descendants (D6), via a real
  // `slop edit`. Complements the property test's pure-function coverage
  // below with an end-to-end check through the actual write path.
  // -------------------------------------------------------------------------

  describe("reparenting cascades root_id/path to every descendant", () => {
    it("reparenting a subtree root under a new local root updates the ticket and all its descendants", async () => {
      const fixture = await makeFixture();
      const { id: oldRootId } = await createTicketViaCli(fixture, "Old root");
      const { id: midId } = await createTicketViaCli(fixture, "Mid", ["--parent", oldRootId]);
      const { id: leafId } = await createTicketViaCli(fixture, "Leaf", ["--parent", midId]);
      const { id: newRootId } = await createTicketViaCli(fixture, "New root");
      const newRootTicket = await readTicketFile(fixture.paths, newRootId);

      const beforeMid = await readTicketFile(fixture.paths, midId);
      const mutated: Ticket = { ...beforeMid, parent: newRootTicket.id };
      const result = await editViaFakeEditor(fixture, midId, mutated);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toMatch(/reparented/);
      expect(result.stdout).toMatch(/descendant/);

      const afterMid = await readTicketFile(fixture.paths, midId);
      expect(afterMid.root_id).toBe(newRootTicket.id);
      expect(afterMid.path).toEqual([newRootTicket.id]);

      const afterLeaf = await readTicketFile(fixture.paths, leafId);
      expect(afterLeaf.root_id).toBe(newRootTicket.id);
      expect(afterLeaf.path).toEqual([newRootTicket.id, midId]);

      // The old root is untouched — it was never a descendant of `mid`.
      const afterOldRoot = await readTicketFile(fixture.paths, oldRootId);
      expect(afterOldRoot.root_id).toBe(afterOldRoot.id);
    });
  });

  // -------------------------------------------------------------------------
  // Clause 3: "property test on random DAGs"
  // -------------------------------------------------------------------------

  describe('"property test on random DAGs"', () => {
    const PROPERTY_RUNS = 300;

    function at<T>(arr: readonly T[], i: number): T {
      const v = arr[i];
      if (v === undefined) throw new Error(`test bug: index ${i} out of bounds`);
      return v;
    }

    function minimalTicket(id: TicketId, overrides: Partial<Ticket> = {}): Ticket {
      return ticketSchema.parse({
        id,
        name: `T-${id.slice(-6)}`,
        slug: `t-${id.slice(-10).toLowerCase()}`,
        spec: { summary: "s" },
        state: "open",
        root_id: id,
        provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
        last_activity_at: "2026-07-23T10:00:00.000Z",
        created_at: "2026-07-23T10:00:00.000Z",
        updated_at: "2026-07-23T10:00:00.000Z",
        ...overrides,
      });
    }

    /**
     * Independent oracle: full transitive closure via Floyd-Warshall — a
     * different algorithm and code path from edges.ts's single-source
     * BFS (`detectCycle`), so agreement between the two is a genuine
     * cross-check rather than the checker validated against itself.
     * `reach[i][j] === true` means node `j` is reachable from node `i` by
     * following `edges` forward.
     */
    function reachabilityClosure(
      n: number,
      edges: ReadonlyArray<readonly [number, number]>,
    ): boolean[][] {
      const reach: boolean[][] = Array.from({ length: n }, () =>
        Array.from({ length: n }, () => false),
      );
      for (const [a, b] of edges) at(reach, a)[b] = true;
      for (let k = 0; k < n; k++) {
        for (let i = 0; i < n; i++) {
          if (!at(reach, i)[k]) continue;
          for (let j = 0; j < n; j++) {
            if (at(reach, k)[j]) at(reach, i)[j] = true;
          }
        }
      }
      return reach;
    }

    // --- "blocks" cycle checking, validated against the reachability oracle ---

    const nArb = fc.integer({ min: 2, max: 10 });
    const dagArb = nArb.chain((n) => {
      const pairCount = (n * (n - 1)) / 2;
      return fc.record({
        n: fc.constant(n),
        includePair: fc.array(fc.boolean(), { minLength: pairCount, maxLength: pairCount }),
        from: fc.integer({ min: 0, max: n - 1 }),
        to: fc.integer({ min: 0, max: n - 1 }),
      });
    });

    function decodePairs(n: number, includePair: readonly boolean[]): [number, number][] {
      const edges: [number, number][] = [];
      let k = 0;
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          if (at(includePair, k)) edges.push([i, j]);
          k++;
        }
      }
      return edges;
    }

    it("every `blocks` edge insertion that preserves acyclicity is accepted, every one that closes a cycle is rejected", () => {
      fc.assert(
        fc.property(dagArb, ({ n, includePair, from, to }) => {
          // Existing edges only ever go i -> j with i < j, which
          // guarantees the pre-write graph is acyclic by construction.
          const edges = decodePairs(n, includePair);
          fc.pre(!edges.some(([a, b]) => a === from && b === to)); // duplicate-edge is a separate, dedicated check

          const ids: TicketId[] = Array.from({ length: n }, () => newTicketId());
          const tickets = ids.map((id, idx) =>
            minimalTicket(id, {
              blocks: edges.filter(([a]) => a === idx).map(([, b]) => at(ids, b)),
            }),
          );

          const candidate: Ticket = {
            ...at(tickets, from),
            blocks: [...at(tickets, from).blocks, at(ids, to)],
          };
          const others = tickets.filter((_, idx) => idx !== from);

          const reach = reachabilityClosure(n, edges);
          const expectCycle = from === to || at(reach, to)[from];

          let threw = false;
          try {
            assertNoBlocksCycle(candidate, others);
          } catch (err) {
            threw = true;
            expect(err).toMatchObject({ exitCode: 6 });
          }
          expect(threw).toBe(expectCycle);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });

    // --- "parent" cycle checking + reparenting consistency, validated
    // against an independently-computed ancestry ---

    /** Derives a valid forest from `n` raw integers: `parentOf[i]` is
     * either `null` (root) or some `j < i` — guaranteed acyclic by
     * construction (an index can only ever point strictly backwards). */
    function decodeForest(n: number, raw: readonly number[]): (number | null)[] {
      const parentOf: (number | null)[] = [null];
      for (let i = 1; i < n; i++) {
        const options = i + 1; // indices 0..i-1, plus "no parent"
        const choice = ((at(raw, i) % options) + options) % options;
        parentOf.push(choice === i ? null : choice);
      }
      return parentOf;
    }

    /** Independent re-derivation of every node's root_id/path from a
     * parent-index map, via memoized recursion — deliberately NOT the
     * same "inherit from the trusted parent in index order" strategy
     * `recomputeAncestry` uses, so this is a genuine second opinion. */
    function computeAncestryIndependently(
      n: number,
      ids: readonly TicketId[],
      parentIdx: readonly (number | null)[],
    ): { rootId: TicketId; path: TicketId[] }[] {
      const memo = new Map<number, { rootId: TicketId; path: TicketId[] }>();
      function resolve(
        i: number,
        visiting: ReadonlySet<number>,
      ): { rootId: TicketId; path: TicketId[] } {
        const cached = memo.get(i);
        if (cached) return cached;
        if (visiting.has(i))
          throw new Error("test bug: cycle in oracle forest — should be impossible");
        const p = at(parentIdx, i);
        const result =
          p === null
            ? { rootId: at(ids, i), path: [] as TicketId[] }
            : (() => {
                const parentResult = resolve(p, new Set(visiting).add(i));
                return { rootId: parentResult.rootId, path: [...parentResult.path, at(ids, p)] };
              })();
        memo.set(i, result);
        return result;
      }
      return Array.from({ length: n }, (_, i) => resolve(i, new Set()));
    }

    const forestArb = nArb.chain((n) =>
      fc.record({
        n: fc.constant(n),
        raw: fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: n, maxLength: n }),
        from: fc.integer({ min: 0, max: n - 1 }),
        to: fc.integer({ min: 0, max: n - 1 }),
      }),
    );

    it("every `parent` reassignment that preserves acyclicity is accepted (and reparenting keeps root_id/path consistent for every descendant); every one that closes an ancestry cycle is rejected", () => {
      fc.assert(
        fc.property(forestArb, ({ n, raw, from, to }) => {
          const parentOf = decodeForest(n, raw);
          const ids: TicketId[] = Array.from({ length: n }, () => newTicketId());

          const rootIdOf: TicketId[] = [];
          const pathOf: TicketId[][] = [];
          const tickets: Ticket[] = [];
          for (let i = 0; i < n; i++) {
            const p = at(parentOf, i);
            const rootId = p === null ? at(ids, i) : at(rootIdOf, p);
            const path = p === null ? [] : [...at(pathOf, p), at(ids, p)];
            rootIdOf.push(rootId);
            pathOf.push(path);
            tickets.push(
              minimalTicket(at(ids, i), {
                parent: p === null ? undefined : at(ids, p),
                root_id: rootId,
                path,
              }),
            );
          }

          const candidate: Ticket = { ...at(tickets, from), parent: at(ids, to) };
          const others = tickets.filter((_, idx) => idx !== from);

          const parentEdges: [number, number][] = [];
          for (let i = 0; i < n; i++) {
            const p = at(parentOf, i);
            if (p !== null) parentEdges.push([i, p]);
          }
          const reach = reachabilityClosure(n, parentEdges);
          const expectCycle = from === to || at(reach, to)[from];

          let threw = false;
          try {
            assertNoParentCycle(candidate, others);
          } catch (err) {
            threw = true;
            expect(err).toMatchObject({ exitCode: 6 });
          }
          expect(threw).toBe(expectCycle);

          if (expectCycle) return; // recomputeAncestry's precondition is acyclicity — don't call it here

          const result = recomputeAncestry(candidate, others);

          const newParentOf = parentOf.slice();
          newParentOf[from] = to;
          const expectedAncestry = computeAncestryIndependently(n, ids, newParentOf);

          expect(result.ticket.root_id).toBe(at(expectedAncestry, from).rootId);
          expect(result.ticket.path).toEqual(at(expectedAncestry, from).path);

          const descendantsById = new Map(result.descendants.map((t) => [t.id, t] as const));
          for (let i = 0; i < n; i++) {
            if (i === from) continue;
            const id = at(ids, i);
            const expected = at(expectedAncestry, i);
            const returned = descendantsById.get(id);
            if (returned) {
              expect(returned.root_id).toBe(expected.rootId);
              expect(returned.path).toEqual(expected.path);
            } else {
              // Untouched by the reparent -> its ancestry must be genuinely unchanged.
              expect(expected.rootId).toBe(at(rootIdOf, i));
              expect(expected.path).toEqual(at(pathOf, i));
            }
          }
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });
});
