/**
 * fast-check arbitraries for A2's entity schemas, deliberately adversarial
 * per the plan's acceptance criterion (`v0-implementation-plan.md` §3,
 * A2): multi-line markdown with quotes/backslashes/tabs/code fences,
 * unicode names, empty arrays, and absent optional fields are all
 * represented, not just "happy path" values. Not a test file itself
 * (doesn't match `*.test.ts`) — imported by A2.test.ts.
 *
 * Each arbitrary produces its raw shape via `fc.record`, then funnels it
 * through the real zod schema's `.parse()` so every generated entity is
 * schema-valid *and* has real defaults applied exactly the way A3's
 * callers will see them, rather than a hand-maintained parallel model
 * that could drift from the schema.
 */
import fc from "fast-check";
import {
  type Config,
  type Event,
  EVENT_VERBS,
  eventSchema,
  HARNESS_KINDS,
  newEventId,
  newSessionId,
  newTicketId,
  PROVENANCE_METHODS,
  type Session,
  sessionSchema,
  slugify,
  type Ticket,
  TICKET_STATES,
  ticketSchema,
  configSchema,
} from "../../src/core/index.js";

/** Wrap a pure id generator (newTicketId, etc.) as an arbitrary producing a fresh id per sample. */
function idArbitrary<T extends string>(generate: () => T): fc.Arbitrary<T> {
  return fc.integer({ min: 0, max: 1_000_000 }).map(() => generate());
}

const ticketIdArb = idArbitrary(newTicketId);
const sessionIdArb = idArbitrary(newSessionId);
const eventIdArb = idArbitrary(newEventId);

