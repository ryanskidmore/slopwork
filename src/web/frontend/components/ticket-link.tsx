import { Link } from "react-router-dom";
import type { TicketRefDTO } from "../../api/types.js";
import { StateBadge } from "./state-badge.js";

/** A link to a ticket's detail page — used everywhere a relationship/edge
 * points at another ticket. `withState` shows the compact state pill next
 * to the name, matching how relationship lists read on the old
 * server-rendered ticket-detail page. */
export function TicketLink({
  ticket,
  withState = false,
}: {
  ticket: TicketRefDTO;
  withState?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {withState && <StateBadge state={ticket.state} />}
      <Link to={`/tickets/${ticket.id}`} className="underline-offset-2 hover:underline">
        {ticket.name}
      </Link>
    </span>
  );
}

/** A dangling ref (id not present in this db) — inert text, never a link. */
export function DanglingRefText({ id }: { id: string }) {
  return (
    <span className="font-mono text-xs text-muted-foreground" title="Not present in this db">
      {id}
    </span>
  );
}
