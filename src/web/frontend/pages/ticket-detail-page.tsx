import { ChevronRight, FileWarning } from "lucide-react";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { PlanVersionDTO, SessionDTO, TicketDetailDTO } from "../../api/types.js";
import { ActorKindLegend, AuditSpine } from "../components/audit-spine.js";
import { CopyableId } from "../components/copyable-id.js";
import { Markdown } from "../components/markdown.js";
import { RefList } from "../components/ref-list.js";
import { LabelChips, OverlayBadges, PriorityBadge, StateBadge } from "../components/state-badge.js";
import { DanglingRefText, TicketLink } from "../components/ticket-link.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Separator } from "../components/ui/separator.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { useNow } from "../hooks/use-now.js";
import { fetchTicketDetail } from "../lib/api.js";
import { formatAbsolute, formatDurationShort, formatRelative } from "../lib/format.js";

export function TicketDetailPage() {
  const { ref = "" } = useParams();
  const [data, setData] = useState<TicketDetailDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchTicketDetail(ref)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [ref]);

  if (error) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="flex items-center gap-2 py-6 text-destructive">
          <FileWarning className="size-5" /> {error}
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const { ticket } = data;

  return (
    <div className="flex flex-col gap-5">
      <Breadcrumb ancestry={data.ancestry} name={ticket.name} />

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <StateBadge state={ticket.state} />
          <PriorityBadge priority={ticket.priority} />
          <h1 className="text-xl font-semibold">{ticket.name}</h1>
          <OverlayBadges overlay={ticket.overlay} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <CopyableId value={ticket.handle} />
          <CopyableId value={ticket.id} />
          <span className="font-mono text-xs">{ticket.slug}</span>
        </div>
      </div>

      {ticket.review && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 py-3 text-sm">
            <span className="font-medium">In review</span>
            {ticket.review.mr?.safe_url ? (
              <a
                href={ticket.review.mr.safe_url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                {ticket.review.mr.url}
              </a>
            ) : ticket.review.mr ? (
              <span className="text-muted-foreground" title="Unsafe URL scheme — shown as text">
                {ticket.review.mr.url}
              </span>
            ) : (
              <span className="text-muted-foreground">No MR link yet</span>
            )}
            <span className="text-muted-foreground">
              — requested by {ticket.review.by.name}, awaiting{" "}
              {formatDurationShort(ticket.review.awaiting_ms)}
            </span>
          </CardContent>
        </Card>
      )}

      <MetaGrid data={data} />

      <Tabs defaultValue="timeline">
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="overview">Spec</TabsTrigger>
          <TabsTrigger value="sessions">
            Sessions {data.sessions.length > 0 && `(${data.sessions.length})`}
          </TabsTrigger>
          <TabsTrigger value="relationships">Relationships</TabsTrigger>
        </TabsList>

        <TabsContent value="timeline" className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Every event on this ticket and its sessions, oldest first — the full audit trail.
            </p>
            <ActorKindLegend />
          </div>
          <AuditSpine events={data.events} now={now} />
        </TabsContent>

        <TabsContent value="overview" className="flex flex-col gap-4">
          <section>
            <p className="text-sm">{data.spec.summary}</p>
            {data.spec.details_html && <Markdown html={data.spec.details_html} className="mt-3" />}
          </section>
          {data.spec.acceptance.length > 0 && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Acceptance</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {data.spec.acceptance.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </section>
          )}
          {data.spec.context.length > 0 && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Context</h3>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {data.spec.context.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </section>
          )}
          {Object.keys(data.spec.meta).length > 0 && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Meta</h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                {Object.entries(data.spec.meta).map(([k, v]) => (
                  <Fragment key={k}>
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                  </Fragment>
                ))}
              </dl>
            </section>
          )}
          {data.resolution_html && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Resolution</h3>
              <Markdown html={data.resolution_html} />
            </section>
          )}
        </TabsContent>

        <TabsContent value="sessions" className="flex flex-col gap-3">
          {data.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No sessions yet.</p>
          ) : (
            data.sessions.map((session) => (
              <SessionCard key={session.id} session={session} ticketId={ticket.id} />
            ))
          )}
        </TabsContent>

        <TabsContent value="relationships" className="flex flex-col gap-3">
          <RelRow label="Blocks →" refs={data.relationships.blocks} />
          <RelRow label="← Blocked by" refs={data.relationships.blocked_by} />
          <RelRow label="Relates to" refs={data.relationships.relates_to} />
          <RelRow label="Discovered from →" refs={data.relationships.discovered_from} />
          <RelRow label="← Discovered here" refs={data.relationships.discovered_here} />
          <div>
            <span className="text-xs font-medium text-muted-foreground">Children</span>
            <div className="mt-1">
              {data.children.length === 0 ? (
                <span className="text-sm text-muted-foreground">none</span>
              ) : (
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  {data.children.map((c) => (
                    <TicketLink key={c.id} ticket={c} withState />
                  ))}
                </span>
              )}
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function RelRow({
  label,
  refs,
}: {
  label: string;
  refs: TicketDetailDTO["relationships"]["blocks"];
}) {
  return (
    <div>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="mt-1">
        <RefList refs={refs} />
      </div>
    </div>
  );
}

