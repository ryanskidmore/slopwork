/**
 * URL scheme allowlist for anything the JSON API hands the SPA as a live
 * link target (an MR/PR URL, a `remotes.jira` browse URL, an `href`/`src`
 * inside server-rendered markdown HTML). Carried forward from the
 * server-rendered UI's `src/web/html.ts` (now deleted — this rewrite has no
 * more server-side HTML templating, only this one still-load-bearing
 * function) as part of rewrite-slop-web-as-a's "carry forward every wave-1
 * hardening fix" requirement.
 *
 * Absolute URLs must use http/https/mailto. A reference with no scheme at
 * all (`/tickets/123`, `./x`, `#frag`, `?q=1`) is a same-document or
 * relative reference and can't carry an executable scheme, so it passes
 * through unchecked. A `//host/path` protocol-relative reference *does*
 * resolve through a scheme (the page's own) even though it doesn't spell
 * one out, so it's deliberately excluded from that free pass.
 *
 * `src/web/markdown.ts` reuses this verbatim so the markdown-link guard and
 * every other URL guard in this codebase can never drift apart.
 */
const SAFE_URL_SCHEMES = new Set(["http", "https", "mailto"]);

/** Matches a leading `scheme:` per RFC 3986 (letter, then letters/digits/+/-/.). */
const URL_SCHEME_RE = /^([a-zA-Z][a-zA-Z\d+.-]*):/;

/**
 * Returns `rawUrl` (trimmed) if its scheme is on the {@link SAFE_URL_SCHEMES}
 * allowlist or it has no scheme at all (a relative/fragment/query
 * reference), else `null`. Callers route anything destined for a live
 * `href`/`src` through this and fall back to inert text when it returns
 * `null` — never render the raw value as a link anyway.
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
