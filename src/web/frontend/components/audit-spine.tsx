/**
 * THE signature element (design direction): a ticket's whole life —
 * created → session started (actor/harness/branch) → plan v1 and its
 * revisions → checkpoint ticks → progress notes → review requested → done
 * — as one continuous, chronological thread. `events` is already the
 * merged ticket+session timeline the API hands back oldest-first (see
 * src/web/api/ticket-detail.ts) — this component's only job is to render
 * it memorably: a vertical "spine" rail with a marker per event, shaped by
 * WHO acted (a filled circle for a human, a rotated-square "diamond" for
 * an agent — shape, not just color, so authorship reads under any color
 * vision) and colored by nothing else — the spine rail itself carries the
 * one bold, unique accent color (`--spine`) this whole design spends on a
 * single feature, exactly as the brief asks.
 */
import type { ActorDTO, EventDTO } from "../../api/types.js";
import { formatAbsolute, formatRelative } from "../lib/format.js";
import { CopyableId } from "./copyable-id.js";

function eventDetail(event: EventDTO): string | null {
  const p = event.payload;
  switch (event.verb) {
    case "ticket.state_changed":
      return typeof p.from === "string" && typeof p.to === "string" ? `${p.from} → ${p.to}` : null;
    case "ticket.done":
      return typeof p.from === "string" ? `from ${p.from}` : null;
    case "ticket.dropped": {
      const from = typeof p.from === "string" ? `from ${p.from}` : "";
      const reason = typeof p.reason === "string" && p.reason ? `— ${p.reason}` : "";
      return [from, reason].filter(Boolean).join(" ") || null;
    }
    case "review.requested":
      return typeof p.mr === "string" && p.mr ? p.mr : null;
    case "plan.set":
    case "plan.revised":
      return typeof p.version === "number" && typeof p.step_count === "number"
        ? `v${p.version} · ${p.step_count} step${p.step_count === 1 ? "" : "s"}`
        : null;
    case "plan.step_checked":
      return typeof p.step === "number"
        ? `step ${p.step} ${p.checked ? "checked" : "unchecked"}`
        : null;
    default:
      return null;
  }
}

function ActorMarker({ actor }: { actor: ActorDTO }) {
  const isAgent = actor.kind === "agent";
  return (
    <span className="relative z-10 flex size-5 shrink-0 items-center justify-center bg-background">
      {isAgent ? (
        <span
          className="block size-3 rotate-45 rounded-[2px] bg-actor-agent"
          title="Agent"
          aria-hidden="true"
        />
      ) : (
        <span
          className="block size-3 rounded-full bg-actor-human"
          title="Human"
          aria-hidden="true"
        />
      )}
    </span>
  );
}

export function ActorKindLegend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <span className="block size-2.5 rounded-full bg-actor-human" aria-hidden="true" /> Human
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="block size-2.5 rotate-45 rounded-[1.5px] bg-actor-agent"
          aria-hidden="true"
        />{" "}
        Agent
      </span>
    </div>
  );
}

export function AuditSpine({ events, now }: { events: EventDTO[]; now: number }) {
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">No events yet.</p>;
  }
  return (
    <ol className="flex flex-col">
      {events.map((event) => {
        const detail = eventDetail(event);
        return (
          <li
            key={event.id}
            // The connecting rail is a `before:` pseudo-element — Tailwind
            // only generates a pseudo-element's box when it also gets a
            // `content` value (browsers render nothing for `content: normal`,
            // the property's default), hence the explicit `before:content-['']`
            // here; every other `before:*` utility is inert without it.
            className="relative flex gap-3 pb-5 before:absolute before:top-5 before:bottom-0 before:left-[8.5px] before:w-0.5 before:content-[''] before:bg-spine/70 last:pb-0 last:before:hidden"
          >
            <ActorMarker actor={event.actor} />
            <div className="min-w-0 flex-1 pt-px">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-sm font-medium">{event.label}</span>
                <span className="text-sm text-muted-foreground">{event.actor.name}</span>
                <time
                  dateTime={event.at}
                  title={formatAbsolute(event.at)}
                  className="ml-auto shrink-0 font-mono text-xs text-muted-foreground"
                >
                  {formatRelative(event.at, now)}
                </time>
              </div>
              {event.progress_note && (
                <p className="mt-1 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm">
                  “{event.progress_note}”
                </p>
              )}
              {!event.progress_note && detail && (
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">{detail}</p>
              )}
              {event.session && (
                <CopyableId
                  value={event.session}
                  display={`session ${event.session.slice(-6)}`}
                  className="mt-0.5"
                />
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
