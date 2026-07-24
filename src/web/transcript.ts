/**
 * Claude Code transcript JSONL parsing, classification, and pagination
 * (design.md §4.4 item 4 / D16). Record and block shapes are exactly what
 * docs/spikes/findings.md §4 documents — read that section before changing
 * anything here.
 *
 * Performance strategy (D5 architecture requirement — "must stay
 * responsive on a large transcript... paginate, virtualise, or
 * cap-with-expand, and say which you chose"): **offset/limit pagination
 * over a lazily-streamed line reader**. {@link getTranscriptPage} consumes
 * {@link TranscriptHandle.lines} through an async generator and stops
 * reading the file the moment it has gathered one page's worth of
 * *matching* (conversational, or conversational+system) records plus one
 * lookahead record — it never materialises the whole file, never parses
 * more lines than the current page requires, and a single request is
 * bounded by O(offset + limit) records, not by file size. Jumping to a
 * late page still re-scans from the start (this module has no persistent
 * index), which is the documented cost of that choice — acceptable for a
 * local single-reader viewer, and exactly why the UI paginates in modest
 * page sizes with next/prev links rather than exposing arbitrary
 * high-offset jumps.
 */

/**
 * §4 of the spike: "type in {"user","assistant"}" is a clean first pass.
 * These are the two record types that carry a conversational `message`.
 */
export const CONVERSATIONAL_TYPES = new Set(["user", "assistant"]);

/** Session bookkeeping (compaction boundaries, etc.) — no `message`, shown only when the viewer's `all` toggle is on, rendered as a small divider, never as a turn. */
export const SYSTEM_TYPE = "system";

/**
 * Explicitly documented (docs/spikes/findings.md §4) as "safe for a transcript
 * viewer to skip/hide by default" and never described as worth surfacing
 * — always hidden, regardless of the `all` toggle.
 */
export const ALWAYS_HIDDEN_TYPES = new Set([
  "last-prompt",
  "mode",
  "permission-mode",
  "attachment",
  "file-history-snapshot",
  "ai-title",
  "file-history-delta",
  "queue-operation",
]);

export interface TranscriptBlockBase {
  type: string;
  [key: string]: unknown;
}
export interface TranscriptTextBlock extends TranscriptBlockBase {
  type: "text";
  text: string;
}
export interface TranscriptThinkingBlock extends TranscriptBlockBase {
  type: "thinking";
  thinking: string;
}
export interface TranscriptToolUseBlock extends TranscriptBlockBase {
  type: "tool_use";
  id?: string;
  name: string;
  input: unknown;
}
export interface TranscriptToolResultBlock extends TranscriptBlockBase {
  type: "tool_result";
  tool_use_id?: string;
  content: unknown;
  is_error?: boolean;
}
export type TranscriptBlock =
  | TranscriptTextBlock
  | TranscriptThinkingBlock
  | TranscriptToolUseBlock
  | TranscriptToolResultBlock
  | TranscriptBlockBase;

export interface TranscriptMessage {
  role: string;
  content: string | TranscriptBlock[];
  model?: string;
  [key: string]: unknown;
}

export interface TranscriptRecord {
  type: string;
  uuid?: string;
  timestamp?: string;
  gitBranch?: string;
  message?: TranscriptMessage;
  subtype?: string;
  durationMs?: number;
  messageCount?: number;
  [key: string]: unknown;
}

function isVisibleType(type: string, includeSystem: boolean): boolean {
  if (CONVERSATIONAL_TYPES.has(type)) return true;
  if (includeSystem && type === SYSTEM_TYPE) return true;
  return false;
}

/**
 * Parse a raw JSONL line into a {@link TranscriptRecord}, or `null` for a
 * blank or malformed line. Never throws — a corrupt or truncated
 * transcript (real possibility: these are copied at session-end per D16,
 * and a killed harness can leave a partial last line) must degrade to
 * "skip this line", never break the viewer.
 */
export function parseTranscriptLine(line: string): TranscriptRecord | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value !== null && typeof value === "object" && "type" in value) {
      return value as TranscriptRecord;
    }
    return null;
  } catch {
    return null;
  }
}

export interface TranscriptLinesSource {
  lines(): AsyncIterable<string>;
}

async function* iterateRecords(source: TranscriptLinesSource): AsyncGenerator<TranscriptRecord> {
  for await (const line of source.lines()) {
    const record = parseTranscriptLine(line);
    if (record) yield record;
  }
}

export interface TranscriptPageOptions {
  offset: number;
  limit: number;
  includeSystem: boolean;
}

export interface TranscriptPage {
  records: TranscriptRecord[];
  offset: number;
  limit: number;
  hasMore: boolean;
  /**
   * web-transcript-pager-newer-older: the exact count of visible
   * (type/includeSystem-matching) records in the transcript — but ONLY
   * exact/authoritative when {@link hasMore} is `false`. The scan below
   * stops the moment it knows `hasMore` (one record past the requested
   * page), so when `hasMore` is `true` the source was never read to
   * completion and this is just that same lookahead count
   * (`offset + limit + 1`), not the real total. Callers that need the real
   * total (to clamp an out-of-range `offset` back onto the last valid
   * page, e.g.) must only trust this when `hasMore` is `false` — see
   * `handleTranscriptView`'s use of it.
   */
  total: number;
}

export const DEFAULT_TRANSCRIPT_PAGE_SIZE = 40;
export const MAX_TRANSCRIPT_PAGE_SIZE = 200;

/**
 * Windowed, lazily-streamed read over a transcript's visible records. See
 * the module doc for the bound this keeps on file reads.
 */
export async function getTranscriptPage(
  source: TranscriptLinesSource,
  options: TranscriptPageOptions,
): Promise<TranscriptPage> {
  const offset = Math.max(0, options.offset);
  const limit = Math.min(MAX_TRANSCRIPT_PAGE_SIZE, Math.max(1, options.limit));
  const records: TranscriptRecord[] = [];
  let matched = 0;

  for await (const record of iterateRecords(source)) {
    if (!isVisibleType(record.type, options.includeSystem)) continue;
    if (matched >= offset && records.length < limit) {
      records.push(record);
    }
    matched++;
    // One record beyond the page is enough to know `hasMore` — stop reading.
    if (matched > offset + limit) break;
  }

  return { records, offset, limit, hasMore: matched > offset + limit, total: matched };
}

/** Best-effort plain-text extraction from a `tool_result` block's `content` (string, or an array of text-ish sub-blocks). */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return JSON.stringify(part);
      })
      .join("\n");
  }
  return JSON.stringify(content, null, 2);
}
