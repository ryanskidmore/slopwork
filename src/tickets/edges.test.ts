import { describe, expect, it } from "vitest";
import type { Ticket, TicketId } from "../core/index.js";
import { newTicketId, ticketSchema } from "../core/index.js";
import {
  EDGE_DEGREE_CAP,
  assertDegreeCap,
  assertEdgeTargetsExist,
  assertNoBlocksCycle,
  assertNoParentCycle,
  detectCycle,
  validateTicketEdges,
} from "./edges.js";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-8).toLowerCase()}`,
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

describe("detectCycle", () => {
  it("returns null for an acyclic adjacency", () => {
    const a = newTicketId();
    const b = newTicketId();
    const c = newTicketId();
    const adjacency = new Map([
      [a, [b]],
      [b, [c]],
      [c, []],
    ]);
    expect(detectCycle(adjacency, a)).toBeNull();
  });

  it("detects a direct self-edge", () => {
    const a = newTicketId();
    const adjacency = new Map([[a, [a]]]);
    expect(detectCycle(adjacency, a)).toEqual([a, a]);
  });

  it("detects a two-node cycle and returns the closing path", () => {
    const a = newTicketId();
    const b = newTicketId();
    const adjacency = new Map([
      [a, [b]],
      [b, [a]],
    ]);
    expect(detectCycle(adjacency, a)).toEqual([a, b, a]);
  });

  it("detects a long chain closed at the end", () => {
    const ids: TicketId[] = Array.from({ length: 12 }, () => newTicketId());
    const adjacency = new Map<TicketId, TicketId[]>();
    for (let i = 0; i < ids.length; i++) {
      const next = ids[(i + 1) % ids.length]; // last node's edge closes back to the first
      const id = ids[i];
      if (id === undefined || next === undefined) throw new Error("unreachable");
      adjacency.set(id, [next]);
    }
    const start = ids[0];
    if (start === undefined) throw new Error("unreachable");
    const path = detectCycle(adjacency, start);
    expect(path).not.toBeNull();
    expect(path?.[0]).toBe(start);
    expect(path?.[(path?.length ?? 1) - 1]).toBe(start);
    expect(path?.length).toBe(ids.length + 1);
  });

  it("throws (does not silently accept) when the visit bound is exceeded", () => {
    const a = newTicketId();
    const b = newTicketId();
    // No path back to `a` exists at all — an unbounded search would
    // legitimately return null; the bound must still fire and refuse.
    const adjacency = new Map([
      [a, [b]],
      [b, []],
    ]);
    expect(() => detectCycle(adjacency, a, 0)).toThrowError(/exceeded 0 edge visits/);
    try {
      detectCycle(adjacency, a, 0);
      throw new Error("expected a throw");
    } catch (err) {
      expect(err).toMatchObject({ exitCode: 6 });
    }
  });
});

describe("assertNoParentCycle", () => {
  it("accepts a fresh acyclic parent assignment", () => {
    const root = makeTicket();
    const candidate = makeTicket({ parent: root.id });
    expect(() => assertNoParentCycle(candidate, [root])).not.toThrow();
  });

  it("rejects a direct self-parent", () => {
    const a = makeTicket();
    const candidate = { ...a, parent: a.id };
    expect(() => assertNoParentCycle(candidate, [])).toThrowError(/ancestry cycle/);
    try {
      assertNoParentCycle(candidate, []);
    } catch (err) {
      expect(err).toMatchObject({ exitCode: 6 });
      expect((err as Error).message).toContain(a.slug);
    }
  });

  it("rejects a two-node ancestry cycle, naming both slugs in the path", () => {
    const a = makeTicket({ slug: "alpha" });
    const b = makeTicket({ slug: "beta", parent: a.id });
    // Try to make `a`'s parent `b` — but `b`'s parent is already `a`.
    const candidate = { ...a, parent: b.id };
    let thrown: unknown;
    try {
      assertNoParentCycle(candidate, [b]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ exitCode: 6 });
    expect((thrown as Error).message).toContain("alpha");
    expect((thrown as Error).message).toContain("beta");
  });

  it("rejects a long ancestry chain closed at the far end", () => {
    const n = 10;
    const chain: Ticket[] = [];
    for (let i = 0; i < n; i++) {
      const parent = i > 0 ? chain[i - 1] : undefined;
      chain.push(makeTicket({ slug: `chain-${i}`, parent: parent?.id }));
    }
    const first = chain[0];
    const last = chain[n - 1];
    if (!first || !last) throw new Error("unreachable");
    // Point the root's parent at the far end of its own chain.
    const candidate = { ...first, parent: last.id };
    const others = chain.slice(1);
    expect(() => assertNoParentCycle(candidate, others)).toThrowError(/ancestry cycle/);
  });

  it("is a no-op for an external parent (D1: terminates the local tree)", () => {
    const candidate = makeTicket({ parent: "jira:PROJ-1" });
    expect(() => assertNoParentCycle(candidate, [])).not.toThrow();
  });

  it("is a no-op for no parent at all", () => {
    const candidate = makeTicket();
    expect(() => assertNoParentCycle(candidate, [])).not.toThrow();
  });
});

describe("assertNoBlocksCycle", () => {
  it("accepts an acyclic blocks edge", () => {
    const target = makeTicket();
    const candidate = makeTicket({ blocks: [target.id] });
    expect(() => assertNoBlocksCycle(candidate, [target])).not.toThrow();
  });

  it("rejects a direct self-block", () => {
    const a = makeTicket();
    const candidate = { ...a, blocks: [a.id] };
    let thrown: unknown;
    try {
      assertNoBlocksCycle(candidate, []);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ exitCode: 6 });
    expect((thrown as Error).message).toMatch(/blocking cycle/);
    expect((thrown as Error).message).toContain(a.slug);
  });

  it("rejects a two-node blocking cycle", () => {
    const a = makeTicket({ slug: "alpha" });
    const b = makeTicket({ slug: "beta", blocks: [a.id] });
    const candidate = { ...a, blocks: [b.id] };
    let thrown: unknown;
    try {
      assertNoBlocksCycle(candidate, [b]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ exitCode: 6 });
    expect((thrown as Error).message).toContain("alpha");
    expect((thrown as Error).message).toContain("beta");
  });

  it("rejects a long blocking chain closed at the far end", () => {
    const n = 10;
    const chain: Ticket[] = [];
    for (let i = 0; i < n; i++) chain.push(makeTicket({ slug: `chain-${i}` }));
    for (let i = 0; i < n - 1; i++) {
      const current = chain[i];
      const next = chain[i + 1];
      if (!current || !next) throw new Error("unreachable");
      chain[i] = { ...current, blocks: [next.id] };
    }
    const first = chain[0];
    const last = chain[n - 1];
    if (!first || !last) throw new Error("unreachable");
    const candidate = { ...last, blocks: [first.id] };
    const others = chain.slice(0, n - 1);
    expect(() => assertNoBlocksCycle(candidate, others)).toThrowError(/blocking cycle/);
  });
});

describe("assertDegreeCap", () => {
  it(`accepts exactly ${EDGE_DEGREE_CAP} blocks entries`, () => {
    const targets = Array.from({ length: EDGE_DEGREE_CAP }, () => newTicketId());
    const candidate = makeTicket({ blocks: targets });
    expect(() => assertDegreeCap(candidate)).not.toThrow();
  });

  it(`rejects ${EDGE_DEGREE_CAP + 1} blocks entries with a clear message`, () => {
    const targets = Array.from({ length: EDGE_DEGREE_CAP + 1 }, () => newTicketId());
    const candidate = makeTicket({ blocks: targets });
    let thrown: unknown;
    try {
      assertDegreeCap(candidate);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ exitCode: 6 });
    expect((thrown as Error).message).toContain(candidate.slug);
    expect((thrown as Error).message).toContain("blocks");
    expect((thrown as Error).message).toContain(String(EDGE_DEGREE_CAP));
  });

  it("applies the same cap independently to relates_to and discovered_from", () => {
    const okRelates = makeTicket({
      relates_to: Array.from({ length: EDGE_DEGREE_CAP }, newTicketId),
    });
    expect(() => assertDegreeCap(okRelates)).not.toThrow();
    const tooManyRelates = makeTicket({
      relates_to: Array.from({ length: EDGE_DEGREE_CAP + 1 }, newTicketId),
    });
    expect(() => assertDegreeCap(tooManyRelates)).toThrowError(/relates-to/);

    const okDiscovered = makeTicket({
      discovered_from: Array.from({ length: EDGE_DEGREE_CAP }, newTicketId),
    });
    expect(() => assertDegreeCap(okDiscovered)).not.toThrow();
    const tooManyDiscovered = makeTicket({
      discovered_from: Array.from({ length: EDGE_DEGREE_CAP + 1 }, newTicketId),
    });
    expect(() => assertDegreeCap(tooManyDiscovered)).toThrowError(/discovered-from/);
  });

  it("rejects a duplicate target within one edge kind's array (edges are a set, not a multiset)", () => {
    const target = newTicketId();
    const candidate = makeTicket({ blocks: [target, target] });
    let thrown: unknown;
    try {
      assertDegreeCap(candidate);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ exitCode: 6 });
    expect((thrown as Error).message).toMatch(/more than once/);
  });
});

describe("assertEdgeTargetsExist", () => {
  it("accepts targets that exist in `others`", () => {
    const target = makeTicket();
    const candidate = makeTicket({ blocks: [target.id], parent: target.id });
    expect(() => assertEdgeTargetsExist(candidate, [target])).not.toThrow();
  });

  it("rejects a dangling blocks target (exit 4, NOT_FOUND)", () => {
    const candidate = makeTicket({ blocks: [newTicketId()] });
    let thrown: unknown;
    try {
      assertEdgeTargetsExist(candidate, []);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toMatchObject({ exitCode: 4 });
  });

  it("rejects a dangling local parent target", () => {
    const candidate = makeTicket({ parent: newTicketId() });
    expect(() => assertEdgeTargetsExist(candidate, [])).toThrow();
  });

  it("is a no-op for an external parent", () => {
    const candidate = makeTicket({ parent: "jira:PROJ-1" });
    expect(() => assertEdgeTargetsExist(candidate, [])).not.toThrow();
  });
});

describe("validateTicketEdges (top-level orchestrator)", () => {
  it("accepts a fully valid candidate", () => {
    const target = makeTicket();
    const candidate = makeTicket({ blocks: [target.id], discovered_from: [target.id] });
    expect(() => validateTicketEdges(candidate, [target])).not.toThrow();
  });

  it("runs the degree cap before the (more expensive) cycle check", () => {
    // A candidate that is BOTH over-cap AND would self-cycle: the cap
    // error should win (documented order: cap -> existence -> cycles).
    const self = newTicketId();
    const targets = [self, ...Array.from({ length: EDGE_DEGREE_CAP }, () => newTicketId())];
    const candidate = { ...makeTicket({ id: self, root_id: self }), blocks: targets };
    let thrown: unknown;
    try {
      validateTicketEdges(candidate, []);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toMatch(/exceeding the per-ticket per-edge-kind cap/);
  });

  it("excludes candidate's own stale entry from `others` defensively", () => {
    // Passing `others` that (incorrectly) still includes an old copy of
    // `candidate` itself (same id, stale content) must not confuse the
    // cycle check — the candidate's own entry is always overridden by its
    // OWN fresh edges, never left as a stale duplicate alongside it.
    const target = makeTicket();
    const candidate = makeTicket({ blocks: [target.id] });
    const staleCandidateCopy: Ticket = { ...candidate, blocks: [] };
    expect(() => validateTicketEdges(candidate, [target, staleCandidateCopy])).not.toThrow();
  });
});
