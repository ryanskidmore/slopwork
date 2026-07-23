# Slopworks — Engineering Decisions

Short-form log of implementation decisions made while executing
`v0-implementation-plan.md` that aren't already captured by one of
`design.md`'s D-numbered decisions, or that sharpen one of them for
implementation. Newest at the bottom. Each entry names the work item that
forced the call.

## A2 — Edges are stored embedded on the source ticket, not in their own `edges/` directory

`design.md` §3's flatfile db layout lists only `tickets/`, `sessions/`,
`events/`, and the derived `index.jsonc` — there is no `edges/` directory.
So the four edge kinds (`blocks` · `parent` · `relates-to` ·
`discovered-from`, design.md §4.1 item 2) are stored as fields embedded
directly on the *source* ticket — `parent` as a single optional field;
`blocks`, `relates_to`, `discovered_from` as arrays of ticket ids — rather
than as free-standing edge records. The reverse direction (e.g. "which
tickets does X block", "who does Y depend on") is never stored; it is
derived into `index.jsonc` at reindex time, which is exactly what B4's
`blocked_count` is.

**Rationale:** this keeps adding a single edge a one-file, one-line change
on the ticket that owns it, which is what §3's git-mergeable-flatfile-db
merge story requires. A free-standing `edges/edge_<ulid>.jsonc` file per
edge would mean every graph mutation touches an extra file — more merge
surface — for no benefit, since edges have no independent identity or
lifecycle of their own in v0 (they're never edited, only created/removed
alongside the ticket that owns them).

See `src/core/entities/edge.ts` for the logical `Edge` shape (`{from, to,
kind}`, used by the index/graph code in B3/B4), the embedded on-ticket
field shape (`ticketEdgeFieldsSchema`), the documented mapping between the
two (`EDGE_KIND_TO_TICKET_FIELD`), and the forward-extraction helper
(`outgoingEdges`) that B4 will call over every ticket to build the
reverse index.
