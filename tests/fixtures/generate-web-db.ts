#!/usr/bin/env bun
/**
 * Generates the committed fixture db at tests/fixtures/web-db/.slop/ that
 * D5's views and acceptance test run against (design.md §3's layout:
 * `config.yaml`, `db/{tickets,sessions,events}/*.jsonc`,
 * `transcripts/*.jsonl`).
 *
 * Every entity is built through the real A2 zod schemas (`ticketSchema`,
 * `sessionSchema`, `eventSchema`, `configSchema`) and written with the
 * real `writeCanonical` — so a fixture can't drift from the shapes those
 * schemas define. This is a one-off generator, not run by the test suite;
 * re-run it by hand (`bun run tests/fixtures/generate-web-db.ts`) after
 * touching the story below. tests/acceptance/D5.test.ts separately
 * re-parses and re-validates every committed file against the same
 * schemas, so the fixtures can't silently rot even if this script is
 * never run again.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Actor,
  type Config,
  type Event,
  type EventEntity,
  type EventVerb,
  type Session,
  type Ticket,
  type TicketId,
  configSchema,
  eventSchema,
  newEventId,
  newSessionId,
  newTicketId,
  sessionSchema,
  ticketSchema,
  writeCanonical,
} from "../../src/core/index.js";
import { FIXTURE_NOW_ISO } from "./web-db-meta.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, "web-db", ".slop");

const NOW_MS = Date.parse(FIXTURE_NOW_ISO);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** ISO timestamp `offsetMs` away from the fixture's fictional "now" (negative = in the past). */
function at(offsetMs: number): string {
  return new Date(NOW_MS + offsetMs).toISOString();
}

const RYAN: Actor = { name: "ryan", kind: "human" };
const AGENT_1: Actor = { name: "claude-agent-1", kind: "agent" };
const AGENT_2: Actor = { name: "claude-agent-2", kind: "agent" };
const OPENCODE_AGENT: Actor = { name: "opencode-agent", kind: "agent" };
const CODEX_AGENT: Actor = { name: "codex-agent", kind: "agent" };

const tickets: Ticket[] = [];
const sessions: Session[] = [];
const events: Event[] = [];

function addEvent(
  entity: EventEntity,
  verb: EventVerb,
  actor: Actor,
  session: string | null,
  offsetMs: number,
  payload: Record<string, unknown> = {},
): void {
  events.push(
    eventSchema.parse({
      id: newEventId(),
      actor,
      session,
      verb,
      entity,
      payload,
      at: at(offsetMs),
    }),
  );
}

interface TicketSpec {
  name: string;
  slug: string;
  summary: string;
  details_md?: string;
  acceptance?: string[];
  context?: string[];
  meta?: Record<string, unknown>;
  state: Ticket["state"];
  priority: number;
  labels?: string[];
  adhoc?: boolean;
  owner?: Actor | null;
  parent?: string;
  blocks?: TicketId[];
  /** `discovered-from` edges (design.md §4.1 item 2 / §4.7 item 1: "bugs found mid-session — exists as a ticket before it's worked, discovered-from chains visible in web"). */
  discoveredFrom?: TicketId[];
  lastActivityOffsetMs: number;
  createdOffsetMs: number;
  review?: { mr?: string; requestedOffsetMs: number; by: Actor };
  provenanceMethod?: "new" | "split" | "draft" | "adhoc";
  /** Who created the ticket (provenance.created_by) — independent of `owner`, which may be null (unowned/unassigned). Defaults to RYAN. */
  createdBy?: Actor;
}

function makeTicket(spec: TicketSpec, rootId?: TicketId, path: TicketId[] = []): Ticket {
  const id = newTicketId();
  const ticket = ticketSchema.parse({
    id,
    name: spec.name,
    slug: spec.slug,
    spec: {
      summary: spec.summary,
      details_md: spec.details_md ?? "",
      acceptance: spec.acceptance ?? [],
      context: spec.context ?? [],
      meta: spec.meta ?? {},
    },
    state: spec.state,
    review:
      spec.state === "review" && spec.review
        ? {
            mr: spec.review.mr,
            requested_at: at(spec.review.requestedOffsetMs),
            by: spec.review.by,
          }
        : undefined,
    priority: spec.priority,
    labels: spec.labels ?? [],
    adhoc: spec.adhoc ?? false,
    parent: spec.parent,
    blocks: spec.blocks ?? [],
    discovered_from: spec.discoveredFrom ?? [],
    root_id: rootId ?? id,
    path,
    active_session: null,
    last_activity_at: at(spec.lastActivityOffsetMs),
    latest_note: null,
    owner: spec.owner === undefined ? RYAN : spec.owner,
    provenance: {
      method: spec.provenanceMethod ?? "new",
      created_by: spec.createdBy ?? RYAN,
    },
    created_at: at(spec.createdOffsetMs),
    updated_at: at(spec.lastActivityOffsetMs),
  });
  tickets.push(ticket);
  return ticket;
}

// ---------------------------------------------------------------------------
// Tree A: a human-owned root with a 3-level local tree beneath it.
// ---------------------------------------------------------------------------

