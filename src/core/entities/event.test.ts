import { describe, expect, it } from "vitest";
import { newEventId, newSessionId, newTicketId } from "../ids.js";
import { EVENT_VERBS, eventSchema, eventVerbSchema } from "./event.js";

function baseEvent() {
  return {
    id: newEventId(),
    actor: { name: "ryan", kind: "human" as const },
    session: null,
    verb: "ticket.created" as const,
    entity: { kind: "ticket" as const, id: newTicketId() },
    at: "2026-07-23T10:00:00.000Z",
  };
}

describe("eventSchema", () => {
  it("accepts a minimal event and defaults payload to {}", () => {
    const parsed = eventSchema.parse(baseEvent());
    expect(parsed.payload).toEqual({});
  });

  it("allows a null session (event not tied to any session)", () => {
    expect(eventSchema.safeParse({ ...baseEvent(), session: null }).success).toBe(true);
  });

  it("accepts a session id when the event is tied to one", () => {
    expect(eventSchema.safeParse({ ...baseEvent(), session: newSessionId() }).success).toBe(true);
  });

  it("carries an open-ended payload", () => {
    const parsed = eventSchema.parse({
      ...baseEvent(),
      verb: "ticket.state_changed",
      payload: { from: "open", to: "in_progress", re_entry: false },
    });
    expect(parsed.payload).toEqual({ from: "open", to: "in_progress", re_entry: false });
  });

  it("rejects an unknown verb", () => {
    expect(eventSchema.safeParse({ ...baseEvent(), verb: "ticket.exploded" }).success).toBe(false);
  });
});

describe("EVENT_VERBS — closed vocabulary covers every command-surface area", () => {
  it("is a closed, deduplicated set", () => {
    expect(new Set(EVENT_VERBS).size).toBe(EVENT_VERBS.length);
  });

  it("includes every verb the plan explicitly names as the minimum vocabulary", () => {
    // design.md-derived minimum: "ticket created/updated/state-changed/ready,
    // session started/stopped/ended, plan set/revised/step-checked,
    // review requested, ticket done/dropped, takeover".
    const required = [
      "ticket.created",
      "ticket.updated",
      "ticket.state_changed",
      "ticket.ready",
      "ticket.done",
      "ticket.dropped",
      "session.started",
      "session.stopped",
      "session.ended",
      "session.takeover",
      "plan.set",
      "plan.revised",
      "plan.step_checked",
      "review.requested",
    ] as const;
    for (const verb of required) {
      expect(EVENT_VERBS).toContain(verb);
      expect(eventVerbSchema.safeParse(verb).success).toBe(true);
    }
  });

  it("every verb parses as itself through the schema (no typos in the literal list)", () => {
    for (const verb of EVENT_VERBS) {
      expect(eventVerbSchema.parse(verb)).toBe(verb);
    }
  });
});