const isoTimestampArb = fc
  .date({
    min: new Date("2000-01-01T00:00:00.000Z"),
    max: new Date("2100-01-01T00:00:00.000Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

const actorNameArb = fc.string({ minLength: 1, maxLength: 60 }).filter((s) => s.trim().length > 0);
const actorArb = fc.record({
  name: actorNameArb,
  kind: fc.constantFrom("human", "agent"),
});

/** Adversarial markdown fragments — quotes, backslashes, tabs, fenced code, unicode. */
const MARKDOWN_FRAGMENTS = [
  "line one\nline two",
  "quotes: \"double\" and 'single'",
  "backslash: \\ and \\\\ and \\n literal (not a real newline)",
  "tab:\tindented\tcell",
  "```ts\nconst x: number = 1;\nfunction f() { return x; }\n```",
  "unicode: héllo wörld 世界 🎉 — em dash and curly quotes “like this”",
  "trailing whitespace line   \nand another\t\n",
  "",
] as const;
const markdownFragmentArb = fc.constantFrom(...MARKDOWN_FRAGMENTS);

const detailsMdArb = fc.oneof(
  fc.array(markdownFragmentArb, { minLength: 1, maxLength: 6 }).map((parts) => parts.join("\n\n")),
  fc.string({ maxLength: 300 }),
);

const UNICODE_NAME_FRAGMENTS = [
  "héllo wörld",
  "日本語のチケット",
  "emoji 🎉🔥 title",
  "Ångström Ticket",
  "café — résumé",
] as const;
const nameArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
  fc.constantFrom(...UNICODE_NAME_FRAGMENTS),
);

/**
 * A hand-rolled JSON-value arbitrary rather than fast-check's own
 * `fc.jsonValue()`, for two reasons found empirically while writing this
 * property test (both are fundamental to JSON/JS, not bugs in A2's
 * serialization code — worth generating around rather than working
 * around in every assertion):
 *
 *  1. JSON has no way to represent negative zero (`JSON.stringify(-0) ===
 *     "0"`), so a round-trip that started from a `-0` correctly comes
 *     back as `0` — `fc.double()` (which `fc.jsonValue()` uses
 *     internally) can generate `-0`. Using `fc.integer()` for numbers
 *     sidesteps this (and general float-precision noise) entirely.
 *  2. `fc.jsonValue()`'s own object-key generation can produce
 *     `"__proto__"` as a key. Plain object construction (which is what a
 *     JSON round-trip does under the hood, both when *this* generator
 *     builds its fixtures and when `JSON.parse`/`jsonc.parse` rebuild the
 *     value) treats `obj["__proto__"] = x` as setting the prototype
 *     link, not a normal own property — so it silently fails to round
 *     -trip. `jsonKeyArb` below excludes it (and `constructor` /
 *     `prototype`, the same family of footgun) at generation time.
 */
const jsonKeyArb = fc
  .string({ minLength: 1, maxLength: 15 })
  .filter(
    (s) => s.trim().length > 0 && s !== "__proto__" && s !== "constructor" && s !== "prototype",
  );

function jsonValueArbitrary(depth: number): fc.Arbitrary<unknown> {
  const primitive = fc.oneof(
    fc.string({ maxLength: 30 }),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
  );
  if (depth <= 0) return primitive;
  return fc.oneof(
    { weight: 3, arbitrary: primitive },
    { weight: 1, arbitrary: fc.array(jsonValueArbitrary(depth - 1), { maxLength: 3 }) },
    {
      weight: 1,
      arbitrary: fc.dictionary(jsonKeyArb, jsonValueArbitrary(depth - 1), { maxKeys: 3 }),
    },
  );
}
const jsonValueArb = jsonValueArbitrary(2);

const metaArb = fc.dictionary(jsonKeyArb, jsonValueArb, { maxKeys: 4 });

/** `acceptance`/`context`/generic string-array fields, including the empty-array case (default minLength 0). */
const stringArrayArb = fc.array(fc.string({ minLength: 1, maxLength: 60 }), { maxLength: 5 });

const specArb = fc.record({
  summary: nameArb,
  details_md: detailsMdArb,
  acceptance: stringArrayArb,
  context: stringArrayArb,
  meta: metaArb,
  v: fc.integer({ min: 1, max: 5 }),
});

const labelArb = fc.oneof(
  fc.constantFrom("area:auth", "type:feature", "type:bug", "priority:p1", "needs-review"),
  fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
);

const NON_REVIEW_STATES = TICKET_STATES.filter((s) => s !== "review");

/** `mr` is deliberately sometimes absent — D15: a ticket can enter review without one. */
const reviewObjectArb = fc.record({
  mr: fc.oneof(fc.constant(undefined), fc.webUrl()),
  requested_at: isoTimestampArb,
  by: actorArb,
});

/**
 * Correlates `state` and `review` the way the schema's own refine
 * requires (D15: review present iff state === "review") instead of
 * generating them independently and mostly failing validation.
 */
const stateAndReviewArb: fc.Arbitrary<{ state: Ticket["state"]; review: Ticket["review"] }> =
  fc.oneof(
    fc.constantFrom(...NON_REVIEW_STATES).map((state) => ({ state, review: undefined })),
    reviewObjectArb.map((review) => ({ state: "review" as const, review })),
  );

/** Absent, local, or external (D1) — including a deliberately malformed jira key (§8.2 item 5: warn, never block). */
const parentArb = fc.oneof(
  fc.constant(undefined),
  ticketIdArb,
  fc.constantFrom("jira:PROJ-1", "jira:ABC-42", "jira:notaproperkey"),
);

const provenanceArb = fc.record({
  method: fc.constantFrom(...PROVENANCE_METHODS),
  created_by: actorArb,
  split_from: fc.oneof(fc.constant(undefined), ticketIdArb),
});

/** Raw ticket shapes -> real {@link Ticket} values, always by way of `ticketSchema.parse`. */
export const ticketArbitrary: fc.Arbitrary<Ticket> = fc
  .record({
    id: ticketIdArb,
    name: nameArb,
    slug: fc.string({ maxLength: 30 }).map(slugify),
    spec: specArb,
    priority: fc.integer({ min: 0, max: 3 }),
    labels: fc.array(labelArb, { maxLength: 5 }),
    adhoc: fc.boolean(),
    parent: parentArb,
    blocks: fc.array(ticketIdArb, { maxLength: 4 }),
    relates_to: fc.array(ticketIdArb, { maxLength: 4 }),
    discovered_from: fc.array(ticketIdArb, { maxLength: 4 }),
    root_id: ticketIdArb,
    path: fc.array(ticketIdArb, { maxLength: 4 }),
    active_session: fc.oneof(fc.constant(null), sessionIdArb),
    last_activity_at: isoTimestampArb,
    latest_note: fc.oneof(fc.constant(null), fc.string({ maxLength: 200 })),
    owner: fc.oneof(fc.constant(null), actorArb),
    provenance: provenanceArb,
    created_at: isoTimestampArb,
    updated_at: isoTimestampArb,
    stateAndReview: stateAndReviewArb,
  })
  .map(({ stateAndReview, ...rest }) =>
    ticketSchema.parse({ ...rest, state: stateAndReview.state, review: stateAndReview.review }),
  );

const harnessArb = fc.record({
  kind: fc.constantFrom(...HARNESS_KINDS),
  session_id: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 40 })),
});
const gitArb = fc.record({
  branch: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 60 })),
  commit_at_start: fc.oneof(fc.constant(null), fc.stringMatching(/^[0-9a-f]{40}$/)),
});
const planStepArb = fc.record({
  text: fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
  checked: fc.boolean(),
});
const planVersionArb = fc.record({
  version: fc.integer({ min: 1, max: 5 }),
  steps: fc.array(planStepArb, { maxLength: 5 }),
  created_at: isoTimestampArb,
});

