import { monotonicFactory } from "ulid";
import { describe, expect, it } from "vitest";
import {
  eventIdSchema,
  idMatchesRef,
  isEventId,
  isSessionId,
  isShortTicketCodeRef,
  isTicketId,
  newEventId,
  newSessionId,
  newTicketId,
  parsePrefixedId,
  sessionIdSchema,
  SHORT_TICKET_CODE_LENGTH,
  shortTicketCode,
  ticketIdSchema,
} from "./ids.js";

/**
 * flaky-test-ids-test-ts: a seeded, fully deterministic stand-in for
 * `newTicketId()`'s real randomness, used ONLY by the collision-batch test
 * below. mulberry32 — a small, standard, seeded PRNG (`state` is the only
 * mutable bit of state, closed over) — matches the `ulid` package's own
 * `PRNG = () => number` contract (a float in `[0, 1)`, same as
 * `Math.random`), so `monotonicFactory(mulberry32(seed))` drives the SAME
 * production `ulid` code path `ids.ts`'s `nextRawUlid` uses, just with
 * reproducible "randomness" instead of real entropy.
 */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

describe("shortTicketCode (t-<code> short handles — ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1)", () => {
  it("is `t-<code>` shaped: a literal 't-' plus SHORT_TICKET_CODE_LENGTH lowercase base36 digits", () => {
    const id = newTicketId();
    const code = shortTicketCode(id);
    expect(code).toMatch(/^t-[0-9a-z]+$/);
    expect(code.length).toBe(2 + SHORT_TICKET_CODE_LENGTH); // "t-" + the digits
  });

  it("is deterministic: the same id always yields the same code, repeatedly and across calls", () => {
    const id = newTicketId();
    const first = shortTicketCode(id);
    for (let i = 0; i < 10; i++) {
      expect(shortTicketCode(id)).toBe(first);
    }
  });

  it("is stable for a fixed, hardcoded id — pins the derivation itself, not just 'it doesn't change'", () => {
    // A regression guard on the derivation scheme: if this ever starts
    // failing because the formula legitimately changed, that's exactly
    // the kind of change that would silently invalidate every
    // previously-shared t-<code> handle — worth a loud, obvious diff here.
    const id = "ticket_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(shortTicketCode(id)).toBe(shortTicketCode(id));
    expect(shortTicketCode(id)).toMatch(/^t-[0-9a-z]{5}$/);
    // Pins the actual derivation output (sha256-based — see ids.ts's
    // doc), not just "it's deterministic": a change to the formula that
    // still happens to be self-consistent would slip past the two
    // assertions above but not this one.
    expect(shortTicketCode(id)).toBe("t-szrdf");
  });

  it("distinct ids generally give distinct codes (no collisions across a realistic batch)", () => {
    // flaky-test-ids-test-ts: this used to draw 500 REAL newTicketId()
    // ULIDs (true randomness, no seed) — a genuine, if rare, birthday
    // -paradox false failure: P(collision) ≈ n²/2N for n=500 draws over
    // N=36^5≈60.5M codes is ~0.2% per run, so the suite occasionally failed
    // with no code regression at all. Fixed by generating the SAME 500
    // ULID-shaped ids every run instead: a LOCAL `ulid` monotonicFactory
    // (this module's real dependency, same code path `ids.ts`'s
    // `newTicketId` uses) seeded with a fixed PRNG (mulberry32 above) and
    // driven by explicit, strictly-increasing seed-times (never `Date.now()`
    // — see monotonicFactory's own source: an ascending explicit seedTime
    // always draws fresh "randomness" from the PRNG, so this never
    // degrades into the same-millisecond +1-increment path that would
    // depend on real wall-clock timing). Fully reproducible regardless of
    // system speed. `shortTicketCode` itself — the actual thing under test
    // — runs completely unchanged; only the id-generation SOURCE is now
    // deterministic instead of truly random.
    const nextId = monotonicFactory(mulberry32(0xc0ffee));
    const codes = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const id = `ticket_${nextId(1_700_000_000_000 + i)}`;
      codes.add(shortTicketCode(id));
    }
    // 36^5 ≈ 60.5M possible codes vs. 500 draws — collisions are not
    // impossible (refs.ts handles that rare case explicitly) but
    // shouldn't happen in a batch this small; a genuine formula bug
    // (e.g. collapsing everything to one bucket) would fail this hard.
    // Deterministic (see above), so this assertion's outcome is
    // reproducible forever, not a per-run coin flip.
    expect(codes.size).toBe(500);
  });

  it("a different id (even one differing by a single trailing character) yields a different code in practice", () => {
    const a = "ticket_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const b = "ticket_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    expect(shortTicketCode(a)).not.toBe(shortTicketCode(b));
  });
});

describe("isShortTicketCodeRef", () => {
  it("accepts a well-formed t-<code> ref", () => {
    expect(isShortTicketCodeRef("t-3f9a1")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isShortTicketCodeRef("T-3F9A1")).toBe(true);
  });

  it("rejects a real slug that merely starts with 't-' (precedence gate — refs.ts's module doc)", () => {
    expect(isShortTicketCodeRef("t-shirt-feature")).toBe(false);
  });

  it("rejects the wrong code length (too short or too long)", () => {
    expect(isShortTicketCodeRef("t-3f9")).toBe(false);
    expect(isShortTicketCodeRef("t-3f9a12")).toBe(false);
  });

  it("rejects a code containing characters outside [0-9a-z]", () => {
    expect(isShortTicketCodeRef("t-3f9a_")).toBe(false);
    expect(isShortTicketCodeRef("t-3f9a-")).toBe(false);
  });

  it("rejects a ref with no 't-' prefix at all", () => {
    expect(isShortTicketCodeRef("3f9a1")).toBe(false);
    expect(isShortTicketCodeRef("x-3f9a1")).toBe(false);
  });

  it("every shortTicketCode output satisfies its own shape predicate", () => {
    const code = shortTicketCode(newTicketId());
    expect(isShortTicketCodeRef(code)).toBe(true);
  });
});
