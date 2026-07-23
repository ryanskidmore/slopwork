/**
 * Ticket parent refs: either a local `ticket_<ULID>` or an external ref
 * like `jira:PROJ-123` (D1: "External parents from day one" — external
 * parents terminate the local tree, so D1's "human owner at the root"
 * resolves purely against the local db).
 */
import { z } from "zod";
import { type TicketId, isTicketId, ticketIdSchema } from "../ids.js";

/**
 * `<system>:<key>`. Deliberately loose at the schema level so an
 * out-of-format `jira:` ref is still structurally a valid parent and
 * never blocks ticket creation — format *quality* is a separate, warn
 * -only check (see {@link checkJiraRefFormat}).
 */
export const EXTERNAL_REF_PATTERN = /^[a-z][a-z0-9-]*:.+$/;
export const externalRefSchema = z
  .string()
  .regex(EXTERNAL_REF_PATTERN, "expected <system>:<key>, e.g. jira:PROJ-123");
export type ExternalRef = z.infer<typeof externalRefSchema>;

export const parentRefSchema = z.union([ticketIdSchema, externalRefSchema]);
export type ParentRef = z.infer<typeof parentRefSchema>;

export type ParsedParentRef =
  | { kind: "local"; raw: string; ticketId: TicketId }
  | { kind: "external"; raw: string; system: string; key: string };

/** Discriminate a parent ref into its local-ticket or external-system shape. */
export function parseParentRef(raw: string): ParsedParentRef {
  if (isTicketId(raw)) {
    return { kind: "local", raw, ticketId: raw };
  }
  const colon = raw.indexOf(":");
  if (colon <= 0) {
    throw new Error(`invalid parent ref: "${raw}" (expected ticket_<ULID> or <system>:<key>)`);
  }
  return { kind: "external", raw, system: raw.slice(0, colon), key: raw.slice(colon + 1) };
}

const JIRA_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

export interface JiraRefCheck {
  ok: boolean;
  warning?: string;
}

/**
 * design.md §8.2 item 5: "`jira:` ref validation — warn on format
 * mismatch, don't block." Only meaningful for refs whose system is
 * literally "jira"; every other ref (local ticket ids, other external
 * systems) is always `ok`. Callers (B1) are expected to print `warning`
 * to the user and proceed regardless of `ok`.
 */
export function checkJiraRefFormat(raw: string): JiraRefCheck {
  const parsed = parseParentRef(raw);
  if (parsed.kind !== "external" || parsed.system !== "jira") {
    return { ok: true };
  }
  if (JIRA_KEY_PATTERN.test(parsed.key)) {
    return { ok: true };
  }
  return {
    ok: false,
    warning: `"${raw}" doesn't look like a typical Jira key (expected "jira:PROJ-123"); continuing anyway`,
  };
}