export const sessionArbitrary: fc.Arbitrary<Session> = fc
  .record({
    id: sessionIdArb,
    ticket: ticketIdArb,
    actor: actorArb,
    harness: harnessArb,
    git: gitArb,
    started_at: isoTimestampArb,
    ended_at: fc.oneof(fc.constant(null), isoTimestampArb),
    plan: fc.array(planVersionArb, { maxLength: 3 }),
    end_summary: fc.oneof(fc.constant(null), detailsMdArb),
  })
  .map((raw) => sessionSchema.parse(raw));

const eventEntityArb = fc.oneof(
  ticketIdArb.map((id) => ({ kind: "ticket" as const, id })),
  sessionIdArb.map((id) => ({ kind: "session" as const, id })),
);
const payloadArb = fc.dictionary(jsonKeyArb, jsonValueArb, { maxKeys: 4 });

export const eventArbitrary: fc.Arbitrary<Event> = fc
  .record({
    id: eventIdArb,
    actor: actorArb,
    session: fc.oneof(fc.constant(null), sessionIdArb),
    verb: fc.constantFrom(...EVENT_VERBS),
    entity: eventEntityArb,
    payload: payloadArb,
    at: isoTimestampArb,
  })
  .map((raw) => eventSchema.parse(raw));

const remotesArb = fc.record({
  repo: fc.oneof(fc.constant(undefined), fc.webUrl()),
  jira: fc.oneof(fc.constant(undefined), fc.constant(""), fc.webUrl()),
});
const defaultsArb = fc.record({
  stale_after: fc.constantFrom("30m", "60m", "90m", "2h"),
  review_stale_after: fc.constantFrom("12h", "24h", "48h", "3d"),
});

export const configArbitrary: fc.Arbitrary<Config> = fc
  .record({
    project: fc.string({ minLength: 1, maxLength: 40 }).filter((s) => s.trim().length > 0),
    user: fc.oneof(fc.constant(undefined), actorNameArb),
    remotes: remotesArb,
    defaults: defaultsArb,
  })
  .map((raw) => configSchema.parse(raw));

/** Any one of the four entity kinds A2 owns, for tests that don't care which. */
export const anyEntityArbitrary: fc.Arbitrary<Ticket | Session | Event | Config> = fc.oneof(
  ticketArbitrary,
  sessionArbitrary,
  eventArbitrary,
  configArbitrary,
);
