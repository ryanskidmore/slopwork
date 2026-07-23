/**
 * Shared "format a failed zod parse as an actionable CLI error" helper —
 * used by `new`/`update`/`edit` wherever a hand-assembled or hand-edited
 * candidate object fails {@link ticketSchema} validation. Mirrors
 * `src/repo/entity-file.ts`'s `formatZodIssues`, but that one is a private,
 * unexported function local to a `src/repo/` module this work item must
 * not edit (see the B1 brief's ground rules) — small enough (a handful of
 * lines) that duplicating the shape here is safer than reaching into a
 * file another lane owns for it.
 */
import type { z } from "zod";

/** One `<path>: <message>` line per zod issue. */
export function zodIssueLines(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  ${path}: ${issue.message}`;
  });
}

export function formatZodIssuesForUsage(prefix: string, error: z.ZodError): string {
  return [prefix, ...zodIssueLines(error)].join("\n");
}