const rootAlpha = makeTicket({
  name: "Add authentication provider",
  slug: "add-authentication-provider",
  summary: "Support pluggable auth providers so self-hosters aren't stuck with the built-in one.",
  details_md:
    "## Why\n\nSeveral self-hosters have asked for OAuth/SSO support. This is the umbrella ticket for that work.\n\n- Keep the built-in provider as the default\n- New providers register through one interface\n",
  acceptance: ["At least one OAuth provider works end to end", "Existing auth is unaffected"],
  context: ["https://github.com/ryan/slopworks-fixture/discussions/12"],
  meta: { estimated_days: 5, epic: "auth-2026" },
  state: "open",
  priority: 1,
  labels: ["auth"],
  lastActivityOffsetMs: -10 * DAY,
  createdOffsetMs: -10 * DAY,
});
addEvent({ kind: "ticket", id: rootAlpha.id }, "ticket.created", RYAN, null, -10 * DAY);

const designAuthInterface = makeTicket(
  {
    name: "Design auth provider interface",
    slug: "design-auth-provider-interface",
    summary: "Land the TypeScript interface every provider (built-in and third-party) implements.",
    state: "done",
    priority: 1,
    labels: ["auth"],
    parent: rootAlpha.id,
    lastActivityOffsetMs: -8 * DAY - 20 * HOUR,
    createdOffsetMs: -9 * DAY,
  },
  rootAlpha.id,
  [rootAlpha.id],
);
addEvent({ kind: "ticket", id: designAuthInterface.id }, "ticket.created", RYAN, null, -9 * DAY);
// (session ids referenced below are minted further down, in narrative order — see s5a/s5b.)

const implementOauth = makeTicket(
  {
    name: "Implement OAuth provider",
    slug: "implement-oauth-provider",
    summary: "Build the first third-party provider (OAuth 2.0 / OIDC) against the new interface.",
    details_md: "Uses `openid-client` under the hood. See design doc linked in context.",
    context: ["design doc: (link redacted in fixture)"],
    state: "in_progress",
    priority: 1,
    labels: ["auth"],
    parent: rootAlpha.id,
    blocks: [], // filled below once add-oauth-tests exists
    lastActivityOffsetMs: -5 * MIN,
    createdOffsetMs: -6 * DAY,
  },
  rootAlpha.id,
  [rootAlpha.id],
);
addEvent({ kind: "ticket", id: implementOauth.id }, "ticket.created", RYAN, null, -6 * DAY);

const addOauthTests = makeTicket(
  {
    name: "Add OAuth provider unit tests",
    slug: "add-oauth-provider-unit-tests",
    summary: "Unit tests for the OAuth provider once the implementation lands.",
    state: "open",
    priority: 2,
    labels: ["auth", "testing"],
    parent: implementOauth.id,
    lastActivityOffsetMs: -6 * DAY,
    createdOffsetMs: -6 * DAY,
    provenanceMethod: "split",
  },
  rootAlpha.id,
  [rootAlpha.id, implementOauth.id],
);
addEvent({ kind: "ticket", id: addOauthTests.id }, "ticket.created", RYAN, null, -6 * DAY, {
  split_from: implementOauth.id,
});
// implementOauth blocks addOauthTests (D5/DECISIONS.md A2: `X.blocks = [Y]` reads "X blocks Y").
implementOauth.blocks.push(addOauthTests.id);

const addSsoDocs = makeTicket(
  {
    name: "Add SSO login docs",
    slug: "add-sso-login-docs",
    summary: "User-facing docs for configuring an SSO provider once one exists.",
    state: "draft",
    priority: 3,
    labels: ["auth", "docs"],
    parent: rootAlpha.id,
    lastActivityOffsetMs: -2 * DAY,
    createdOffsetMs: -2 * DAY,
    provenanceMethod: "draft",
  },
  rootAlpha.id,
  [rootAlpha.id],
);
addEvent({ kind: "ticket", id: addSsoDocs.id }, "ticket.created", RYAN, null, -2 * DAY);

// ---------------------------------------------------------------------------
// Session S1: implement-oauth-provider — claude-code, multi-version plan,
// fresh activity, the "big" transcript (every record/block kind, long
// enough to paginate).
// ---------------------------------------------------------------------------

