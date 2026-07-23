/**
 * Markdown rendering for `slop web`.
 *
 * D10: ticket specs carry `details_md` — "markdown inside" — and the
 * transcript viewer renders `text`/`thinking` blocks as prose
 * (spikes/findings.md §4). Both need markdown rendering, and the build
 * must stay fully offline with no CDN assets (D5 architecture
 * requirements).
 *
 * Rather than hand-roll a parser or pull in an npm markdown package, this
 * is a thin wrapper around `Bun.markdown.html()` — a native Bun API (GFM
 * tables/strikethrough/task lists included), so there is nothing to
 * bundle at all: it's part of the Bun runtime itself and works identically
 * from source and from the compiled binary. `noHtmlBlocks`/`noHtmlSpans`
 * are set so raw HTML embedded in markdown source (ticket prose, agent
 * transcript text — both local-but-arbitrary content) is escaped rather
 * than passed through, matching this project's "never trust input as
 * HTML" rule elsewhere (src/web/html.ts).
 */

const SAFE_OPTIONS: Bun.markdown.Options = {
  noHtmlBlocks: true,
  noHtmlSpans: true,
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: { url: true, www: true, email: true },
};

/** Render a markdown string to an HTML string. Never trusts the input as HTML — see this module's doc comment. */
export function renderMarkdownToString(source: string): string {
  if (source.trim().length === 0) return "";
  return Bun.markdown.html(source, SAFE_OPTIONS);
}
