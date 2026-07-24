/**
 * `--json` (E1) coverage for context-budget.ts's `buildContextPackJson`/
 * `renderContextPackJsonWithBudget` — a separate file rather than adding
 * onto context-budget.test.ts (this suite's own scope is deliberately
 * limited to test SANDBOXING/COVERAGE/two named cleanups, not editing
 * arbitrary pre-existing test files), covering the JSON sibling of
 * `renderContextPackWithBudget` that context-budget.test.ts's own suite
 * never exercised.
 */
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
import { buildContextPackJson, renderContextPackJsonWithBudget } from "./context-budget.js";

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

describe("buildContextPackJson", () => {
  it("maps every ContextPackData field into the JSON body 1:1, with no elisions by default", () => {
    const ancestor = makeTicket({ name: "Ancestor" });
    const blocker = makeTicket({ name: "Blocker" });
    const session = makeSession("2026-07-23T09:00:00.000Z", "agent-a");
    const data = baseData({ ancestors: [ancestor], blockers: [blocker], sessions: [session] });

    const body = buildContextPackJson(data);

    expect(body.ticket.id).toBe(data.ticket.id);
    expect(body.ticket.slug).toBe(data.ticket.slug);
    expect(body.ticket.spec.summary).toBe(data.ticket.spec.summary);
    expect(body.ticket.spec.details_md).toBe(data.ticket.spec.details_md);
    expect(body.ancestry).toEqual([
      { id: ancestor.id, slug: ancestor.slug, name: ancestor.name, state: ancestor.state },
    ]);
    expect(body.blockers).toEqual([
      { id: blocker.id, slug: blocker.slug, name: blocker.name, state: blocker.state },
    ]);
    expect(body.sessions).toEqual([
      {
        id: session.id,
        actor: session.actor.name,
        harness: session.harness.kind,
        started_at: session.started_at,
        ended_at: session.ended_at,
      },
    ]);
    expect(body.external_parent_ref).toBeNull();
    expect(body.jira_url).toBeNull();
    expect(body.elided).toEqual([]);
  });

  it("passes given elisions straight through as `elided`", () => {
    const data = baseData();
    const body = buildContextPackJson(data, ["something was dropped"]);
    expect(body.elided).toEqual(["something was dropped"]);
  });

  it("external_parent_ref: present with a null jira_url when it isn't a jira: ref (or no jira remote configured)", () => {
    const data = baseData({ externalParentRef: "linear:ABC-1" });
    const body = buildContextPackJson(data);
    expect(body.external_parent_ref).toBe("linear:ABC-1");
    expect(body.jira_url).toBeNull();
  });

  it("jira_url: built from config.remotes.jira when externalParentRef is a matching jira: ref", () => {
    const jiraConfig = configSchema.parse({
      project: "p",
      remotes: { jira: "https://acme.atlassian.net" },
    });
    const data = baseData({ config: jiraConfig, externalParentRef: "jira:PROJ-123" });
    const body = buildContextPackJson(data);
    expect(body.external_parent_ref).toBe("jira:PROJ-123");
    expect(body.jira_url).toBe("https://acme.atlassian.net/browse/PROJ-123");
  });
});