const s1Id = newSessionId();
const s1: Session = sessionSchema.parse({
  id: s1Id,
  ticket: implementOauth.id,
  actor: AGENT_1,
  harness: { kind: "claude-code", session_id: "c1a55555-0000-4a11-8888-abcdef012345" },
  git: { branch: "feature/oauth-provider", commit_at_start: "a1b2c3d4" },
  started_at: at(-3 * HOUR),
  ended_at: null,
  plan: [
    {
      version: 1,
      steps: [
        { text: "Read the provider interface", checked: true },
        { text: "Wire up openid-client", checked: true },
        { text: "Handle token refresh", checked: false },
      ],
      created_at: at(-3 * HOUR),
    },
    {
      version: 2,
      steps: [
        { text: "Read the provider interface", checked: true },
        { text: "Wire up openid-client", checked: true },
        { text: "Handle token refresh", checked: true },
        { text: "Add config validation for missing client secret", checked: false },
        { text: "Update AGENTS.md with the new provider", checked: false },
      ],
      created_at: at(-45 * MIN),
    },
  ],
  end_summary: null,
  transcript_ref: `transcripts/${s1Id}.jsonl`,
});
sessions.push(s1);
addEvent({ kind: "session", id: s1.id }, "session.started", AGENT_1, s1.id, -3 * HOUR, {
  harness: "claude-code",
});
addEvent(
  { kind: "ticket", id: implementOauth.id },
  "ticket.state_changed",
  AGENT_1,
  s1.id,
  -3 * HOUR,
  { from: "open", to: "in_progress" },
);
addEvent({ kind: "session", id: s1.id }, "plan.set", AGENT_1, s1.id, -3 * HOUR + 2 * MIN, {
  version: 1,
  steps: 3,
});
addEvent({ kind: "ticket", id: implementOauth.id }, "ticket.updated", AGENT_1, s1.id, -2 * HOUR, {
  progress: "openid-client wired up against the built-in provider's interface.",
});
addEvent({ kind: "session", id: s1.id }, "plan.revised", AGENT_1, s1.id, -45 * MIN, {
  version: 2,
  steps: 5,
});
addEvent({ kind: "session", id: s1.id }, "plan.step_checked", AGENT_1, s1.id, -40 * MIN, {
  version: 2,
  step: 2,
  checked: true,
});
addEvent({ kind: "ticket", id: implementOauth.id }, "ticket.updated", AGENT_1, s1.id, -5 * MIN, {
  progress: "Token refresh works against a live test IdP; writing config validation next.",
});

// ---------------------------------------------------------------------------
// Tree B: a local root whose *own* parent is external (jira:) — D1: the
// external parent terminates the local tree, so this ticket is itself a
// local root, badged rather than nested under a traversable Jira node.
// ---------------------------------------------------------------------------

const migrateBilling = makeTicket({
  name: "Migrate billing to new provider",
  slug: "migrate-billing-to-new-provider",
  summary: "Move billing off the sunset-ing payment processor before the Q3 shutoff.",
  details_md: "Tracked upstream as jira:PROJ-123. This ticket is the local execution tracker.",
  state: "in_progress",
  priority: 0,
  labels: ["billing"],
  parent: "jira:PROJ-123",
  lastActivityOffsetMs: -5 * HOUR,
  createdOffsetMs: -4 * DAY,
});
addEvent({ kind: "ticket", id: migrateBilling.id }, "ticket.created", RYAN, null, -4 * DAY, {
  parent: "jira:PROJ-123",
});

const billingRunbook = makeTicket(
  {
    name: "Write billing migration runbook",
    slug: "write-billing-migration-runbook",
    summary: "Step-by-step runbook for the cutover weekend.",
    state: "open",
    priority: 1,
    labels: ["billing", "docs"],
    parent: migrateBilling.id,
    lastActivityOffsetMs: -4 * DAY,
    createdOffsetMs: -4 * DAY,
  },
  migrateBilling.id,
  [migrateBilling.id],
);
addEvent({ kind: "ticket", id: billingRunbook.id }, "ticket.created", RYAN, null, -4 * DAY);

// Session S2: migrate-billing — opencode, single-version plan, STALE
// (last activity 5h ago > stale_after 60m), no transcript captured
// (S2/D16: an expected, non-fatal case — opencode's session id and
// transcript locator are both null-by-default per spikes/findings.md §1.2/§3.2).
const s2Id = newSessionId();
const s2: Session = sessionSchema.parse({
  id: s2Id,
  ticket: migrateBilling.id,
  actor: OPENCODE_AGENT,
  harness: { kind: "opencode", session_id: null },
  git: { branch: "fix/billing-migration", commit_at_start: "d4e5f6a7" },
  started_at: at(-6 * HOUR),
  ended_at: null,
  plan: [
    {
      version: 1,
      steps: [
        { text: "Inventory every call site touching the old billing SDK", checked: true },
        { text: "Add the new provider behind a feature flag", checked: false },
        { text: "Dual-write invoices for one billing cycle", checked: false },
        { text: "Flip the flag and monitor", checked: false },
      ],
      created_at: at(-6 * HOUR),
    },
  ],
  end_summary: null,
  transcript_ref: null,
});
sessions.push(s2);
addEvent({ kind: "session", id: s2.id }, "session.started", OPENCODE_AGENT, s2.id, -6 * HOUR, {
  harness: "opencode",
});
addEvent(
  { kind: "ticket", id: migrateBilling.id },
  "ticket.state_changed",
  OPENCODE_AGENT,
  s2.id,
  -6 * HOUR,
  { from: "open", to: "in_progress" },
);
addEvent({ kind: "session", id: s2.id }, "plan.set", OPENCODE_AGENT, s2.id, -6 * HOUR + MIN, {
  version: 1,
  steps: 4,
});
addEvent(
  { kind: "ticket", id: migrateBilling.id },
  "ticket.updated",
  OPENCODE_AGENT,
  s2.id,
  -5 * HOUR,
  { progress: "Inventory done — 14 call sites, list attached to the ticket notes." },
);

// ---------------------------------------------------------------------------
// Standalone roots.
// ---------------------------------------------------------------------------

