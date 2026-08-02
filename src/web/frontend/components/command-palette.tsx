/**
 * Cmd/Ctrl-K command palette — "jump to ticket by id/slug/handle" (design
 * direction's named shadcn piece). Search stays server-side and bounded:
 * the palette debounces input, cancels superseded requests, and renders at
 * most the first 20 stable matches returned by `GET /api/tickets`.
 */
import { LayoutList, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TicketSummaryDTO } from "../../api/types.js";
import { fetchTicketList } from "../lib/api.js";
import { PriorityBadge, StateBadge } from "./state-badge.js";
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "./ui/command.js";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog.js";

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tickets, setTickets] = useState<TicketSummaryDTO[]>([]);
  const [matchTotal, setMatchTotal] = useState(0);
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open || query === debouncedQuery) return;
    const timer = window.setTimeout(() => setDebouncedQuery(query), 200);
    return () => window.clearTimeout(timer);
  }, [open, query, debouncedQuery]);

  useEffect(() => {
    // Including `query` aborts the previous fetch on the first keystroke;
    // its replacement waits until the debounced value catches up.
    if (!open || query !== debouncedQuery) return;
    const controller = new AbortController();
    setStatus("loading");
    setError(null);
    fetchTicketList({ q: debouncedQuery, page: 1, limit: 20 }, { signal: controller.signal })
      .then((res) => {
        if (controller.signal.aborted) return;
        setTickets(res.tickets);
        setMatchTotal(res.pagination.filtered_total);
        setStatus("success");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setTickets([]);
        setMatchTotal(0);
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    return () => {
      controller.abort();
    };
  }, [open, query, debouncedQuery]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery("");
      setDebouncedQuery("");
      setTickets([]);
      setMatchTotal(0);
      setStatus("idle");
      setError(null);
    }
    onOpenChange(nextOpen);
  };

  const go = (ticket: TicketSummaryDTO) => {
    handleOpenChange(false);
    navigate(`/tickets/${ticket.id}`);
  };

  const pending = open && (query !== debouncedQuery || status === "loading");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showClose={false} className="max-w-xl gap-0 p-0">
        <DialogTitle className="sr-only">Jump to ticket</DialogTitle>
        <Command shouldFilter={false} loop>
          <CommandInput
            placeholder="Jump to a ticket by name, slug, or handle (t-xxxxx)…"
            aria-label="Search tickets"
            autoFocus
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="min-h-64" aria-busy={pending}>
            <div
              className="flex min-h-8 items-center justify-center border-b border-border px-3 text-xs text-muted-foreground"
              aria-live="polite"
            >
              {pending ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
                  Searching
                </span>
              ) : status === "error" ? (
                <span role="alert" className="text-destructive">
                  Search failed: {error}
                </span>
              ) : status === "success" ? (
                <span>{matchTotal} matching tickets</span>
              ) : null}
            </div>

            {status === "success" && tickets.length === 0 && !pending ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No matching ticket.
              </div>
            ) : null}

            {tickets.length > 0 && status !== "error" ? (
              <CommandGroup heading="Tickets" className={pending ? "opacity-60" : undefined}>
                {tickets.map((ticket) => (
                  <CommandItem
                    key={ticket.id}
                    value={ticket.id}
                    disabled={pending}
                    onSelect={() => go(ticket)}
                  >
                    <LayoutList className="text-muted-foreground" />
                    <span className="flex-1 truncate">{ticket.name}</span>
                    <PriorityBadge priority={ticket.priority} />
                    <StateBadge state={ticket.state} />
                    <span className="font-mono text-xs text-muted-foreground">{ticket.handle}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
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
