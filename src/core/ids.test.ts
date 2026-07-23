import { describe, expect, it } from "vitest";
import {
  eventIdSchema,
  idMatchesRef,
  isEventId,
  isSessionId,
  isTicketId,
  newEventId,
  newSessionId,
  newTicketId,
  parsePrefixedId,
  sessionIdSchema,
  ticketIdSchema,
} from "./ids.js";

describe("id generators", () => {
  it("newTicketId produces a valid ticket_<ULID> id", () => {
    const id = newTicketId();
    expect(id).toMatch(/^ticket_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isTicketId(id)).toBe(true);
    expect(ticketIdSchema.safeParse(id).success).toBe(true);
  });

  it("newSessionId produces a valid session_<ULID> id", () => {
    const id = newSessionId();
    expect(id).toMatch(/^session_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isSessionId(id)).toBe(true);
    expect(sessionIdSchema.safeParse(id).success).toBe(true);
  });

  it("newEventId produces a valid event_<ULID> id", () => {
    const id = newEventId();
    expect(id).toMatch(/^event_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isEventId(id)).toBe(true);
    expect(eventIdSchema.safeParse(id).success).toBe(true);
  });

  it("ids of one kind are never valid for another kind", () => {
    const ticket = newTicketId();
    expect(isSessionId(ticket)).toBe(false);
    expect(isEventId(ticket)).toBe(false);
  });
});

describe("id kind schemas reject malformed input", () => {
  it("rejects the wrong prefix", () => {
    expect(ticketIdSchema.safeParse(`session_${"0".repeat(26)}`).success).toBe(false);
  });
  it("rejects a short ULID body", () => {
    expect(ticketIdSchema.safeParse("ticket_01ARZ3").success).toBe(false);
  });
  it("rejects a ULID body with disallowed characters (I, L, O, U)", () => {
    expect(ticketIdSchema.safeParse(`ticket_${"I".repeat(26)}`).success).toBe(false);
  });
  it("rejects an unprefixed bare ULID", () => {
    expect(ticketIdSchema.safeParse("01ARZ3NDEKTSV4RRFFQ69G5FAV").success).toBe(false);
  });
});

describe("parsePrefixedId", () => {
  it("round-trips a freshly generated id", () => {
    const id = newTicketId();
    const parsed = parsePrefixedId(id);
    expect(parsed).not.toBeNull();
    expect(parsed?.kind).toBe("ticket");
    expect(id).toBe(`ticket_${parsed?.ulid}`);
  });

  it("returns null for a non-id string", () => {
    expect(parsePrefixedId("not-an-id")).toBeNull();
    expect(parsePrefixedId("jira:PROJ-123")).toBeNull();
    expect(parsePrefixedId("")).toBeNull();
  });
});

describe("idMatchesRef", () => {
  const id = newTicketId();
  const ulid = parsePrefixedId(id)?.ulid ?? "";

  it("matches the id verbatim", () => {
    expect(idMatchesRef(id, id)).toBe(true);
  });

  it("matches a short prefix that includes the kind", () => {
    expect(idMatchesRef(id, id.slice(0, "ticket_".length + 6))).toBe(true);
  });

  it("matches a short prefix of just the bare ULID (kind omitted)", () => {
    expect(idMatchesRef(id, ulid.slice(0, 6))).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(idMatchesRef(id, ulid.slice(0, 6).toLowerCase())).toBe(true);
  });

  it("does not match a ref naming a different id's prefix", () => {
    const other = newTicketId();
    // Extremely unlikely to collide given ULID entropy + monotonic time.
    expect(idMatchesRef(id, other.slice(0, "ticket_".length + 10))).toBe(false);
  });

  it("does not match a wrong kind prefix", () => {
    expect(idMatchesRef(id, `session_${ulid.slice(0, 6)}`)).toBe(false);
  });

  it("never matches an empty ref", () => {
    expect(idMatchesRef(id, "")).toBe(false);
  });
});

function isStrictlyIncreasing(values: readonly string[]): boolean {
  return values.every((value, index) => {
    if (index === 0) return true;
    const previous = values[index - 1];
    return previous !== undefined && value > previous;
  });
}

describe("monotonic ordering (event ordering cursors depend on this — design.md §3)", () => {
  it("ids generated in a tight sequential loop are strictly increasing as plain strings", () => {
    const ids: string[] = [];
    for (let i = 0; i < 500; i++) {
      ids.push(newEventId());
    }
    expect(isStrictlyIncreasing(ids)).toBe(true);
  });

  it("holds even across id kinds sharing the underlying sequence", () => {
    // Not a claim that ticket_/session_/event_ ids sort against each other
    // (different prefixes obviously don't) — just that generating an
    // interleaved mix never throws or produces a non-monotonic *raw* ULID
    // for a given kind's own subsequence.
    const tickets: string[] = [];
    const events: string[] = [];
    for (let i = 0; i < 200; i++) {
      tickets.push(newTicketId());
      events.push(newEventId());
    }
    expect(isStrictlyIncreasing(tickets)).toBe(true);
    expect(isStrictlyIncreasing(events)).toBe(true);
  });
});
