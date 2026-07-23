import { describe, expect, it } from "vitest";
import { configSchema, newTicketId, sessionSchema, ticketSchema } from "../core/index.js";
import type { Ticket } from "../core/index.js";
import { type ContextPackData, budgetCharsFromTokens, renderContextPack } from "./context.js";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "Do the thing", details_md: "Some detail.", acceptance: ["it works"] },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

const config = configSchema.parse({
  project: "p",
  remotes: { jira: "https://example.atlassian.net" },
});

describe("budgetCharsFromTokens", () => {
  it("uses a ~4 chars/token estimate", () => {
    expect(budgetCharsFromTokens(100)).toBe(400);
  });

  it("never goes negative", () => {
    expect(budgetCharsFromTokens(-5)).toBe(0);
  });
});

describe("renderContextPack", () => {
  const ticket = makeTicket();

  function baseData(overrides: Partial<ContextPackData> = {}): ContextPackData {
    return { ticket, config, ancestors: [], blockers: [], sessions: [], ...overrides };
  }

  it("includes the spec (summary, details_md, acceptance)", () => {
    const text = renderContextPack(baseData());
    expect(text).toContain("Do the thing");
    expect(text).toContain("Some detail.");
    expect(text).toContain("it works");
  });

  it("shows 'none' for blockers and sessions when there are none", () => {
    const text = renderContextPack(baseData());
    expect(text).toMatch(/Blockers[\s\S]*none/);
    expect(text).toMatch(/Prior sessions[\s\S]*none yet/);
  });

  it("lists live blockers", () => {
    const blocker = makeTicket({ name: "Blocking ticket", state: "in_progress" });
    const text = renderContextPack(baseData({ blockers: [blocker] }));
    expect(text).toContain("Blocking ticket");
  });

  it("renders the external parent ref with its jira browse URL", () => {
    const text = renderContextPack(baseData({ externalParentRef: "jira:PROJ-9" }));
    expect(text).toContain("jira:PROJ-9");
    expect(text).toContain("https://example.atlassian.net/browse/PROJ-9");
  });

  it("lists local ancestors", () => {
    const parent = makeTicket({ name: "Parent ticket", slug: "parent-ticket" });
    const text = renderContextPack(baseData({ ancestors: [parent] }));
    expect(text).toContain("Parent ticket");
    expect(text).toContain("parent-ticket");
  });

  it("renders sessions when present, structured for C1 to extend rather than rewrite", () => {
    const session = sessionSchema.parse({
      id: "session_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      ticket: ticket.id,
      actor: { name: "agent-1", kind: "agent" },
      harness: { kind: "claude-code", session_id: null },
      git: { branch: null, commit_at_start: null },
      started_at: "2026-07-23T09:00:00.000Z",
    });
    const text = renderContextPack(baseData({ sessions: [session] }));
    expect(text).toContain(session.id);
    expect(text).toContain("agent-1");
    expect(text).toContain("claude-code");
  });

  it("respects a char budget by truncating with a note", () => {
    const text = renderContextPack(baseData(), 50);
    expect(text.length).toBeLessThanOrEqual(50);
    expect(text).toContain("truncated");
  });

  it("does not truncate when under budget", () => {
    const full = renderContextPack(baseData());
    const text = renderContextPack(baseData(), full.length + 1000);
    expect(text).toBe(full);
  });
});