function Breadcrumb({ ancestry, name }: { ancestry: TicketDetailDTO["ancestry"]; name: string }) {
  if (ancestry.length === 0) {
    return <p className="text-xs text-muted-foreground">Root ticket</p>;
  }
  return (
    <nav
      aria-label="Ancestry"
      className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
    >
      {ancestry.map((a) => (
        <span key={a.ref.id} className="flex items-center gap-1">
          {a.kind === "ref" ? (
            <Link to={`/tickets/${a.ref.id}`} className="hover:text-foreground hover:underline">
              {a.ref.name}
            </Link>
          ) : (
            <DanglingRefText id={a.ref.id} />
          )}
          <ChevronRight className="size-3" aria-hidden="true" />
        </span>
      ))}
      <span>{name}</span>
    </nav>
  );
}

function MetaGrid({ data }: { data: TicketDetailDTO }) {
  const { ticket } = data;
  return (
    <Card>
      <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 py-4 text-sm sm:grid-cols-3 lg:grid-cols-4">
        <MetaField label="Owner">{ticket.owner?.name ?? <Muted>—</Muted>}</MetaField>
        <MetaField label="Labels">
          {ticket.labels.length > 0 ? <LabelChips labels={ticket.labels} /> : <Muted>none</Muted>}
        </MetaField>
        <MetaField label="Adhoc">{ticket.adhoc ? "yes" : "no"}</MetaField>
        <MetaField label="Parent">
          <ParentField parent={ticket.parent} />
        </MetaField>
        <MetaField label="Latest note">{ticket.latest_note ?? <Muted>none</Muted>}</MetaField>
        <MetaField label="Last activity">
          <LastActivityField iso={ticket.last_activity_at} />
        </MetaField>
        <MetaField label="Created" mono>
          {formatAbsolute(ticket.created_at)}
        </MetaField>
        <MetaField label="Updated" mono>
          {formatAbsolute(ticket.updated_at)}
        </MetaField>
        <MetaField label="Provenance">
          <ProvenanceField provenance={data.provenance} />
        </MetaField>
      </CardContent>
    </Card>
  );
}

function LastActivityField({ iso }: { iso: string }) {
  const now = useNow();
  return <span title={formatAbsolute(iso)}>{formatRelative(iso, now)}</span>;
}

