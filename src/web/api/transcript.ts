/**
 * `GET /api/tickets/:ref/sessions/:sessionId/transcript` — a session's
 * captured `.jsonl` transcript, paginated and pre-classified into semantic
 * blocks (feature parity with the old `src/web/views/transcript-view.ts`):
 * user/assistant turns, `text`/`thinking` rendered as sanitized markdown
 * HTML server-side (same `renderMarkdownToString` path as spec/resolution —
 * never re-parsed client-side), `tool_use`/`tool_result` as structured
 * data the client decides how to collapse, non-conversational record types
 * folded into a one-line system summary. Never ships raw JSONL to the
 * client.
 */
import type { BunRequest } from "bun";
import { isSessionId } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import { renderMarkdownToString } from "../markdown.js";
import {
  DEFAULT_TRANSCRIPT_PAGE_SIZE,
  getTranscriptPage,
  MAX_TRANSCRIPT_PAGE_SIZE,
  type TranscriptBlock,
  type TranscriptRecord,
  toolResultText,
} from "../transcript.js";
import { apiErrorResponse, configDto, jsonResponse, ticketRefDto } from "./shared.js";
import type { TranscriptBlockDTO, TranscriptRecordDTO, TranscriptResponseDTO } from "./types.js";

const MAX_TOOL_RESULT_CHARS = 20_000;

function truncate(text: string): { text: string; truncated: boolean; total_chars: number } {
  if (text.length <= MAX_TOOL_RESULT_CHARS) {
    return { text, truncated: false, total_chars: text.length };
  }
  return { text: text.slice(0, MAX_TOOL_RESULT_CHARS), truncated: true, total_chars: text.length };
}

function blockDto(block: TranscriptBlock): TranscriptBlockDTO {
  switch (block.type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      return { type: "text", html: renderMarkdownToString(text) };
    }
    case "thinking": {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      return { type: "thinking", html: renderMarkdownToString(thinking) };
    }
    case "tool_use": {
      const name = typeof block.name === "string" ? block.name : "unknown tool";
      const { text, truncated, total_chars } = truncate(JSON.stringify(block.input, null, 2) ?? "");
      return { type: "tool_use", name, input_json: text, truncated, total_chars };
    }
    case "tool_result": {
      const isError = block.is_error === true;
      const { text, truncated, total_chars } = truncate(toolResultText(block.content));
      return { type: "tool_result", is_error: isError, text, truncated, total_chars };
    }
    default: {
      const { text, truncated, total_chars } = truncate(JSON.stringify(block, null, 2));
      return { type: "unknown", raw_type: block.type, json: text, truncated, total_chars };
    }
  }
}

function recordDto(record: TranscriptRecord): TranscriptRecordDTO | null {
  if (record.type === "system") {
    const parts = [
      record.subtype ? `subtype: ${record.subtype}` : null,
      typeof record.durationMs === "number" ? `${record.durationMs}ms` : null,
      typeof record.messageCount === "number" ? `${record.messageCount} messages` : null,
    ].filter((p): p is string => p !== null);
    return { kind: "system", summary: parts.length > 0 ? parts.join(", ") : "system" };
  }
  if (!record.message) return null;
  const role = record.message.role === "assistant" ? "assistant" : "user";
  const content = record.message.content;
  const blocks: TranscriptBlockDTO[] =
    typeof content === "string"
      ? [{ type: "text", html: renderMarkdownToString(content) }]
      : content.map(blockDto);
  return {
    kind: "turn",
    role,
    model: record.message.model ?? null,
    timestamp: record.timestamp ?? null,
    blocks,
  };
}

export async function handleTranscriptView(
  req: BunRequest<"/api/tickets/:ref/sessions/:sessionId/transcript">,
  dataSource: WebDataSource,
): Promise<Response> {
  const { ref, sessionId } = req.params;
  const [ticket, { config, warning }] = await Promise.all([
    dataSource.findTicketByRef(ref),
    dataSource.getConfig(),
  ]);
  if (!ticket) return apiErrorResponse(`No ticket matches "${ref}".`, 404);

  if (!isSessionId(sessionId)) return apiErrorResponse("Not a valid session id.", 404);
  const session = await dataSource.getSessionById(sessionId);
  if (!session || session.ticket !== ticket.id) {
    return apiErrorResponse("No such session on this ticket.", 404);
  }

  const url = new URL(req.url);
  const offset = Math.max(0, Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
  const requestedLimit = Number.parseInt(
    url.searchParams.get("limit") ?? String(DEFAULT_TRANSCRIPT_PAGE_SIZE),
    10,
  );
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(MAX_TRANSCRIPT_PAGE_SIZE, Math.max(1, requestedLimit))
    : DEFAULT_TRANSCRIPT_PAGE_SIZE;
  const includeSystem = url.searchParams.get("all") === "1";

  const configDtoValue = configDto(config, warning);
  const ticketRef = ticketRefDto(ticket);
  const sessionSummary = { id: session.id, actor: session.actor, harness: session.harness.kind };

  if (!session.transcript_ref) {
    const body: TranscriptResponseDTO = {
      config: configDtoValue,
      ticket: ticketRef,
      session: sessionSummary,
      transcript_ref: null,
      available: false,
      records: [],
      offset,
      limit,
      has_more: false,
      total: 0,
      include_system: includeSystem,
    };
    return jsonResponse(body);
  }

  const handle = await dataSource.openTranscript(session.transcript_ref);
  if (!handle) {
    const body: TranscriptResponseDTO = {
      config: configDtoValue,
      ticket: ticketRef,
      session: sessionSummary,
      transcript_ref: session.transcript_ref,
      available: false,
      records: [],
      offset,
      limit,
      has_more: false,
      total: 0,
      include_system: includeSystem,
    };
    return jsonResponse(body);
  }

  const page = await getTranscriptPage(handle, { offset, limit, includeSystem });

  // web-transcript-pager-newer-older: an out-of-range offset (past the last
  // visible record) used to render a nonsense summary — once the scan runs
  // to completion (hasMore: false) page.total is the exact visible-record
  // count, so clamp back onto the real last page instead of ever shipping
  // that to the client.
  if (offset > 0 && page.records.length === 0 && !page.hasMore && page.total > 0) {
    const clampedOffset = Math.max(0, page.total - limit);
    const clamped = await getTranscriptPage(handle, {
      offset: clampedOffset,
      limit,
      includeSystem,
    });
    const body: TranscriptResponseDTO = {
      config: configDtoValue,
      ticket: ticketRef,
      session: sessionSummary,
      transcript_ref: session.transcript_ref,
      available: true,
      records: clamped.records.map(recordDto).filter((r): r is TranscriptRecordDTO => r !== null),
      offset: clampedOffset,
      limit,
      has_more: clamped.hasMore,
      total: clamped.total,
      include_system: includeSystem,
    };
    return jsonResponse(body);
  }

  const body: TranscriptResponseDTO = {
    config: configDtoValue,
    ticket: ticketRef,
    session: sessionSummary,
    transcript_ref: session.transcript_ref,
    available: true,
    records: page.records.map(recordDto).filter((r): r is TranscriptRecordDTO => r !== null),
    offset,
    limit,
    has_more: page.hasMore,
    total: page.total,
    include_system: includeSystem,
  };
  return jsonResponse(body);
}