const fixFlakyCi = makeTicket({
  name: "Fix flaky CI on windows runners",
  slug: "fix-flaky-ci-on-windows-runners",
  summary: "windows-latest CI job fails ~1 in 5 runs during the cleanup step.",
  state: "done",
  priority: 2,
  labels: ["ci", "bug"],
  lastActivityOffsetMs: -1 * DAY - 20 * HOUR,
  createdOffsetMs: -2 * DAY,
});
addEvent({ kind: "ticket", id: fixFlakyCi.id }, "ticket.created", RYAN, null, -2 * DAY);
addEvent(
  { kind: "ticket", id: fixFlakyCi.id },
  "ticket.done",
  CODEX_AGENT,
  null,
  -1 * DAY - 20 * HOUR,
);

const s3Id = newSessionId();
const s3: Session = sessionSchema.parse({
  id: s3Id,
  ticket: fixFlakyCi.id,
  actor: CODEX_AGENT,
  harness: { kind: "codex", session_id: null },
  git: { branch: "fix/ci-flaky-windows", commit_at_start: "9f8e7d6c" },
  started_at: at(-2 * DAY),
  ended_at: at(-1 * DAY - 20 * HOUR),
  plan: [
    {
      version: 1,
      steps: [
        { text: "Reproduce locally with a Windows runner", checked: true },
        { text: "Bisect to the cleanup step race", checked: true },
        { text: "Add retry with backoff, verify 10x green", checked: true },
      ],
      created_at: at(-2 * DAY),
    },
  ],
  end_summary:
    "Root-caused a race in the windows runner cleanup step (a lock file wasn't always released before the next job started); added a retry with backoff. CI green x10 locally.",
  transcript_ref: `transcripts/${s3Id}.jsonl`,
});
sessions.push(s3);
addEvent({ kind: "session", id: s3.id }, "session.started", CODEX_AGENT, s3.id, -2 * DAY, {
  harness: "codex",
});
addEvent(
  { kind: "ticket", id: fixFlakyCi.id },
  "ticket.state_changed",
  CODEX_AGENT,
  s3.id,
  -2 * DAY,
  { from: "open", to: "in_progress" },
);
addEvent({ kind: "session", id: s3.id }, "plan.set", CODEX_AGENT, s3.id, -2 * DAY + 5 * MIN, {
  version: 1,
  steps: 3,
});
addEvent(
  { kind: "session", id: s3.id },
  "session.ended",
  CODEX_AGENT,
  s3.id,
  -1 * DAY - 20 * HOUR,
  { reason: "done" },
);

// design-auth-provider-interface's session history: a first agent session
// that got handed off unfinished, then a human takeover that finished it —
// exercising a ticket with more than one session, and the "other" harness
// kind (session.takeover, D9 §5.4: "explicit logged takeovers").
const s5aId = newSessionId();
const s5a: Session = sessionSchema.parse({
  id: s5aId,
  ticket: designAuthInterface.id,
  actor: AGENT_1,
  harness: { kind: "claude-code", session_id: "c1a5face-0001-4a11-8888-abcdef011111" },
  git: { branch: "feature/auth-provider-interface", commit_at_start: "00ff11ee" },
  started_at: at(-9 * DAY),
  ended_at: at(-8 * DAY - 20 * HOUR),
  plan: [
    {
      version: 1,
      steps: [
        { text: "Sketch two candidate interface shapes", checked: true },
        { text: "Write a recommendation", checked: true },
      ],
      created_at: at(-9 * DAY),
    },
  ],
  end_summary:
    "Explored two interface shapes; handing off with a recommendation in the ticket notes.",
  transcript_ref: null,
});
sessions.push(s5a);
addEvent({ kind: "session", id: s5a.id }, "session.started", AGENT_1, s5a.id, -9 * DAY, {
  harness: "claude-code",
});
addEvent(
  { kind: "ticket", id: designAuthInterface.id },
  "ticket.state_changed",
  AGENT_1,
  s5a.id,
  -9 * DAY + HOUR,
  { from: "open", to: "in_progress" },
);
addEvent({ kind: "session", id: s5a.id }, "plan.set", AGENT_1, s5a.id, -9 * DAY + 5 * MIN, {
  version: 1,
  steps: 2,
});
addEvent(
  { kind: "session", id: s5a.id },
  "session.stopped",
  AGENT_1,
  s5a.id,
  -8 * DAY - 20 * HOUR,
  { note: "Handing off with a written recommendation; two viable shapes, no strong preference." },
);
addEvent(
  { kind: "ticket", id: designAuthInterface.id },
  "ticket.state_changed",
  AGENT_1,
  s5a.id,
  -8 * DAY - 20 * HOUR,
  { from: "in_progress", to: "open", reason: "handoff" },
);

