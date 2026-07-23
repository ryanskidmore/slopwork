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