function ProvenanceField({ provenance }: { provenance: TicketDetailDTO["provenance"] }) {
  return (
    <span>
      {provenance.method} by {provenance.created_by.name}
      {provenance.split_from && (
        <>
          {" "}
          (split from{" "}
          {provenance.split_from.kind === "ref" ? (
            <TicketLink ticket={provenance.split_from.ref} />
          ) : (
            <DanglingRefText id={provenance.split_from.ref.id} />
          )}
          )
        </>
      )}
    </span>
  );
}

function ParentField({ parent }: { parent: TicketDetailDTO["ticket"]["parent"] }) {
  if (parent.kind === "none") return <Muted>— (root)</Muted>;
  if (parent.kind === "local") {
    return parent.ref.kind === "ref" ? (
      <TicketLink ticket={parent.ref.ref} withState />
    ) : (
      <DanglingRefText id={parent.ref.ref.id} />
    );
  }
  return parent.parent.safe_url ? (
    <a
      href={parent.parent.safe_url}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-md border border-border px-1.5 py-0.5 text-xs hover:text-foreground"
    >
      ↑ {parent.parent.ref}
    </a>
  ) : (
    <span className="rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
      ↑ {parent.parent.ref}
    </span>
  );
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

function MetaField({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-xs" : undefined}>{children}</span>
    </div>
  );
}

function SessionCard({ session, ticketId }: { session: SessionDTO; ticketId: string }) {
  return (
    <Card id={`session-${session.id}`}>
      <CardContent className="flex flex-col gap-2 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{session.actor.name}</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            {session.harness}
          </span>
          {session.is_active && (
            <span className="rounded-md bg-state-in_progress px-1.5 py-0.5 text-xs font-medium text-state-in_progress-foreground">
              active
            </span>
          )}
          <CopyableId value={session.id} className="ml-auto" />
        </div>
        <p className="text-xs text-muted-foreground">
          {formatAbsolute(session.started_at)} →{" "}
          {session.ended_at ? formatAbsolute(session.ended_at) : "(active)"}
        </p>
        <p className="text-xs text-muted-foreground">
          git: {session.git_branch ?? "—"} @{" "}
          {session.git_commit_at_start ? (
            <CopyableId value={session.git_commit_at_start} className="inline" />
          ) : (
            "—"
          )}
        </p>

        {session.plan.length > 0 && (
          <div className="mt-1 flex flex-col gap-2">
            {session.plan.map((version) => (
              <PlanVersionBlock key={version.version} version={version} />
            ))}
          </div>
        )}

        {session.end_summary && (
          <p className="text-sm">
            <span className="font-medium">End summary: </span>
            {session.end_summary}
          </p>
        )}

        <Separator className="my-1" />
        {session.has_transcript ? (
          <Link
            to={`/tickets/${ticketId}/sessions/${session.id}/transcript`}
            className="text-sm underline-offset-2 hover:underline"
          >
            View transcript →
          </Link>
        ) : (
          <span className="text-sm text-muted-foreground">
            No transcript captured for this session.
          </span>
        )}
      </CardContent>
    </Card>
  );
}

function PlanVersionBlock({ version }: { version: PlanVersionDTO }) {
  const checkedCount = version.steps.filter((s) => s.checked).length;
  return (
    <details open={version.is_latest} className="rounded-md border border-border p-2">
      <summary className="cursor-pointer text-sm font-medium">
        Plan v{version.version} ({checkedCount}/{version.steps.length} checked) —{" "}
        {formatAbsolute(version.created_at)}
      </summary>
      <ul className="mt-2 flex flex-col gap-1 pl-1">
        {version.steps.map((step, i) => (
          <li
            key={`${version.version}-${i}`}
            className={`flex items-start gap-2 text-sm ${step.checked ? "text-muted-foreground line-through" : ""}`}
          >
            <span
              className={`mt-0.5 inline-block size-3.5 shrink-0 rounded-sm border ${
                step.checked ? "border-state-done bg-state-done" : "border-border"
              }`}
              aria-hidden="true"
            />
            {step.text}
          </li>
        ))}
      </ul>
    </details>
  );
}
