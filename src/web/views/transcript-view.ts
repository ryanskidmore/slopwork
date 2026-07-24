/**
 * §4.4 item 4: the transcript viewer. Renders a session's `.jsonl`
 * conversation readably (spikes/findings.md §4): user/assistant turns as
 * distinct blocks, `text` as markdown prose, `thinking` de-emphasised and
 * collapsible, `tool_use` collapsed behind its name, `tool_result`
 * collapsed with an expand affordance, non-conversational record types
 * hidden by default. Never dumps raw JSONL — every record is transformed
 * into semantic HTML before it reaches the response.
 *
 * See src/web/transcript.ts's module doc for the pagination strategy that
 * keeps this responsive on a multi-megabyte transcript.
 */
import type { BunRequest } from "bun";
import { isSessionId } from "../../core/index.js";
import type { WebDataSource } from "../data-source.js";
import { html, joinHtml, type RawHtml, raw } from "../html.js";
import { renderMarkdownToString } from "../markdown.js";
import {
  DEFAULT_TRANSCRIPT_PAGE_SIZE,
  getTranscriptPage,
  MAX_TRANSCRIPT_PAGE_SIZE,
  type TranscriptBlock,
  type TranscriptRecord,
  toolResultText,
} from "../transcript.js";
import { notFoundPage, pageResponse } from "./shared.js";

const MAX_TOOL_RESULT_CHARS = 20_000;

function truncatedPre(text: string): RawHtml {
  if (text.length <= MAX_TOOL_RESULT_CHARS) {
    return html`<pre><code>${text}</code></pre>`;
  }
  const shown = text.slice(0, MAX_TOOL_RESULT_CHARS);
  return html`<pre><code>${shown}</code></pre><p class="truncate-note">Truncated: showing the first ${MAX_TOOL_RESULT_CHARS.toLocaleString()} of ${text.length.toLocaleString()} characters.</p>`;
}

function renderBlock(block: TranscriptBlock): RawHtml {
  switch (block.type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      return html`<div class="block-text">${raw(renderMarkdownToString(text))}</div>`;
    }
    case "thinking": {
      const thinking = typeof block.thinking === "string" ? block.thinking : "";
      return html`<details class="block-thinking"><summary>Thinking</summary><div>${raw(renderMarkdownToString(thinking))}</div></details>`;
    }
    case "tool_use": {
      const name = typeof block.name === "string" ? block.name : "unknown tool";
      return html`<details class="block-tool_use"><summary>tool_use: ${name}</summary>${truncatedPre(JSON.stringify(block.input, null, 2) ?? "")}</details>`;
    }
    case "tool_result": {
      const isError = block.is_error === true;
      const text = toolResultText(block.content);
      return html`<details class="block-tool_result${isError ? " is-error" : ""}"><summary>tool_result${isError ? " (error)" : ""}</summary>${truncatedPre(text)}</details>`;
    }
    default:
      return html`<details class="block-unknown"><summary>${block.type}</summary>${truncatedPre(JSON.stringify(block, null, 2))}</details>`;
  }
}

function renderMessageContent(content: string | TranscriptBlock[]): RawHtml {
  if (typeof content === "string") {
    return html`<div class="block-text">${raw(renderMarkdownToString(content))}</div>`;
  }
  return joinHtml(content.map(renderBlock));
}

function renderRecord(record: TranscriptRecord): RawHtml {
  if (record.type === "system") {
    const parts = [
      record.subtype ? `subtype: ${record.subtype}` : null,
      typeof record.durationMs === "number" ? `${record.durationMs}ms` : null,
      typeof record.messageCount === "number" ? `${record.messageCount} messages` : null,
    ].filter((p): p is string => p !== null);
    return html`<div class="system-divider">— system${parts.length > 0 ? `: ${parts.join(", ")}` : ""} —</div>`;
  }
  if (!record.message) {
    return html``;
  }
  const role = record.message.role === "assistant" ? "assistant" : "user";
  const model = record.message.model
    ? html`<span class="model">${record.message.model}</span>`
    : "";
  return html`<div class="turn role-${role}">
  <div class="role">${role === "assistant" ? "Assistant" : "User"} ${model} ${record.timestamp ? html`<span class="ts">${record.timestamp}</span>` : ""}</div>
  ${renderMessageContent(record.message.content)}
</div>`;
}

