import type { RefOrDanglingDTO } from "../../api/types.js";
import { DanglingRefText, TicketLink } from "./ticket-link.js";

/** Renders a list of relationship targets (blocks/blocked-by/relates-to/
 * discovered-from/discovered-here) — each either a resolved ticket link or
 * inert dangling text, comma-separated. */
export function RefList({
  refs,
  withState = true,
}: {
  refs: RefOrDanglingDTO[];
  withState?: boolean;
}) {
  if (refs.length === 0) {
    return <span className="text-sm text-muted-foreground">none</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
      {refs.map((r, i) => (
        <span key={`${r.kind}-${r.ref.id}-${i}`} className="inline-flex items-center">
          {i > 0 && <span className="mr-1.5 text-muted-foreground">,</span>}
          {r.kind === "ref" ? (
            <TicketLink ticket={r.ref} withState={withState} />
          ) : (
            <DanglingRefText id={r.ref.id} />
          )}
        </span>
      ))}
    </span>
  );
}
