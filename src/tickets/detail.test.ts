import { describe, expect, it } from "vitest";
import { configSchema, newTicketId, ticketSchema } from "../core/index.js";
import type { Ticket } from "../core/index.js";
import { formatTicketDetail } from "./detail.js";

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "Do the thing" },
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
const noJiraConfig = configSchema.parse({ project: "p" });

describe("formatTicketDetail", () => {
  it("includes every §4.1 field the B1 brief names", () => {
    const t = makeTicket({
      labels: ["bug", "type:feature"],
      priority: 1,
      owner: { name: "ryan", kind: "human" },
      spec: {
        summary: "Summary text",
        details_md: "Detail body",
        acceptance: ["A1"],
        context: ["ctx1"],
        meta: {},
        v: 1,
      },
      latest_note: "made progress",
      blocks: [newTicketId()],
    });
    const text = formatTicketDetail(t, config);
    expect(text).toContain(t.id);
    expect(text).toContain(t.slug);
    expect(text).toContain(t.name);
    expect(text).toContain("state: open");
    expect(text).toContain("priority: 1");
    expect(text).toContain("bug");
    expect(text).toContain("type:feature");
    expect(text).toContain("ryan (human)");
    expect(text).toContain("Summary text");
    expect(text).toContain("Detail body");
    expect(text).toContain("A1");
    expect(text).toContain("ctx1");
    expect(text).toContain("made progress");
    expect(text).toContain(t.created_at);
    expect(text).toContain(t.updated_at);
    expect(text).toContain(t.last_activity_at);
    expect(text).toContain(t.blocks[0] as string);
  });

  it("renders a local parent as local, with no URL", () => {
    const parentId = newTicketId();
    const t = makeTicket({ parent: parentId, root_id: parentId, path: [parentId] });
    const text = formatTicketDetail(t, config);
    expect(text).toContain(`parent: ${parentId}`);
    expect(text).toContain("(local)");
  });

  it('renders a jira: parent as external, with the browse URL when remotes.jira is configured (acceptance clause: "jira: parent renders in show")', () => {
    const t = makeTicket({ parent: "jira:PROJ-123" });
    const text = formatTicketDetail(t, config);
    expect(text).toContain("parent: jira:PROJ-123");
    expect(text).toContain("(external)");
    expect(text).toContain("https://example.atlassian.net/browse/PROJ-123");
  });

  it("renders a jira: parent without a URL when remotes.jira is not configured", () => {
    const t = makeTicket({ parent: "jira:PROJ-123" });
    const text = formatTicketDetail(t, noJiraConfig);
    expect(text).toContain("parent: jira:PROJ-123");
    expect(text).not.toContain("http");
  });

  it("renders 'no parent' for a true root", () => {
    const t = makeTicket();
    const text = formatTicketDetail(t, config);
    expect(text).toMatch(/parent: \(none/);
  });

  it("renders the review sub-object when present", () => {
    const t = makeTicket({
      state: "review",
      review: {
        mr: "https://example.com/mr/1",
        requested_at: "2026-07-23T11:00:00.000Z",
        by: { name: "ryan", kind: "human" },
      },
    });
    const text = formatTicketDetail(t, config);
    expect(text).toContain("review:");
    expect(text).toContain("https://example.com/mr/1");
  });
});
