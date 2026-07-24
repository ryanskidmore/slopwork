import { ArrowLeft, ArrowRight, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type {
  TranscriptBlockDTO,
  TranscriptRecordDTO,
  TranscriptResponseDTO,
} from "../../api/types.js";
import { EmptyState } from "../components/empty-state.js";
import { Markdown } from "../components/markdown.js";
import { Button } from "../components/ui/button.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { fetchTranscript } from "../lib/api.js";

function TruncationNote({ block }: { block: { truncated: boolean; total_chars: number } }) {
  if (!block.truncated) return null;
  return (
    <p className="mt-1 text-xs text-muted-foreground">
      Truncated: showing a prefix of {block.total_chars.toLocaleString()} total characters.
    </p>
  );
}

function TranscriptBlockView({ block }: { block: TranscriptBlockDTO }) {
  switch (block.type) {
    case "text":
      return <Markdown html={block.html} />;
    case "thinking":
      return (
        <details className="rounded-md border border-dashed border-border p-2 text-muted-foreground">
          <summary className="cursor-pointer text-xs font-medium">Thinking</summary>
          <Markdown html={block.html} className="mt-2" />
        </details>
      );
    case "tool_use":
      return (
        <details className="rounded-md border border-border p-2">
          <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium">
            <Wrench className="size-3.5" /> tool_use: {block.name}
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
            <code>{block.input_json}</code>
          </pre>
          <TruncationNote block={block} />
        </details>
      );
    case "tool_result":
      return (
        <details
          className={`rounded-md border p-2 ${block.is_error ? "border-destructive/50" : "border-border"}`}
        >
          <summary className="cursor-pointer text-xs font-medium">
            tool_result{block.is_error ? " (error)" : ""}
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
            <code>{block.text}</code>
          </pre>
          <TruncationNote block={block} />
        </details>
      );
    default:
      return (
        <details className="rounded-md border border-border p-2">
          <summary className="cursor-pointer text-xs font-medium">{block.raw_type}</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-xs">
            <code>{block.json}</code>
          </pre>
          <TruncationNote block={block} />
        </details>
      );
  }
}

function RecordView({ record }: { record: TranscriptRecordDTO }) {
  if (record.kind === "system") {
    return (
      <div className="my-2 text-center text-xs text-muted-foreground">
        — system: {record.summary} —
      </div>
    );
  }
  return (
    <div
      className={`rounded-lg border p-3 ${
        record.role === "assistant" ? "border-spine/30 bg-spine/5" : "border-border bg-muted/30"
      }`}
    >
      <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span>{record.role === "assistant" ? "Assistant" : "User"}</span>
        {record.model && <span className="font-mono">{record.model}</span>}
        {record.timestamp && <span className="ml-auto font-mono">{record.timestamp}</span>}
      </div>
      <div className="flex flex-col gap-2">
        {record.blocks.map((block, i) => (
          // A record's block list has no stable id of its own — position within the (immutable, paginated) record is a fine key.
          <TranscriptBlockView key={`${record.timestamp ?? ""}-${i}`} block={block} />
        ))}
      </div>
    </div>
  );
}

const DEFAULT_LIMIT = 40;

export function TranscriptPage() {
  const { ref = "", sessionId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<TranscriptResponseDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const offset = Number.parseInt(params.get("offset") ?? "0", 10) || 0;
  const limit = Number.parseInt(params.get("limit") ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;
  const includeSystem = params.get("all") === "1";

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchTranscript(ref, sessionId, { offset, limit, includeSystem })
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [ref, sessionId, offset, limit, includeSystem]);

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }

  const goto = (nextOffset: number) => {
    const next = new URLSearchParams(params);
    next.set("offset", String(Math.max(0, nextOffset)));
    setParams(next);
  };

  const toggleSystem = () => {
    const next = new URLSearchParams(params);
    if (includeSystem) next.delete("all");
    else next.set("all", "1");
    setParams(next);
  };

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link
          to={data ? `/tickets/${data.ticket.id}` : `/tickets/${ref}`}
          className="text-sm text-muted-foreground hover:text-foreground hover:underline"
        >
          ← {data?.ticket.name ?? "back to ticket"}
        </Link>
        <h1 className="text-lg font-semibold">Transcript</h1>
        {data && (
          <p className="text-sm text-muted-foreground">
            {data.session.actor.name} · {data.session.harness}
          </p>
        )}
      </div>

      {!data && !error && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-2/3" />
        </div>
      )}

      {data && !data.available && (
        <EmptyState
          icon={Wrench}
          title="No transcript available"
          description={
            data.transcript_ref
              ? `This session recorded a transcript reference (${data.transcript_ref}) but the file is no longer readable.`
              : "No transcript was captured for this session — this is expected when the harness's transcript couldn't be located; the session's state change was never blocked on it."
          }
        />
      )}

      {data?.available && (
        <>
          <Pager data={data} onPage={goto} onToggleSystem={toggleSystem} />
          {data.records.length === 0 ? (
            <p className="text-sm text-muted-foreground">No records in this range.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {data.records.map((record, i) => (
                // Paginated transcript records have no stable id of their own — offset+position within this page is a fine key.
                <RecordView key={`${data.offset}-${i}`} record={record} />
              ))}
            </div>
          )}
          <Pager data={data} onPage={goto} onToggleSystem={toggleSystem} />
        </>
      )}
    </div>
  );
}

function Pager({
  data,
  onPage,
  onToggleSystem,
}: {
  data: TranscriptResponseDTO;
  onPage: (offset: number) => void;
  onToggleSystem: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Button
        variant="outline"
        size="sm"
        disabled={data.offset <= 0}
        onClick={() => onPage(Math.max(0, data.offset - data.limit))}
      >
        <ArrowLeft className="size-3.5" /> Older
      </Button>
      <span className="text-muted-foreground">
        {data.records.length > 0
          ? `records ${data.offset + 1}–${data.offset + data.records.length}`
          : "No records in this range."}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={!data.has_more}
        onClick={() => onPage(data.offset + data.limit)}
      >
        Newer <ArrowRight className="size-3.5" />
      </Button>
      <Button variant="ghost" size="sm" className="ml-auto" onClick={onToggleSystem}>
        {data.include_system ? "Hide" : "Show"} system records
      </Button>
    </div>
  );
}