// Second session on design-auth-provider-interface: a human, harness
// "other" — exercises the 4th harness kind and a non-agent actor on a
// session (design.md allows either actor kind everywhere an Actor is
// referenced). Finishes what S5a left off.
const s5bId = newSessionId();
const s5b: Session = sessionSchema.parse({
  id: s5bId,
  ticket: designAuthInterface.id,
  actor: RYAN,
  harness: { kind: "other", session_id: null },
  git: { branch: "feature/auth-provider-interface", commit_at_start: "112200aa" },
  started_at: at(-8 * DAY),
  ended_at: at(-7 * DAY),
  plan: [
    {
      version: 1,
      steps: [
        { text: "Finalize the provider interface shape", checked: true },
        { text: "Write ADR", checked: true },
        { text: "Get sign-off and merge", checked: true },
      ],
      created_at: at(-8 * DAY),
    },
  ],
  end_summary: "Finalized the interface directly (no harness) after the agent handoff; merged.",
  transcript_ref: null,
});
sessions.push(s5b);
addEvent({ kind: "session", id: s5b.id }, "session.started", RYAN, s5b.id, -8 * DAY, {
  harness: "other",
  takeover: true,
});
addEvent({ kind: "session", id: s5b.id }, "session.takeover", RYAN, s5b.id, -8 * DAY, {
  from_session: s5a.id,
});
addEvent(
  { kind: "ticket", id: designAuthInterface.id },
  "ticket.state_changed",
  RYAN,
  s5b.id,
  -8 * DAY,
  { from: "open", to: "in_progress", re_entry: false },
);
addEvent({ kind: "session", id: s5b.id }, "session.ended", RYAN, s5b.id, -7 * DAY, {
  reason: "done",
});
addEvent({ kind: "ticket", id: designAuthInterface.id }, "ticket.done", RYAN, s5b.id, -7 * DAY);

const prototypeVectorSearch = makeTicket({
  name: "Prototype vector search for ticket search",
  slug: "prototype-vector-search-for-ticket-search",
  summary: "Spike embeddings-based search as an alternative to naive `slop search`.",
  state: "dropped",
  priority: 3,
  labels: ["research"],
  owner: null,
  lastActivityOffsetMs: -5 * DAY,
  createdOffsetMs: -6 * DAY,
});
addEvent({ kind: "ticket", id: prototypeVectorSearch.id }, "ticket.created", RYAN, null, -6 * DAY);
addEvent({ kind: "ticket", id: prototypeVectorSearch.id }, "ticket.dropped", RYAN, null, -5 * DAY, {
  reason: "Superseded by SlopQL (F6) — real search covers this without an embeddings index.",
});

const refactorCliErrors = makeTicket({
  name: "Refactor CLI error reporting",
  slug: "refactor-cli-error-reporting",
  summary: "Consolidate error formatting so every command reports failures the same way.",
  state: "review",
  priority: 2,
  labels: ["cli"],
  lastActivityOffsetMs: -10 * MIN,
  createdOffsetMs: -1 * DAY,
  review: {
    mr: "https://github.com/ryan/slopworks-fixture/pull/42",
    requestedOffsetMs: -10 * MIN,
    by: AGENT_1,
  },
});
addEvent({ kind: "ticket", id: refactorCliErrors.id }, "ticket.created", RYAN, null, -1 * DAY);
addEvent(
  { kind: "ticket", id: refactorCliErrors.id },
  "ticket.state_changed",
  AGENT_1,
  null,
  -2 * HOUR,
  { from: "open", to: "in_progress" },
);
addEvent(
  { kind: "ticket", id: refactorCliErrors.id },
  "review.requested",
  AGENT_1,
  null,
  -10 * MIN,
  { mr: "https://github.com/ryan/slopworks-fixture/pull/42" },
);

const s6Id = newSessionId();
const s6: Session = sessionSchema.parse({
  id: s6Id,
  ticket: refactorCliErrors.id,
  actor: AGENT_1,
  harness: { kind: "claude-code", session_id: "c1a5refa-c001-4a11-8888-abcdef099999" },
  git: { branch: "refactor/cli-error-reporting", commit_at_start: "55aa66bb" },
  started_at: at(-2 * HOUR),
  ended_at: at(-10 * MIN),
  plan: [
    {
      version: 1,
      steps: [
        { text: "Audit every command's current error path", checked: true },
        { text: "Introduce SlopError everywhere it's missing", checked: true },
        { text: "Normalize exit codes against src/core/exit-codes.ts", checked: true },
        { text: "Open MR", checked: true },
      ],
      created_at: at(-2 * HOUR),
    },
  ],
  end_summary: "All commands now throw SlopError; exit codes match the table in the README. MR up.",
  transcript_ref: `transcripts/${s6Id}.jsonl`,
});
sessions.push(s6);
addEvent({ kind: "session", id: s6.id }, "session.started", AGENT_1, s6.id, -2 * HOUR, {
  harness: "claude-code",
});
addEvent({ kind: "session", id: s6.id }, "plan.set", AGENT_1, s6.id, -2 * HOUR + 3 * MIN, {
  version: 1,
  steps: 4,
});
addEvent({ kind: "session", id: s6.id }, "session.ended", AGENT_1, s6.id, -10 * MIN, {
  reason: "review",
});

const darkModeWeb = makeTicket({
  name: "Add dark mode to slop web",
  slug: "add-dark-mode-to-slop-web",
  summary: "Respect prefers-color-scheme in the read-only web explorer.",
  state: "review",
  priority: 2,
  labels: ["web"],
  lastActivityOffsetMs: -3 * DAY,
  createdOffsetMs: -5 * DAY,
  review: {
    mr: "https://github.com/ryan/slopworks-fixture/pull/37",
    requestedOffsetMs: -3 * DAY,
    by: AGENT_2,
  },
});
addEvent({ kind: "ticket", id: darkModeWeb.id }, "ticket.created", RYAN, null, -5 * DAY);
addEvent({ kind: "ticket", id: darkModeWeb.id }, "review.requested", AGENT_2, null, -3 * DAY, {
  mr: "https://github.com/ryan/slopworks-fixture/pull/37",
});

