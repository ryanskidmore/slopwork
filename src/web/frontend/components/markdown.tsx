/**
 * Renders markdown the SERVER already converted to sanitized HTML
 * (src/web/markdown.ts's `renderMarkdownToString` -> `sanitizeMarkdownHtml`
 * — every `spec.details_html`/`resolution_html`
 * field in the API contract). `dangerouslySetInnerHTML` is safe here
 * specifically BECAUSE the server already stripped raw HTML and neutralised
 * any `javascript:`/`data:` href/src before this ever reaches the client —
 * this component does not, and must not, re-parse or re-sanitize; it is
 * purely a typography wrapper (`.prose-slop`, index.css).
 */
export function Markdown({ html, className }: { html: string; className?: string }) {
  if (!html.trim()) return null;
  // dangerouslySetInnerHTML is intentional here — see module doc: the HTML
  // arrived pre-sanitized from the server, this component never sanitizes.
  return (
    <div className={`prose-slop ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
