/**
 * Shared `--label` grammar rule, used by both `new` (tickets/new.ts) and
 * `update` (tickets/update.ts's `parseLabelOp`) — the bug this closes:
 * `update --label` requires a leading `+`/`-` sigil (add/remove — see
 * `parseLabelOp`), but `new --label` took whatever text was given
 * verbatim, with no sigil concept at all (`new` only ever adds). That let
 * `slop new x --label +bug` silently store the literal label `"+bug"`
 * (exit 0, no warning) — indistinguishable, to a human or agent skimming
 * `slop show`, from a label that merely happens to start with `+`. A
 * later `slop update x --label -bug` (trying to remove the label the
 * agent THINKS is `"bug"`) then parses as sigil `-`, label `"bug"` —
 * which was never actually stored, so it's silently a no-op, while the
 * real stored label `"+bug"` lingers untouched.
 *
 * The fix: a bare label's content (whatever ultimately gets STORED, after
 * `update`'s own `±` sigil — if any — has already been stripped) may
 * never itself start with `+`/`-`. Enforced in exactly one place so
 * `new`/`update` can never again drift apart on what a "valid label" is.
 */
import { EXIT_CODES } from "../core/exit-codes.js";
import { SlopError } from "../cli/errors.js";

const LABEL_SIGILS = new Set(["+", "-"]);

/**
 * Reject a label whose content starts with `+`/`-` — those characters are
 * reserved for `update --label <±label>`'s add/remove sigil and are never
 * legal as part of the stored label text itself, on EITHER command:
 *   - `new --label <label>`: `label` is checked as given (verbatim, `new`
 *     has no sigil of its own — it only ever adds).
 *   - `update --label <±label>`: `label` is checked AFTER `parseLabelOp`
 *     strips the leading `+`/`-` op sigil, catching the doubled-sigil case
 *     (`--label ++bug`, `--label +-bug`) the same way.
 * Throws a `USAGE_ERROR` `SlopError` naming the flag and offending value,
 * suggesting the sigil-stripped label as the likely intent, rather than
 * silently accepting text a later `update --label` can never subsequently
 * address correctly.
 */
export function assertLabelHasNoLeadingSigil(label: string, flag: string): void {
  const first = label.charAt(0);
  if (LABEL_SIGILS.has(first)) {
    throw new SlopError(
      `${flag} "${label}": a label can't start with "${first}" — that's update's ±label ` +
        `add/remove syntax, not part of the label text itself. Did you mean "${label.slice(1)}"?`,
      EXIT_CODES.USAGE_ERROR,
    );
  }
}
