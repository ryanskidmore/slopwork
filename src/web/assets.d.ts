/**
 * Ambient types for the two static assets server.ts imports with
 * `with { type: "text" }` (Bun's text-loader import attribute — see
 * server.ts's doc comment for why: this is how the CSS/JS get embedded
 * into the compiled binary).
 *
 * Scoped to the exact assets/style.css and assets/app.js files (wildcard
 * only on the leading path segment), rather than a bare
 * `declare module "*.js"` — a bare wildcard on the `.js` extension risks
 * shadowing this project's normal `verbatimModuleSyntax` convention of
 * importing sibling `.ts` modules via a `.js` specifier (e.g.
 * `from "../core/index.js"`), which must keep resolving to its real
 * exports. (Empirically, a bare wildcard on `.css` alone was resolved
 * fine by `moduleResolution: "bundler"`, but a bare one on `.js` is
 * exactly the risky case this project can't afford, so both are written
 * the same scoped way for consistency.)
 */
declare module "*/assets/style.css" {
  const content: string;
  export default content;
}

declare module "*/assets/app.js" {
  const content: string;
  export default content;
}