describe("renderContextPackJsonWithBudget", () => {
  it("no budget given: returns the full JSON body unchanged, no elisions, valid JSON", () => {
    const data = baseData();
    const result = renderContextPackJsonWithBudget(data);
    expect(result.withinBudget).toBe(true);
    expect(result.body).toEqual(buildContextPackJson(data));
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  it("already under budget: returns the full JSON body unchanged", () => {
    const data = baseData();
    const full = renderContextPackJsonWithBudget(data);
    const result = renderContextPackJsonWithBudget(data, full.text.length + 500);
    expect(result.text).toBe(full.text);
    expect(result.withinBudget).toBe(true);
  });

  it("a budget that fits with sessions dropped but not details_md: drops the oldest session(s) first, valid JSON throughout", () => {
    const sessions = [
      makeSession("2026-07-23T09:00:00.000Z", "agent-newest"),
      makeSession("2026-07-22T09:00:00.000Z", "agent-middle"),
      makeSession("2026-07-21T09:00:00.000Z", "agent-oldest"),
    ];
    const data = baseData({
      ticket: makeTicket({ spec: specSchema.parse({ summary: "s" }) }),
      sessions,
    });
    const full = renderContextPackJsonWithBudget(data);

    let found: ReturnType<typeof renderContextPackJsonWithBudget> | null = null;
    for (let budget = full.text.length - 1; budget > 0; budget -= 10) {
      const result = renderContextPackJsonWithBudget(data, budget);
      if (result.body.sessions.length > 0 && result.body.sessions.length < sessions.length) {
        found = result;
        break;
      }
    }
    expect(found).not.toBeNull();
    const result = found as ReturnType<typeof renderContextPackJsonWithBudget>;

    expect(result.withinBudget).toBe(true);
    expect(() => JSON.parse(result.text)).not.toThrow();
    expect(result.body.elided.some((n) => /session/i.test(n))).toBe(true);
    // Newest session survives; oldest is elided first.
    expect(result.body.sessions.some((s) => s.id === sessions[0]?.id)).toBe(true);
    expect(result.body.sessions.some((s) => s.id === sessions[2]?.id)).toBe(false);
  });

  it("a tighter budget forces dropping ALL sessions and truncating spec.details_md via binary search, valid JSON, ticket core fields survive", () => {
    const sessions = [makeSession("2026-07-23T09:00:00.000Z", "agent-a")];
    const data = baseData({ sessions });
    const full = renderContextPackJsonWithBudget(data);
    const budget = Math.floor(full.text.length / 3);

    const result = renderContextPackJsonWithBudget(data, budget);
    expect(result.text.length).toBeLessThanOrEqual(budget);
    expect(result.withinBudget).toBe(true);
    expect(() => JSON.parse(result.text)).not.toThrow();
    expect(result.body.sessions).toEqual([]);
    expect(result.body.ticket.id).toBe(data.ticket.id);
    expect(result.body.elided.some((n) => /details_md truncated/.test(n))).toBe(true);
  });

  it("an absurdly small budget: falls all the way to the minimal-floor JSON body (core ticket fields only, no ancestry/blockers/sessions), still valid JSON, never exceeds budget when a fit exists", () => {
    const data = baseData({
      ancestors: [makeTicket({ name: "Ancestor" })],
      blockers: [makeTicket({ name: "Blocker" })],
      sessions: [makeSession("2026-07-23T09:00:00.000Z", "agent-a")],
    });

    const result = renderContextPackJsonWithBudget(data, 5);

    expect(() => JSON.parse(result.text)).not.toThrow();
    expect(result.body.ancestry).toEqual([]);
    expect(result.body.blockers).toEqual([]);
    expect(result.body.sessions).toEqual([]);
    expect(result.body.ticket.spec.details_md).toBe("");
    expect(result.body.ticket.id).toBe(data.ticket.id);
    expect(result.body.elided.some((n) => /ancestry\/blockers omitted/.test(n))).toBe(true);
    // The floor itself is small but non-negotiably valid JSON — it may
    // still exceed a genuinely pathological budget like 5, exactly per
    // core/budget.ts's documented "valid-but-over-budget beats
    // corrupt-but-under-budget" contract.
  });

  it("respects several different budgets end-to-end, always producing valid, parseable JSON", () => {
    const data = baseData({
      sessions: [
        makeSession("2026-07-23T09:00:00.000Z", "agent-a"),
        makeSession("2026-07-22T09:00:00.000Z", "agent-b"),
      ],
    });
    for (const budget of [10, 50, 150, 400, 1200, 5000]) {
      const result = renderContextPackJsonWithBudget(data, budget);
      expect(() => JSON.parse(result.text), `budget=${budget}`).not.toThrow();
    }
  });
});
