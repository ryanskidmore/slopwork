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
