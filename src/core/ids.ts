/**
 * Prefixed ULIDs (D6: "Full-length prefixed ULIDs + root_id + path +
 * short-prefix + slug resolution").
 *
 * Every entity id in the db is `<kind>_<ULID>` with the full 26-character
 * ULID — never truncated. ULIDs are lexicographically sortable by
 * creation time, which is load-bearing: event ordering cursors (design.md
 * §3, "Event ordering cursors on the event ULID itself") depend on
 * `event_<ulid>` ids sorting the same way chronologically and as plain
 * strings. All three id kinds share one monotonic sequence (see
 * `monotonicFactory` below) so that property holds even for ids minted
 * within the same millisecond.
 */
import { createHash } from "node:crypto";
import { monotonicFactory } from "ulid";
import { z } from "zod";

export const ID_KINDS = ["ticket", "session", "event"] as const;
export type IdKind = (typeof ID_KINDS)[number];

/**
 * Crockford base32, as the `ulid` package emits it: uppercase, 26
 * characters, excluding I/L/O/U to avoid visual ambiguity.
 */
const ULID_BODY_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";

function idPattern(kind: IdKind): RegExp {
  return new RegExp(`^${kind}_${ULID_BODY_PATTERN}$`);
}

export const ticketIdSchema = z
  .string()
  .regex(idPattern("ticket"), "expected ticket_<ULID>")
  .brand<"TicketId">();
export type TicketId = z.infer<typeof ticketIdSchema>;

export const sessionIdSchema = z
  .string()
  .regex(idPattern("session"), "expected session_<ULID>")
  .brand<"SessionId">();
export type SessionId = z.infer<typeof sessionIdSchema>;

export const eventIdSchema = z
  .string()
  .regex(idPattern("event"), "expected event_<ULID>")
  .brand<"EventId">();
export type EventId = z.infer<typeof eventIdSchema>;

/** Any of the three prefixed id types. */
export type PrefixedId = TicketId | SessionId | EventId;

export function isTicketId(value: string): value is TicketId {
  return idPattern("ticket").test(value);
}
export function isSessionId(value: string): value is SessionId {
  return idPattern("session").test(value);
}
export function isEventId(value: string): value is EventId {
  return idPattern("event").test(value);
}

/**
 * One monotonic ULID sequence shared by every kind of id. `monotonicFactory`
 * guarantees strictly-increasing output even when called repeatedly within
 * the same millisecond (it bumps the random component instead of
 * colliding) — see ids.test.ts's "monotonic ordering" test. Sharing one
 * factory across kinds is deliberate and harmless: a subsequence of a
 * strictly-increasing sequence is itself strictly increasing, so ids
 * *within* one kind (e.g. all `event_*` ids, which is what the cursor
 * ordering actually needs) stay monotonic regardless of what other kinds
 * of ids were minted in between.
 */
const nextRawUlid = monotonicFactory();

export function newTicketId(): TicketId {
  return `ticket_${nextRawUlid()}` as TicketId;
}
export function newSessionId(): SessionId {
  return `session_${nextRawUlid()}` as SessionId;
}
export function newEventId(): EventId {
  return `event_${nextRawUlid()}` as EventId;
}

export interface ParsedId {
  kind: IdKind;
  ulid: string;
}

const PARSE_PATTERN = new RegExp(`^(${ID_KINDS.join("|")})_(${ULID_BODY_PATTERN})$`);

/** Extract the kind and raw ULID from a prefixed id, or `null` if it isn't one. */
export function parsePrefixedId(value: string): ParsedId | null {
  const match = PARSE_PATTERN.exec(value);
  const kind = match?.[1];
  const ulid = match?.[2];
  if (kind === undefined || ulid === undefined) return null;
  return { kind: kind as IdKind, ulid };
}

