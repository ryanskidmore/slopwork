/**
 * Markdown rendering for `slop web`.
 *
 * D10: ticket specs carry `details_md` — "markdown inside" — and the
 * transcript viewer renders `text`/`thinking` blocks as prose
 * (docs/spikes/findings.md §4). Both need markdown rendering, and the build
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
 *
 * `noHtmlBlocks`/`noHtmlSpans` stop raw `<script>`-style HTML from
 * surviving, but they do nothing about a markdown *link/image
 * destination*: `[x](javascript:alert(1))` and
 * `![x](data:text/html;base64,...)` render as a perfectly well-formed
 * `<a href="javascript:alert(1)">`/`<img src="data:...">` (verified
 * against `Bun.markdown.html` directly — see this module's test file).
 * `sanitizeMarkdownHtml` below post-processes the generated markup and
 * neutralises any `href`/`src` whose scheme isn't on the same allowlist
 * `safeUrl` (src/web/url-safety.ts) enforces for the MR/jira links, so the
 * two guards can never drift apart.
 */
import { safeUrl } from "./url-safety.js";

const SAFE_OPTIONS: Bun.markdown.Options = {
  noHtmlBlocks: true,
  noHtmlSpans: true,
  tables: true,
  strikethrough: true,
  tasklists: true,
  autolinks: { url: true, www: true, email: true },
};

/** Matches an `href="..."`/`src="..."` attribute in Bun.markdown's generated HTML — the only two attributes it ever populates with a URL. */
const URL_ATTR_RE = /\b(href|src)="([^"]*)"/gi;

/**
 * Reverses the handful of entities `Bun.markdown.html()` itself emits
 * inside an attribute value (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`,
 * plus numeric entities) so `safeUrl` sees the real scheme rather than an
 * encoded fragment of it. (Bun already resolves markdown-source entities
 * like `&#106;avascript:` into the literal scheme before this module ever
 * sees the output — verified — so this decode only has to undo Bun's own
 * *output*-side escaping, never re-parse attacker-supplied entities.)
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

/**
 * Neutralises any `href`/`src` in already-rendered markdown HTML whose
 * scheme isn't http(s)/mailto/relative/fragment (per `safeUrl`) by
 * dropping the attribute outright — the element survives (an `<a>` with
 * no `href` is inert text, not a dead link; an `<img>` with no `src`
 * shows nothing, not a broken-image script sink) but nothing js-, data-,
 * or vbscript-scheme'd ever reaches the DOM as a live attribute.
 */
export function sanitizeMarkdownHtml(html: string): string {
  return html.replace(URL_ATTR_RE, (whole, _attr: string, value: string) =>
    safeUrl(decodeHtmlEntities(value)) !== null ? whole : "",
  );
}

/** Render a markdown string to an HTML string. Never trusts the input as HTML — see this module's doc comment. */
export function renderMarkdownToString(source: string): string {
  if (source.trim().length === 0) return "";
  return sanitizeMarkdownHtml(Bun.markdown.html(source, SAFE_OPTIONS));
}
