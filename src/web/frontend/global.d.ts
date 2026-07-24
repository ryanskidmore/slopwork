/** `main.tsx` imports `./index.css` for its side effect (Tailwind's
 * `bun-plugin-tailwind` build-time loader turns it into a real stylesheet —
 * see scripts/build-frontend.ts); this only tells tsc such an import is
 * legal, it never affects the actual bundle. */
declare module "*.css";