export async function handleTranscriptView(
  req: BunRequest<"/tickets/:ref/sessions/:sessionId/transcript">,
  dataSource: WebDataSource,
): Promise<Response> {
  const { ref, sessionId } = req.params;
  const [ticket, { config, warning: configWarning }] = await Promise.all([
    dataSource.findTicketByRef(ref),
    dataSource.getConfig(),
  ]);
  if (!ticket) return notFoundPage(null, `No ticket matches "${ref}".`);

  if (!isSessionId(sessionId)) return notFoundPage(null, "Not a valid session id.");
  const session = await dataSource.getSessionById(sessionId);
  if (!session || session.ticket !== ticket.id) {
    return notFoundPage(null, "No such session on this ticket.");
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

  const heading = html`<h1>Transcript</h1>
<p class="muted"><a href="/tickets/${ticket.id}">← ${ticket.name}</a> · ${session.actor.name} · ${session.harness.kind}</p>`;

  if (!session.transcript_ref) {
    return pageResponse({
      title: `Transcript — ${ticket.name}`,
      nav: null,
      project: config.project,
      configWarning,
      body: html`${heading}<div class="empty-state">No transcript was captured for this session (D16: this is expected when the harness's transcript couldn't be located — the session's state change was never blocked on it).</div>`,
    });
  }

  const handle = await dataSource.openTranscript(session.transcript_ref);
  if (!handle) {
    return pageResponse({
      title: `Transcript — ${ticket.name}`,
      nav: null,
      project: config.project,
      configWarning,
      body: html`${heading}<div class="empty-state">This session recorded a transcript reference (<code>${session.transcript_ref}</code>) but the file is no longer readable.</div>`,
    });
  }

  const page = await getTranscriptPage(handle, { offset, limit, includeSystem });

  const qs = (o: number) => {
    const params = new URLSearchParams({ offset: String(o), limit: String(limit) });
    if (includeSystem) params.set("all", "1");
    return `?${params.toString()}`;
  };

  // web-transcript-pager-newer-older: an out-of-range `?offset` (past the
  // last visible record) used to render a nonsense summary line ("records
  // 100001–100000", zero records, pager still offering a next page). Once
  // the scan below runs to completion (`hasMore: false`) `page.total` is
  // the EXACT visible-record count (see TranscriptPage's doc) — clamp back
  // onto the real last page instead of ever rendering that. `page.total >
  // 0` excludes the legitimate "this transcript has no visible records at
  // all" case (offset 0, nothing to clamp to).
  if (offset > 0 && page.records.length === 0 && !page.hasMore && page.total > 0) {
    const clampedOffset = Math.max(0, page.total - limit);
    return new Response(null, { status: 302, headers: { location: qs(clampedOffset) } });
  }

  const toggleQs = (() => {
    const params = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    if (!includeSystem) params.set("all", "1");
    return `?${params.toString()}`;
  })();

  // Records render oldest-first (`getTranscriptPage`'s stream order): a
  // HIGHER offset moves toward NEWER records, a lower one toward OLDER —
  // the pager labels below must follow that chronology, not the reverse
  // (web-transcript-pager-newer-older — they used to be swapped).
  const pager = html`<div class="pager">
  ${offset > 0 ? html`<a href="${qs(Math.max(0, offset - limit))}">← Older</a>` : html`<span class="disabled">← Older</span>`}
  ${
    page.records.length > 0
      ? html`<span class="muted">records ${offset + 1}–${offset + page.records.length}</span>`
      : html`<span class="muted">No records in this range.</span>`
  }
  ${page.hasMore ? html`<a href="${qs(offset + limit)}">Newer →</a>` : html`<span class="disabled">Newer →</span>`}
  <a href="${toggleQs}">${includeSystem ? "Hide" : "Show"} system records</a>
</div>`;

  const body = html`${heading}
<p class="muted mono">${handle.ref}</p>
${pager}
${
  page.records.length > 0
    ? joinHtml(page.records.map(renderRecord))
    : html`<div class="empty-state">No conversation records in this range.</div>`
}
${pager}`;

  return pageResponse({
    title: `Transcript — ${ticket.name}`,
    nav: null,
    project: config.project,
    configWarning,
    body,
  });
}
