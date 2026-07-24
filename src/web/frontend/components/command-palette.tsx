/**
 * Cmd/Ctrl-K command palette — "jump to ticket by id/slug/handle" (design
 * direction's named shadcn piece). Loads the ticket list lazily on first
 * open (fine at v0 scale — hundreds, not millions, of tickets, same
 * assumption `src/web/fixture-data-source.ts` documents) and fuzzy-filters
 * client-side via cmdk's own matcher over name/slug/handle/id.
 */
import { LayoutList, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TicketSummaryDTO } from "../../api/types.js";
import { fetchTicketList } from "../lib/api.js";
import { PriorityBadge, StateBadge } from "./state-badge.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [tickets, setTickets] = useState<TicketSummaryDTO[] | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open || tickets !== null) return;
    let cancelled = false;
    fetchTicketList()
      .then((res) => {
        if (!cancelled) setTickets(res.tickets);
      })
      .catch(() => {
        if (!cancelled) setTickets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, tickets]);

  const go = (ticket: TicketSummaryDTO) => {
    onOpenChange(false);
    navigate(`/tickets/${ticket.id}`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showClose={false} className="max-w-xl gap-0 p-0">
        <DialogTitle className="sr-only">Jump to ticket</DialogTitle>
        <Command shouldFilter loop>
          <CommandInput
            placeholder="Jump to a ticket by name, slug, or handle (t-xxxxx)…"
            autoFocus
          />
          <CommandList>
            {tickets === null ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 motion-safe:animate-spin" /> Loading tickets…
              </div>
            ) : (
              <>
                <CommandEmpty>No matching ticket.</CommandEmpty>
                <CommandGroup heading="Tickets">
                  {tickets.map((ticket) => (
                    <CommandItem
                      key={ticket.id}
                      value={`${ticket.name} ${ticket.slug} ${ticket.handle} ${ticket.id}`}
                      onSelect={() => go(ticket)}
                    >
                      <LayoutList className="text-muted-foreground" />
                      <span className="flex-1 truncate">{ticket.name}</span>
                      <PriorityBadge priority={ticket.priority} />
                      <StateBadge state={ticket.state} />
                      <span className="font-mono text-xs text-muted-foreground">
                        {ticket.handle}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}

/** Global Cmd/Ctrl-K listener — mount once in the app shell. */
export function useCommandPaletteShortcut(onOpenChange: (open: boolean) => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange]);
}