const investigateMemLeak = makeTicket({
  name: "Investigate memory leak in event writer",
  slug: "investigate-memory-leak-in-event-writer",
  summary: "RSS climbs steadily during a long `slop events --since` watch loop.",
  state: "open",
  priority: 0,
  labels: ["bug", "perf"],
  adhoc: true,
  owner: null,
  discoveredFrom: [implementOauth.id],
  createdBy: AGENT_1,
  lastActivityOffsetMs: -30 * MIN,
  createdOffsetMs: -30 * MIN,
  provenanceMethod: "adhoc",
});
addEvent(
  { kind: "ticket", id: investigateMemLeak.id },
  "ticket.created",
  AGENT_1,
  s1Id,
  -30 * MIN,
  { method: "adhoc", discovered_from: implementOauth.id },
);

const draftGraphqlGateway = makeTicket({
  name: "Draft: explore GraphQL gateway",
  slug: "draft-explore-graphql-gateway",
  summary: "Would a GraphQL gateway simplify the eventual MCP/HTTP API surface (F5/F8)?",
  state: "draft",
  priority: 3,
  labels: ["research"],
  owner: null,
  lastActivityOffsetMs: -12 * HOUR,
  createdOffsetMs: -12 * HOUR,
  provenanceMethod: "draft",
});
addEvent({ kind: "ticket", id: draftGraphqlGateway.id }, "ticket.created", RYAN, null, -12 * HOUR);

const dogfoodRetro = makeTicket({
  name: "Write v0 dogfood retro doc",
  slug: "write-v0-dogfood-retro-doc",
  summary: "Capture what broke and what worked during the v0 dogfood week (§4.7).",
  state: "open",
  priority: 2,
  labels: ["docs"],
  lastActivityOffsetMs: -1 * DAY,
  createdOffsetMs: -1 * DAY,
});
addEvent({ kind: "ticket", id: dogfoodRetro.id }, "ticket.created", RYAN, null, -1 * DAY);

const oldSlackIdea = makeTicket({
  name: "Old idea: Slack integration",
  slug: "old-idea-slack-integration",
  summary: "Post ticket state changes to a Slack channel.",
  state: "dropped",
  priority: 3,
  labels: ["idea"],
  owner: null,
  lastActivityOffsetMs: -20 * DAY,
  createdOffsetMs: -25 * DAY,
});
addEvent({ kind: "ticket", id: oldSlackIdea.id }, "ticket.created", RYAN, null, -25 * DAY);
addEvent({ kind: "ticket", id: oldSlackIdea.id }, "ticket.dropped", RYAN, null, -20 * DAY, {
  reason: "No fleet features (D11) — out of scope for v0 and beyond.",
});

const staleIndexBuilder = makeTicket({
  name: "Rewrite index builder for incremental updates",
  slug: "rewrite-index-builder-incremental",
  summary: "index.jsonc rebuild is O(n) on every write; make it incremental.",
  state: "in_progress",
  priority: 1,
  labels: ["perf"],
  lastActivityOffsetMs: -2 * DAY,
  createdOffsetMs: -3 * DAY,
});
addEvent({ kind: "ticket", id: staleIndexBuilder.id }, "ticket.created", RYAN, null, -3 * DAY);

