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
 * | 3    | NOT_IMPLEMENTED| RESERVED, currently unreachable — see below.             |
 * | 4    | NOT_FOUND      | A `<ref>` did not resolve to any entity, or no `.slop/`  |
 * |      |                | repo was found (`requireRepoRoot`, src/repo/paths.ts).   |
 * | 5    | AMBIGUOUS_REF  | A short-prefix or slug `<ref>` matched more than one.    |
 * | 6    | CONFLICT       | Illegal state transition / conflicting operation.        |
 *
 * NOT_IMPLEMENTED (3) was scaffolding for a command registered but not yet
 * built during early v0. By design every §4.2 command shipped a real
 * implementation before v0 was done, so no command throws this today (and
 * no test asserts one does — see tests/acceptance/A1.test.ts's own note on
 * this). Left defined, not repurposed or removed, in case a future command
 * is scaffolded the same way.
 *
 * See also README.md, which documents this table for humans.
 */
export const EXIT_CODES = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  USAGE_ERROR: 2,
  NOT_IMPLEMENTED: 3,
  NOT_FOUND: 4,
  AMBIGUOUS_REF: 5,
  CONFLICT: 6,
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
export type ExitCode = (typeof EXIT_CODES)[ExitCodeName];
