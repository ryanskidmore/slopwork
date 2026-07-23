/**
 * A small, targeted argv pre-pass fixing one real ergonomic bug found by
 * coordinator smoke-testing of B1: the exact `--label` invocation
 * design.md §4.2 documents — `--label +x -y` (one flag mention, multiple
 * space-separated values, some of them `-`-prefixed) — is something
 * Commander cannot parse on its own.
 *
 * Why it breaks: Commander consumes exactly one following token as
 * `--label`'s value (`+x`), then moves on to the next argv position. That
 * next token, `-y`, doesn't belong to any option or positional argument
 * Commander is expecting there, and because it starts with `-`, Commander
 * treats it as an attempt at a brand-new, unrecognized option and errors
 * (`unknown option '-y'`) rather than silently accepting it as a stray
 * argument. `--priority`/`--progress`/`--name`/`--spec` never hit this:
 * each takes exactly one value, and Commander happily accepts a
 * `-`-prefixed token as THAT single, immediately-following value (verified
 * directly against the compiled binary — `--progress "-1 regression"` and
 * `--name "-foo"` both already work) — it's only a *second* space
 * -separated value after an already-satisfied option that Commander has
 * nowhere to put.
 *
 * Fix: rewrite `--label <value1> <value2> ...` into repeated
 * `--label=<value1> --label=<value2> ...` before Commander ever sees the
 * argv — the `--flag=value` form is unambiguous to Commander regardless of
 * what `value` starts with, since it's one token, not two. Only tokens
 * that look like a label value (`+something`/`-something`: a single
 * leading sigil immediately followed by a non-dash character) are
 * absorbed; absorption stops at the first token that doesn't (a real flag
 * like `--priority`, a positional argument, or end of argv). `--label=x`
 * (already unambiguous) and a bare `--label` with nothing value-shaped
 * after it are left completely untouched, so Commander's own "missing
 * required argument" error still fires exactly as it does today.
 *
 * Deliberately scoped to the literal token `"--label"`: no other §4.2
 * option is spelled that way (confirmed against every option registered
 * on `new`/`update`, the only two commands with a `--label` flag), so this
 * never touches any other flag's tokens, on those commands or any other —
 * this is not a general argv rewriter.
 */

const LABEL_VALUE_PATTERN = /^[+-][^\s-].*$/;

function looksLikeLabelValue(token: string | undefined): token is string {
  return token !== undefined && LABEL_VALUE_PATTERN.test(token);
}

export function rewriteLabelArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    i++;
    if (token !== "--label") {
      if (token !== undefined) out.push(token);
      continue;
    }

    // Absorb every consecutive value-shaped token that follows this bare
    // `--label`, each becoming its own unambiguous `--label=<value>`.
    const values: string[] = [];
    while (looksLikeLabelValue(argv[i])) {
      values.push(argv[i] as string);
      i++;
    }

    if (values.length === 0) {
      // Nothing value-shaped follows — leave `--label` exactly as-is.
      out.push(token);
      continue;
    }
    for (const value of values) {
      out.push(`--label=${value}`);
    }
  }
  return out;
}
