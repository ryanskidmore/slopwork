/**
 * Ambient types for the two build-generated SPA assets server.ts imports
 * with `with { type: "text" }` (Bun's text-loader import attribute) — how
 * the bundled React app's JS/CSS get embedded into the compiled binary.
 * `scripts/build-frontend.ts` (via `bun run build:web`, a `pretest`/
 * `prebuild` dependency — see package.json) produces
 * `src/web/generated/{app.js,app.css}` from `src/web/frontend/`; both are
 * git-ignored build output, exactly like `dist/`.
 *
 * Scoped to the exact generated paths (wildcard only on the leading path
 * segment), rather than a bare `declare module "*.js"` — a bare wildcard on
 * the `.js` extension risks shadowing this project's normal
 * `verbatimModuleSyntax` convention of importing sibling `.ts` modules via
 * a `.js` specifier (e.g. `from "../core/index.js"`), which must keep
 * resolving to its real exports.
 */
declare module "*/generated/app.js" {
  const content: string;
  export default content;
}

declare module "*/generated/app.css" {
  const content: string;
  export default content;
}