/**
 * Short-prefix ref matching (B1/A3: "resolve refs by unique short
 * prefix"). This predicate only answers "could `ref` name `id`" — it says
 * nothing about uniqueness. A3 is responsible for collecting every id in
 * the db this returns `true` for and raising the git-style "ambiguous
 * ref" error (design.md §8.1 item 5) when more than one matches; A2 only
 * supplies the matching rule itself.
 *
 * A ref matches an id (case-insensitively) if it is a prefix of either:
 *   - the id verbatim, including its `<kind>_` prefix (e.g. `ticket_01ARZ`), or
 *   - the bare ULID portion, with the kind prefix omitted (e.g. `01ARZ`) —
 *     this is how humans usually type a short ref.
 * An empty ref never matches anything.
 */
export function idMatchesRef(id: PrefixedId, ref: string): boolean {
  if (ref.length === 0) return false;
  const refLower = ref.toLowerCase();
  if (id.toLowerCase().startsWith(refLower)) return true;
  const parsed = parsePrefixedId(id);
  return parsed?.ulid.toLowerCase().startsWith(refLower) ?? false;
}

/**
 * Short ticket handles (`t-<code>` — ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1: "a
 * short, stable, typeable handle per ticket ... that resolves to the
 * ticket"). Deliberately **derived, not stored**: `shortTicketCode` is a
 * pure function of a ticket's own id, so the handle is stable for the
 * ticket's whole lifetime (the id itself is immutable) without adding a
 * stored schema field or any migration — `repo/refs.ts` recomputes it for
 * every ticket in the index at resolution time, exactly like `idMatchesRef`
 * above already does for short-prefix matching.
 *
 * Derivation: sha256(id) — id is already unique and unpredictable-ish
 * (ULID = timestamp + randomness), so this is only being used to spread a
 * lexicographically-clustered value (tickets created seconds apart share a
 * long common prefix) into a short, uniform, human-typeable space; it is
 * not a security boundary and doesn't need to be. The first 8 digest bytes
 * are read as a big-endian unsigned integer, reduced mod 36^5, and
 * rendered as {@link SHORT_TICKET_CODE_LENGTH} lowercase base-36 digits
 * (`0-9a-z`), zero-padded. 36^5 ≈ 60.5M possible codes: for any
 * repo-scale ticket count a collision between two real tickets is
 * vanishingly unlikely, but `refs.ts` still treats it as a proper
 * git-style ambiguous-ref error (never a silent pick-one) when it does
 * happen — see this ticket's acceptance criteria.
 */
export const SHORT_TICKET_CODE_LENGTH = 5;
const SHORT_TICKET_CODE_SPACE = 36n ** BigInt(SHORT_TICKET_CODE_LENGTH);

/** Derive `t-<code>`'s code portion from `id` (see the derivation notes
 * above). Deterministic and pure — same `id` always yields the same code,
 * with no I/O and no dependency on anything but `id` itself. */
export function shortTicketCode(id: string): string {
  const digest = createHash("sha256").update(id).digest();
  let value = 0n;
  for (const byte of digest.subarray(0, 8)) {
    value = (value << 8n) | BigInt(byte);
  }
  const code = (value % SHORT_TICKET_CODE_SPACE)
    .toString(36)
    .padStart(SHORT_TICKET_CODE_LENGTH, "0");
  return `t-${code}`;
}

/**
 * Exact shape a ref must have (case-insensitively) to even be CONSIDERED a
 * short-code ref by `repo/refs.ts` — `t-` followed by exactly
 * {@link SHORT_TICKET_CODE_LENGTH} lowercase base-36 digits, nothing more,
 * nothing less. This is deliberately an exact-length gate, not a loose
 * `/^t-/` prefix sniff: a real slug like `t-shirt-feature` (many more than
 * five characters after the hyphen, and itself containing further hyphens)
 * never matches this shape, so it's never even a candidate for code
 * resolution — it resolves purely as a slug (refs.ts's slug step already
 * runs first regardless, so this is belt-and-suspenders, not the only
 * thing preventing the shadow).
 */
export const SHORT_TICKET_CODE_PATTERN = new RegExp(`^t-[0-9a-z]{${SHORT_TICKET_CODE_LENGTH}}$`);

/** Case-insensitive {@link SHORT_TICKET_CODE_PATTERN} test. */
export function isShortTicketCodeRef(ref: string): boolean {
  return SHORT_TICKET_CODE_PATTERN.test(ref.toLowerCase());
}
