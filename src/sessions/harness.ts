/**
 * Harness detection (S1, `docs/spikes/findings.md` §1-§2; D9/D17; design.md
 * §4.3) — work item C1.
 *
 * This is THE canonical place a harness kind + its own session id get
 * sniffed from the environment. `slop start` (src/cli/commands/start.ts)
 * captures the result ONCE into the Session entity at session-start time —
 * see `docs/spikes/findings.md` §5's "Known-unsound case": never re-derive
 * "which session is mine" later via a newest-mtime heuristic, since two
 * concurrent agents in one repo is a first-class scenario here, and that
 * heuristic answers "which session touched this project most recently",
 * not "which one is *mine*". C4 (transcript capture) needs this exact
 * detection result too — import {@link detectHarness}/
 * {@link sniffHarnessKind} from here rather than re-deriving the sniff.
 * `src/cli/actor.ts`'s D17 actor `kind` (human/agent) resolution is also
 * built directly on {@link sniffHarnessKind} (see that module).
 *
 * Precedence (`docs/spikes/findings.md` §2), reproduced:
 *   1. `--harness <kind>` flag, if passed — ALWAYS wins, no exceptions,
 *      no "but the env disagrees" override (D17).
 *   2. Otherwise, sniff in this fixed order, first match wins, never throw:
 *      a. `CLAUDECODE === "1"`                                  -> "claude-code"
 *      b. `OPENCODE === "1"`                                    -> "opencode"
 *      c. `CODEX_SANDBOX_NETWORK_DISABLED !== undefined
 *          || CODEX_SANDBOX !== undefined`                      -> "codex" (weak signal)
 *   3. No match -> "other". A legitimate, first-class result, not an
 *      error path — `harness.session_id` stays `null`.
 *   4. Session id, only once `kind` is known:
 *      - "claude-code": `CLAUDE_CODE_SESSION_ID` if present and non-empty,
 *        else `null` (real but undocumented/internal — see findings.md
 *        §1.1/§1.4 — must degrade to `null`, never error, if absent).
 *      - everything else ("opencode"/"codex"/"other"): always `null` — no
 *        harness besides Claude Code exposes a session id to the
 *        environment today (findings.md §1.2/§1.3).
 *
 * MUST NOT throw under any condition (findings.md §2, design.md §4.3): a
 * detection failure degrades to `{kind: "other", session_id: null}`
 * rather than ever blocking `start`.
 */
import { type Harness, type HarnessKind, harnessKindSchema } from "../core/index.js";

/**
 * Sniff order steps (a)-(c) only — no `--harness` override, no session id.
 * Exported on its own because `src/cli/actor.ts`'s D17 `kind` (human/agent)
 * resolution is built on exactly this narrower question ("is *some* agent
 * harness driving this process at all"), and needs it independent of
 * whichever command's `--harness` flag (if any) is in scope.
 */
export function sniffHarnessKind(env: NodeJS.ProcessEnv): HarnessKind {
  try {
    if (env.CLAUDECODE === "1") return "claude-code";
    if (env.OPENCODE === "1") return "opencode";
    if (env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined || env.CODEX_SANDBOX !== undefined) {
      return "codex";
    }
    return "other";
  } catch {
    // Defensive only — plain property reads on `env` don't throw in
    // practice, but "never throw" is a hard requirement here (see module
    // doc), not a best-effort.
    return "other";
  }
}

function sessionIdForKind(kind: HarnessKind, env: NodeJS.ProcessEnv): string | null {
  try {
    if (kind === "claude-code") {
      const raw = env.CLAUDE_CODE_SESSION_ID;
      return typeof raw === "string" && raw.trim().length > 0 ? raw : null;
    }
    return null;
  } catch {
    return null;
  }
}

export interface DetectHarnessOptions {
  /**
   * `--harness <kind>` flag value, if the calling command registered one.
   * Always wins over sniffing (D17, findings.md §2 step 1) — validated
   * against the known `HarnessKind` enum here defensively (never throws:
   * an unrecognised value falls back to sniffing rather than erroring,
   * though the CLI layer should validate eagerly with a clear usage error
   * before it ever reaches here — see start.ts's `parseHarnessFlag`).
   */
  harnessFlag?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * The full detection result: kind + the harness's own session id, if any.
 * Never throws — see the module doc.
 */
export function detectHarness(options: DetectHarnessOptions = {}): Harness {
  const env = options.env ?? process.env;
  let kind: HarnessKind;
  try {
    if (options.harnessFlag !== null && options.harnessFlag !== undefined) {
      const parsed = harnessKindSchema.safeParse(options.harnessFlag);
      kind = parsed.success ? parsed.data : sniffHarnessKind(env);
    } else {
      kind = sniffHarnessKind(env);
    }
  } catch {
    kind = "other";
  }
  return { kind, session_id: sessionIdForKind(kind, env) };
}
