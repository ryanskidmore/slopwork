import { describe, expect, it } from "vitest";
import {
  configSchema,
  newSessionId,
  newTicketId,
  sessionSchema,
  specSchema,
  ticketSchema,
} from "../core/index.js";
import type { Session, Ticket } from "../core/index.js";
import type { ContextPackData } from "../tickets/context.js";
import { renderContextPack } from "../tickets/context.js";
import { CONTEXT_PACK_BUDGET_UNIT, renderContextPackWithBudget } from "./context-budget.js";

const config = configSchema.parse({ project: "p" });

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: {
      summary: "Do the thing",
      details_md: "Lorem ipsum dolor sit amet, ".repeat(60), // ~1680 chars, plenty to truncate
      acceptance: ["it works"],
    },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function makeSession(startedAt: string, actorName: string): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: newTicketId(),
    actor: { name: actorName, kind: "agent" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: "abc" },
    started_at: startedAt,
  });
}

function baseData(overrides: Partial<ContextPackData> = {}): ContextPackData {
  return { ticket: makeTicket(), config, ancestors: [], blockers: [], sessions: [], ...overrides };
}

describe("renderContextPackWithBudget", () => {
  it("documents its unit as characters, not tokens", () => {
    expect(CONTEXT_PACK_BUDGET_UNIT).toBe("characters");
  });

  it("no budget given: returns the full pack unchanged, no elisions", () => {
    const data = baseData();
    const result = renderContextPackWithBudget(data);
    expect(result.text).toBe(renderContextPack(data));
    expect(result.elisions).toEqual([]);
    expect(result.withinBudget).toBe(true);
  });

  it("already under budget: returns the full pack unchanged, no elisions", () => {
    const data = baseData();
    const full = renderContextPack(data);
    const result = renderContextPackWithBudget(data, full.length + 500);
    expect(result.text).toBe(full);
    expect(result.elisions).toEqual([]);
  });

  it("a budget that fits with sessions but requires dropping the oldest ones: keeps the most recent, drops the rest, states so", () => {
    const sessions = [
      makeSession("2026-07-23T09:00:00.000Z", "agent-oldest"),
      makeSession("2026-07-22T09:00:00.000Z", "agent-middle"),
      makeSession("2026-07-21T09:00:00.000Z", "agent-newest"),
    ];
    // tickets/context.ts's documented convention: sessions passed in
    // most-recent-first.
    const mostRecentFirst = [sessions[0], sessions[1], sessions[2]] as Session[];
    const data = baseData({
      ticket: makeTicket({ spec: specSchema.parse({ summary: "s" }) }),
      sessions: mostRecentFirst,
    });
    const full = renderContextPack(data);
    const newest = mostRecentFirst[0] as Session;
    const oldest = mostRecentFirst[2] as Session;

    // Find a budget (via the function under test itself, scanning downward
    // from just-under-full) that forces dropping AT LEAST ONE session but
    // not every one of them — exact arithmetic on the elision note's own
    // text length would be brittle against future wording changes; this
    // isn't.
    let found: ReturnType<typeof renderContextPackWithBudget> | null = null;
    for (let budget = full.length - 1; budget > 0; budget -= 10) {
      const result = renderContextPackWithBudget(data, budget);
      const keptCount = mostRecentFirst.filter((s) => result.text.includes(s.id)).length;
      if (keptCount > 0 && keptCount < mostRecentFirst.length) {
        found = result;
        break;
      }
    }
    expect(found).not.toBeNull();
    const result = found as ReturnType<typeof renderContextPackWithBudget>;

    expect(result.withinBudget).toBe(true);
    expect(result.elisions.length).toBeGreaterThan(0);
    expect(result.text).toContain("Elided for --budget");
    // The most recent session survives; the least useful (oldest) is the
    // one that goes first.
    expect(result.text).toContain(newest.id);
    expect(result.text).not.toContain(oldest.id);
  });

  it("a tighter budget forces dropping ALL sessions and truncating spec.details_md, but stays within budget and says what happened", () => {
    const sessions = [makeSession("2026-07-23T09:00:00.000Z", "agent-a")];
    const data = baseData({ sessions });
    const full = renderContextPack(data);
    const budget = 400;
    expect(budget).toBeLessThan(full.length);

    const result = renderContextPackWithBudget(data, budget);
    expect(result.text.length).toBeLessThanOrEqual(budget);
    expect(result.withinBudget).toBe(true);
    expect(result.text).toContain("Elided for --budget");
    expect(result.text).toMatch(/all \d+ prior session\(s\) omitted|older session\(s\) omitted/);
    expect(result.text).toContain("details_md truncated");
    // Still coherent: the ticket's own header/summary line survives.
    expect(result.text).toContain(data.ticket.name);
  });

  it("respects several different budgets, including one small enough to force real elision, always staying within budget", () => {
    const sessions = [
      makeSession("2026-07-23T09:00:00.000Z", "agent-a"),
      makeSession("2026-07-22T09:00:00.000Z", "agent-b"),
    ];
    const data = baseData({ sessions });
    for (const budget of [50, 150, 300, 600, 1200, 3000]) {
      const result = renderContextPackWithBudget(data, budget);
      expect(result.text.length, `budget=${budget}`).toBeLessThanOrEqual(budget);
      expect(result.withinBudget, `budget=${budget}`).toBe(true);
    }
  });

  it("an absurdly small budget still respects the limit exactly, via the hard-truncation last resort", () => {
    const data = baseData({ sessions: [makeSession("2026-07-23T09:00:00.000Z", "agent-a")] });
    for (const budget of [1, 5, 10, 20]) {
      const result = renderContextPackWithBudget(data, budget);
      expect(result.text.length, `budget=${budget}`).toBeLessThanOrEqual(budget);
    }
  });

  it("budget 0 is respected (empty string)", () => {
    const data = baseData();
    const result = renderContextPackWithBudget(data, 0);
    expect(result.text.length).toBeLessThanOrEqual(0);
  });
});
