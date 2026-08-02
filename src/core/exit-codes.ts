/**
 * Process exit codes for the `slop` CLI.
 *
 * This table is the contract work item E1 ("an agent can branch on exit
 * codes") builds on — it is fixed here in A1 so every later work item
 * emits one of these codes and nothing else. Never `process.exit()` with a
 * bare number outside this module; import {@link EXIT_CODES} instead.
 *
 * | Code | Name           | Meaning                                                |
 * |------|----------------|---------------------------------------------------------|
 * | 0    | SUCCESS        | Command completed successfully.                         |
 * | 1    | GENERIC_ERROR  | Unexpected runtime error (I/O failure, bug, etc.).       |
 * | 2    | USAGE_ERROR    | Bad invocation — missing/invalid args or flags.          |
 * | 4    | NOT_FOUND      | A `<ref>` did not resolve to any entity, or no `.slop/`  |
 * |      |                | repo was found (`requireRepoRoot`, src/repo/paths.ts).   |
 * | 5    | AMBIGUOUS_REF  | A short-prefix or slug `<ref>` matched more than one.    |
 * | 6    | CONFLICT       | Illegal state transition / conflicting operation.        |
 *
 * Code `3` is a deliberate gap, not a typo: it was `NOT_IMPLEMENTED`,
 * scaffolding for a command registered but not yet built during early v0.
 * No command ever threw it (every §4.2 command shipped a real
 * implementation before v0 was done), so G5's simplification sweep
 * (t-uy8vo) removed it outright rather than leave reserved-but-unreachable
 * surface around. The remaining codes keep their original numbers —
 * `4`/`5`/`6` are NOT renumbered down to fill the gap, since any of them
 * appearing in an agent's existing exit-code-branching logic must keep
 * meaning exactly what it always has.
 *
 * See also README.md, which documents this table for humans.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,
  NOT_FOUND: 4,
  AMBIGUOUS_REF: 5,
  CONFLICT: 6,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];