const s4Id = newSessionId();
const s4: Session = sessionSchema.parse({
  id: s4Id,
  ticket: staleIndexBuilder.id,
  actor: AGENT_2,
  harness: { kind: "claude-code", session_id: "c1a5dead-beef-4a11-8888-abcdef054321" },
  git: { branch: "refactor/index-builder", commit_at_start: "1122334a" },
  started_at: at(-2 * DAY),
  ended_at: null,
  plan: [
    {
      version: 1,
      steps: [
        { text: "Profile the current rebuild to confirm the O(n) claim", checked: true },
        { text: "Design an append-only delta format", checked: true },
        { text: "Implement delta application on read", checked: false },
        { text: "Implement delta compaction", checked: false },
        { text: "Benchmark against the current implementation", checked: false },
        { text: "Migrate `reindex` to use it", checked: false },
      ],
      created_at: at(-2 * DAY),
    },
  ],
  end_summary: null,
  transcript_ref: null,
});
sessions.push(s4);
addEvent({ kind: "session", id: s4.id }, "session.started", AGENT_2, s4.id, -2 * DAY, {
  harness: "claude-code",
});
addEvent(
  { kind: "ticket", id: staleIndexBuilder.id },
  "ticket.state_changed",
  AGENT_2,
  s4.id,
  -2 * DAY,
  { from: "open", to: "in_progress" },
);
addEvent({ kind: "session", id: s4.id }, "plan.set", AGENT_2, s4.id, -2 * DAY + 10 * MIN, {
  version: 1,
  steps: 6,
});
addEvent({ kind: "ticket", id: staleIndexBuilder.id }, "ticket.updated", AGENT_2, s4.id, -2 * DAY, {
  progress: "Confirmed: full rebuild scales linearly with total ticket count, not just deltas.",
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const config: Config = configSchema.parse({
  project: "slopworks-fixture",
  user: "ryan",
  remotes: {
    repo: "https://github.com/ryan/slopworks-fixture",
    jira: "https://fixtureorg.atlassian.net",
  },
  defaults: {
    stale_after: "60m",
    review_stale_after: "24h",
  },
  transcripts: "local",
});

// ---------------------------------------------------------------------------
// Transcripts (spikes/findings.md §4 record/block shapes)
// ---------------------------------------------------------------------------

interface RawRecord {
  [key: string]: unknown;
}

function baseFields(sessionId: string, gitBranch: string, offsetMs: number): RawRecord {
  return {
    uuid: `${sessionId}-${Math.abs(offsetMs)}`,
    parentUuid: null,
    sessionId,
    isSidechain: false,
    userType: "external",
    cwd: "/home/ryan/projects/slopworks-fixture",
    version: "1.2.3",
    timestamp: at(offsetMs),
    gitBranch,
  };
}

function buildBigTranscript(): RawRecord[] {
  const branch = "feature/oauth-provider";
  const records: RawRecord[] = [];
  let t = -3 * HOUR;
  const step = 2 * MIN;

  records.push({
    type: "file-history-snapshot",
    ...baseFields(s1Id, branch, t),
    snapshot: { files: [] },
  });
  t += step;

  records.push({
    type: "user",
    ...baseFields(s1Id, branch, t),
    message: {
      role: "user",
      content:
        "Let's implement the OAuth provider described in the ticket. Start by reading the provider interface.",
    },
  });
  t += step;

  records.push({
    type: "assistant",
    ...baseFields(s1Id, branch, t),
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        {
          type: "thinking",
          thinking:
            "I should read src/auth/provider.ts first to see the interface shape before writing anything.",
        },
        {
          type: "tool_use",
          id: "tu_01",
          name: "Read",
          input: { file_path: "src/auth/provider.ts" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1200, output_tokens: 80 },
    },
  });
  t += step;

  records.push({
    type: "user",
    ...baseFields(s1Id, branch, t),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_01",
          content: [
            {
              type: "text",
              text: "export interface AuthProvider {\n  id: string;\n  authorize(req: Request): Promise<AuthResult>;\n  refresh(token: string): Promise<AuthResult>;\n}\n",
            },
          ],
        },
      ],
    },
  });
  t += step;

  records.push({
    type: "mode",
    ...baseFields(s1Id, branch, t),
    mode: "default",
  });
  t += step;

  records.push({
    type: "assistant",
    ...baseFields(s1Id, branch, t),
    message: {
      id: "msg_02",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        {
          type: "text",
          text:
            "Got it — the interface needs `authorize` and `refresh`. I'll wire up `openid-client` " +
            "for the OAuth flow and implement both methods against it. Let me check what's already " +
            "in the repo for OAuth-adjacent code.",
        },
        {
          type: "tool_use",
          id: "tu_02",
          name: "Grep",
          input: { pattern: "openid-client", path: "src" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 1400, output_tokens: 140 },
    },
  });
  t += step;

  // A deliberately long tool_result — this is the fixture's "long tool_result" case.
  const longOutput = Array.from(
    { length: 400 },
    (_, i) => `src/auth/oauth/candidate-${i}.ts:${i + 1}: // TODO scaffold ${i}`,
  ).join("\n");
  records.push({
    type: "user",
    ...baseFields(s1Id, branch, t),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_02", content: longOutput }],
    },
  });
  t += step;

  records.push({
    type: "system",
    ...baseFields(s1Id, branch, t),
    isMeta: true,
    subtype: "compact_boundary",
    durationMs: 4210,
    messageCount: 6,
  });
  t += step;

  // A conversational back-and-forth long enough to force pagination
  // (default page size is 40 records; this generates well over that).
  const topics = [
    "wiring the authorize() flow",
    "handling the refresh token rotation",
    "adding config validation for a missing client secret",
    "writing the provider registration docs",
    "double-checking error handling for a revoked token",
  ];
  for (let i = 0; i < 24; i++) {
    const topic = topics[i % topics.length];
    records.push({
      type: "user",
      ...baseFields(s1Id, branch, t),
      message: { role: "user", content: `Continue with ${topic}, step ${i + 1}.` },
    });
    t += step;
    records.push({
      type: "assistant",
      ...baseFields(s1Id, branch, t),
      message: {
        id: `msg_loop_${i}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [
          {
            type: "text",
            text: `Working on ${topic} (iteration ${i + 1}). Applying the change now.`,
          },
          {
            type: "tool_use",
            id: `tu_loop_${i}`,
            name: "Edit",
            input: {
              file_path: "src/auth/oauth/provider.ts",
              old_string: "// TODO",
              new_string: "// done",
            },
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 900 + i, output_tokens: 60 + i },
      },
    });
    t += step;
    records.push({
      type: "user",
      ...baseFields(s1Id, branch, t),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: `tu_loop_${i}`,
            content: "File updated successfully.",
          },
        ],
      },
    });
    t += step;
  }

  records.push({
    type: "last-prompt",
    ...baseFields(s1Id, branch, t),
    prompt: "internal bookkeeping, not conversational",
  });
  t += step;

  records.push({
    type: "assistant",
    ...baseFields(s1Id, branch, t),
    message: {
      id: "msg_final",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        {
          type: "text",
          text:
            "Token refresh now works against a live test IdP. Next up: config validation for a " +
            "missing client secret, then updating AGENTS.md with the new provider.",
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 500, output_tokens: 90 },
    },
  });

  return records;
}

function buildSmallTranscript(sessionId: string, branch: string): RawRecord[] {
  let t = -2 * DAY;
  const step = 5 * MIN;
  const records: RawRecord[] = [];
  records.push({
    type: "user",
    ...baseFields(sessionId, branch, t),
    message: {
      role: "user",
      content: "The windows CI job is flaky in the cleanup step. Can you dig in?",
    },
  });
  t += step;
  records.push({
    type: "assistant",
    ...baseFields(sessionId, branch, t),
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "gpt-5-codex",
      content: [
        { type: "thinking", thinking: "Likely a race on a lock file during parallel job cleanup." },
        {
          type: "tool_use",
          id: "tu_01",
          name: "Bash",
          input: { command: "grep -R cleanup .github/workflows" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 600, output_tokens: 70 },
    },
  });
  t += step;
  records.push({
    type: "user",
    ...baseFields(sessionId, branch, t),
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_01",
          content: ".github/workflows/ci.yml:88:      - name: cleanup\n",
        },
      ],
    },
  });
  t += step;
  records.push({
    type: "assistant",
    ...baseFields(sessionId, branch, t),
    message: {
      id: "msg_02",
      type: "message",
      role: "assistant",
      model: "gpt-5-codex",
      content: [
        {
          type: "text",
          text: "Found it: the cleanup step doesn't wait for the lock file to release before the next job starts. Adding a retry with backoff.",
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 300, output_tokens: 50 },
    },
  });
  return records;
}

function buildReviewTranscript(sessionId: string, branch: string): RawRecord[] {
  let t = -2 * HOUR;
  const step = 10 * MIN;
  const records: RawRecord[] = [];
  records.push({
    type: "user",
    ...baseFields(sessionId, branch, t),
    message: {
      role: "user",
      content: "Consolidate every command's error reporting into SlopError.",
    },
  });
  t += step;
  records.push({
    type: "assistant",
    ...baseFields(sessionId, branch, t),
    message: {
      id: "msg_01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        { type: "text", text: "Auditing every command's current error path first." },
        {
          type: "tool_use",
          id: "tu_01",
          name: "Grep",
          input: { pattern: "throw new Error", path: "src/cli" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 700, output_tokens: 60 },
    },
  });
  t += step;
  records.push({
    type: "user",
    ...baseFields(sessionId, branch, t),
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_01", content: "3 matches across 3 files." },
      ],
    },
  });
  t += step;
  records.push({
    type: "assistant",
    ...baseFields(sessionId, branch, t),
    message: {
      id: "msg_02",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-5",
      content: [
        {
          type: "text",
          text: "All three now throw SlopError with the right exit code. Opening the MR.",
        },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 250, output_tokens: 40 },
    },
  });
  return records;
}

// ---------------------------------------------------------------------------
// Write everything out.
// ---------------------------------------------------------------------------

async function writeJsonc(dir: string, id: string, value: unknown): Promise<void> {
  await Bun.write(join(dir, `${id}.jsonc`), writeCanonical(value));
}

async function writeJsonl(path: string, records: RawRecord[]): Promise<void> {
  const text = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  await Bun.write(path, text);
}

async function main(): Promise<void> {
  await rm(fixtureRoot, { recursive: true, force: true });
  const ticketsDir = join(fixtureRoot, "db", "tickets");
  const sessionsDir = join(fixtureRoot, "db", "sessions");
  const eventsDir = join(fixtureRoot, "db", "events");
  const transcriptsDir = join(fixtureRoot, "transcripts");
  await mkdir(ticketsDir, { recursive: true });
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(eventsDir, { recursive: true });
  await mkdir(transcriptsDir, { recursive: true });

  // Re-validate every ticket now that cross-references (e.g. `blocks`) were mutated after creation.
  for (const ticket of tickets) {
    const revalidated = ticketSchema.parse(ticket);
    await writeJsonc(ticketsDir, ticket.id, revalidated);
  }
  for (const session of sessions) {
    await writeJsonc(sessionsDir, session.id, session);
  }
  for (const event of events) {
    await writeJsonc(eventsDir, event.id, event);
  }
  const configYaml = Bun.YAML.stringify(config, null, 2);
  await Bun.write(
    join(fixtureRoot, "config.yaml"),
    configYaml.endsWith("\n") ? configYaml : `${configYaml}\n`,
  );

  await writeJsonl(join(transcriptsDir, `${s1Id}.jsonl`), buildBigTranscript());
  await writeJsonl(
    join(transcriptsDir, `${s3Id}.jsonl`),
    buildSmallTranscript(s3Id, "fix/ci-flaky-windows"),
  );
  await writeJsonl(
    join(transcriptsDir, `${s6Id}.jsonl`),
    buildReviewTranscript(s6Id, "refactor/cli-error-reporting"),
  );

  console.log(
    `Wrote ${tickets.length} tickets, ${sessions.length} sessions, ${events.length} events`,
  );
  console.log(`Fixture db: ${fixtureRoot}`);
}

await main();
