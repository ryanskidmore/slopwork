/**
 * A tiny, dependency-free HTML templating helper. `slop web` is a handful
 * of server-rendered pages — this is deliberately not a templating engine,
 * just a tagged template that auto-escapes interpolated values so ticket
 * names, spec prose, and transcript content (all untrusted-ish, all
 * rendered straight from the local db) can't break page structure.
 */

/** Marks a string as already-safe HTML so `html` doesn't re-escape it (used for composing nested `html` results and for markdown.ts's output). */
export interface RawHtml {
  readonly raw: string;
}

export function raw(value: string): RawHtml {
  return { raw: value };
}

export type HtmlValue = string | number | boolean | null | undefined | RawHtml | HtmlValue[];

export function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** For `href`/`src` attribute values: escapeHtml plus quote-breaking characters already covered — kept as a named alias so call sites read as attribute-safe, not just text-safe. */
export function escapeAttr(input: string): string {
  return escapeHtml(input);
}

/**
 * Scheme allowlist for anything that ends up in a live `href`/`src`:
 * `escapeHtml`/`escapeAttr` above only neutralise HTML metacharacters —
 * they never look at *what URL scheme* the string names, so a
 * `javascript:`/`data:`/`vbscript:` URL sails through them unchanged and
 * executes the moment a human clicks (or, for `data:` images, just
 * loads) it. This is the one place that knows what a "safe" URL looks
 * like; `src/web/markdown.ts` reuses it verbatim so the markdown-link
 * guard and this guard can never drift apart.
 *
 * Absolute URLs must use http/https/mailto. A reference with no scheme
 * at all — `/tickets/123`, `./x`, `#frag`, `?q=1` — is a same-document or
 * relative reference and can't carry an executable scheme, so it passes
 * through unchecked. A `//host/path` protocol-relative reference *does*
 * resolve through a scheme (the page's own) even though it doesn't spell
 * one out, so it's deliberately excluded from that free pass.
 */
const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto"]);

/** Matches a leading `scheme:` per RFC 3986 (letter, then letters/digits/+/-/.). */
const URL_SCHEME_RE = /^([a-zA-Z][a-zA-Z\d+.-]*):/;

/**
 * Returns `raw` (trimmed) if its scheme is on the {@link SAFE_URL_SCHEMES}
 * allowlist or it has no scheme at all (a relative/fragment/query
 * reference), else `null`. Callers route anything destined for a live
 * `href`/`src` through this and fall back to inert text (matching the
 * existing unconfigured-Jira badge pattern in `src/web/views/shared.ts`)
 * when it returns `null` — never render the raw value as a link anyway.
 */
export function safeUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith("//")) return null; // protocol-relative — see doc comment above
  if (trimmed.startsWith("/") || trimmed.startsWith("#") || trimmed.startsWith("?")) {
    return trimmed;
  }
  const schemeMatch = URL_SCHEME_RE.exec(trimmed);
  if (!schemeMatch) return trimmed; // no scheme delimiter — a bare relative reference
  const scheme = (schemeMatch[1] ?? "").toLowerCase();
  return SAFE_URL_SCHEMES.has(scheme) ? trimmed : null;
}

function renderValue(value: HtmlValue): string {
  if (value === null || value === undefined || value === false || value === true) return "";
  if (Array.isArray(value)) return value.map(renderValue).join("");
  if (typeof value === "object") return value.raw;
  return escapeHtml(String(value));
}

/**
 * Tagged template: `html\`<div>${untrustedName}</div>\`` escapes
 * `untrustedName` automatically. Nest by embedding another call's result
 * (a {@link RawHtml}) directly — it passes through unescaped, exactly
 * once.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): RawHtml {
  let out = strings[0] ?? "";
  values.forEach((value, i) => {
    out += renderValue(value);
    out += strings[i + 1] ?? "";
  });
  return raw(out);
}

/** Join a list of RawHtml/HtmlValue fragments with no separator — sugar for `${fragments}` inside a template where an array already works, kept for call sites that build the list outside a template literal. */
export function joinHtml(fragments: HtmlValue[]): RawHtml {
  return raw(fragments.map(renderValue).join(""));
}
