# S1/S2 Findings — Harness sniffing & transcript locations

Spikes S1 and S2 from `v0-implementation-plan.md` §2. Feeds **C1** (`slop start` harness sniff) and **C4** (transcript capture). This is a throwaway research doc, not a spec — cite it, don't copy code out of it uncritically, and re-verify anything marked `inferred`/`unknown` before shipping.

**Method.** This session runs inside a live Claude Code session, so S1/S2 §1 (Claude Code) is verified directly against the running process's own environment and its own transcript file. opencode (`opencode --version` → `1.15.12`, installed at `~/.opencode/bin/opencode`) and Codex CLI (`codex --version` → `codex-cli 0.133.0`, `@openai/codex` npm wrapper around a native Rust binary) are **both installed locally** on this machine, so those were investigated empirically too — reading the installed binaries' own embedded source strings, running their real `--help`/subcommands, and querying their real on-disk stores — cross-checked against public docs and GitHub issues where reachable. Nothing here required guessing "from training data alone" for Claude Code or opencode; Codex's detection story specifically has real gaps, called out below.

---

## 1. S1 — Detection table

| harness kind | primary positive-ID var(s) | secondary / weaker signals | confidence | session id from env? |
|---|---|---|---|---|
| `claude-code` | `CLAUDECODE=1` | `CLAUDE_CODE_CHILD_SESSION=1` (only set in *subprocesses* Claude Code spawns — Bash/PowerShell/Monitor tools, hooks, status line; **not** set for a top-level `claude` in an IDE terminal, and not for stdio MCP subprocesses), `CLAUDE_CODE_ENTRYPOINT=cli`, `CLAUDE_CODE_EXECPATH=<install path>` | **verified-empirically + documented** (official page, see §5) | **YES** — `CLAUDE_CODE_SESSION_ID` (see caveat below — undocumented) |
| `opencode` | `OPENCODE=1` | `OPENCODE_PID=<pid>`, `AGENT=1` (too generic on its own — don't use alone) | **verified-empirically** (read out of the installed v1.15.12 binary's own source strings); **not publicly documented** anywhere found | **NO** (confirmed absent — see below) |
| `codex` | *no confirmed universal var* | `CODEX_SANDBOX_NETWORK_DISABLED=1` (set whenever the sandbox's network policy is restricted — the default for shell-tool-executed commands), `CODEX_SANDBOX=seatbelt` (macOS-only per source; Linux value unconfirmed) | **documented (community-sourced) for `CODEX_SANDBOX_NETWORK_DISABLED`; inferred for `CODEX_SANDBOX` on Linux** | **NO** — checked Codex's own documented env-vars page and the installed binary's strings; no session/thread id is exposed to the environment |
| `other` | — | — | n/a (default bucket) | n/a — `harness.session_id` stays `null` |

### 1.1 Claude Code detail

Observed in this session's own `env | sort` (full dump kept out of the repo; reproduced below with nothing sensitive):

```
CLAUDECODE=1
CLAUDE_CODE_CHILD_SESSION=1
CLAUDE_CODE_ENTRYPOINT=cli
CLAUDE_CODE_EXECPATH=/home/ryan/.local/share/claude/versions/2.1.218
CLAUDE_CODE_SESSION_ID=e918eac1-44bc-4d17-84dd-9a68736f92e4
CLAUDE_EFFORT=xhigh
CLAUDE_PID=4082
```

`CLAUDE_CODE_SESSION_ID`'s value is an **exact match** for the UUID in this session's real transcript path (the data point given in the task: `.../e918eac1-44bc-4d17-84dd-9a68736f92e4.jsonl`). That's about as strong a verification as a spike can produce.

Cross-checked against Anthropic's official docs (`https://code.claude.com/docs/en/env-vars`, fetched live): `CLAUDECODE` and `CLAUDE_CODE_CHILD_SESSION` **are** documented, with exactly the semantics above (including the v2.1.172+ version gate on `CLAUDE_CODE_CHILD_SESSION`). `CLAUDE_CODE_SESSION_ID` is **not** on that page — it is a real, currently-working, but **undocumented/internal** variable (a GitHub issue thread on `anthropics/claude-code` explicitly frames it as "an internal implementation detail rather than a documented public API"). Treat it as reliable-today, not as a stable contract; code must tolerate its absence gracefully (fall through, don't error).

The docs also mention `CLAUDE_CODE_BRIDGE_SESSION_ID` — do **not** confuse this with the session id we want. It's only set during an active Remote Control (`claude.ai/code`) bridge connection, holds a `session_...`-form web id, and disappears when that connection ends. Not a general-purpose local session id.

`AI_AGENT=claude-code_2-1-218_agent` was also observed in the env dump but is almost certainly **user/shell tooling on this specific machine** (couldn't find it set by any Claude Code shipped file; the value's format looks hand-rolled), not something Claude Code itself sets — excluded from the detection table, flagged so nobody cargo-cults it.

`ANTHROPIC_*` vars (API keys, base URL overrides, etc.) were **absent entirely** from this session's env (this account uses non-API-key auth) — even when present in other setups, they're auth/config, not identity, and `ANTHROPIC_API_KEY` is a credential — never log it, never use it as a detection signal (a bare API key can be set for direct-SDK use with zero relationship to Claude Code).

### 1.2 opencode detail

No public documentation defines an opencode-detection variable. Two GitHub feature requests asked for exactly this and both come back negative:
- `anomalyco/opencode#1775` ("environment variable to detect OPENCODE") — feature request, no confirmed implementation.
- `anomalyco/opencode#9292` ("Expose session context to child processes via environment variables", proposing `OPENCODE_SESSION_ID` / `OPENCODE_SESSION_TITLE`) — **closed as not planned**.

However, the installed binary (`~/.opencode/bin/opencode`, v1.15.12, 145MB, unstripped) contains its own literal, readable source in a yargs middleware that runs before any subprocess is spawned:

```js
process.env.AGENT="1", process.env.OPENCODE="1", process.env.OPENCODE_PID=String(process.pid)
```

Node's `child_process.spawn` inherits `process.env` by default, so any command opencode's Bash tool runs (i.e., anything `slop start` would see) inherits `OPENCODE=1` and `OPENCODE_PID=<opencode's pid>`. This is **real, verified against the shipped binary**, just not a documented/stable public contract — re-verify against whatever version is actually deployed when C1 is built (current upstream is v1.18.4 per `anomalyco/opencode`'s releases; this machine's install is a few minor versions behind, and the project has 800+ releases, i.e. ships very fast).

`OPENCODE_SESSION_ID` genuinely does not exist in this binary (`strings <binary> | grep OPENCODE_SESSION` → nothing) — confirms the closed issue's outcome. **There is no way to read opencode's own conversation-session id from the environment today.**

### 1.3 Codex detail

Codex's own documented environment-variables page (`developers.openai.com/codex/config-file/environment-variables`, redirects to `learn.chatgpt.com/...`) lists: `CODEX_HOME`, `CODEX_SQLITE_HOME`, `CODEX_NON_INTERACTIVE`, `CODEX_INSTALL_DIR`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `CODEX_CA_CERTIFICATE`, `SSL_CERT_FILE`, `RUST_LOG`. **None of these is an identity or session-id variable.**

Also worth knowing: Codex's `shell_environment_policy` config controls which *host* env vars get forwarded into commands it runs — by default this is a trimmed set, not the full host environment (`-c shell_environment_policy.inherit=all` is the escape hatch mentioned in `codex --help`). This doesn't affect vars Codex *injects itself* (see below), only vars it might otherwise pass through from the user's shell.

The only Codex-injected signals found are sandbox-state flags, sourced from public GitHub issue discussion (community-documented, not on the official page) and corroborated by their literal presence as strings in the installed Rust binary:
- `CODEX_SANDBOX_NETWORK_DISABLED=1` — set whenever the sandbox's network policy is restricted. This is the **default** for model-run shell commands (sandboxed exec is the default posture), but is absent if the user runs with `--dangerously-bypass-approvals-and-sandbox` or `--sandbox danger-full-access`.
- `CODEX_SANDBOX=seatbelt` — per a source comment found via GitHub code search, this is currently documented in-repo as **macOS-only**. The Linux binary's strings table does contain both `"seatbelt"` and `"landlock"` as literals (Linux sandboxing uses bubblewrap/Landlock), but static string extraction couldn't confirm whether `CODEX_SANDBOX` is ever actually set to a Linux-specific value or left unset there. Treat as **inferred, low-confidence on Linux**.

Net effect: **Codex has no reliable universal "I am Codex" signal.** `--harness codex` should be the *primary*, not fallback, path for Codex detection in v0 — this is a legitimate, documented-as-acceptable outcome per the ground rules ("an explicit 'unknown' is a correct answer"), not a gap to paper over.

No session/thread id is exposed to the shell either way (checked the docs page above and the binary's strings — `CODEX_HOME`/`CODEX_SQLITE_HOME` are config-root vars, not identity vars).

### 1.4 One factual correction worth flagging

The task (and much of the public conversation) refers to opencode's repo as `sst/opencode`. As of this spike, `github.com/sst/opencode` **301-redirects** to `github.com/anomalyco/opencode` (verified via raw `curl -I` headers, not an LLM summary) — the project moved/renamed. `github.com/openai/codex` has **not** moved.

---

## 2. Detection precedence rule

```
1. --harness <kind> flag, if passed by the operator/agent → use it verbatim, skip all sniffing.
   This ALWAYS wins (D17). No exceptions, no "but the env disagrees" override.

2. Otherwise, sniff in this fixed order (first match wins, never throw):
   a. process.env.CLAUDECODE === "1"                                → "claude-code"
   b. process.env.OPENCODE === "1"                                  → "opencode"
   c. process.env.CODEX_SANDBOX_NETWORK_DISABLED !== undefined
      || process.env.CODEX_SANDBOX !== undefined                    → "codex"   (best-effort/weak)

3. No match → "other". This is a legitimate, first-class result, not an error path.
   harness.session_id stays null for "other".

4. Session id capture (only after kind is known):
   - "claude-code" → read CLAUDE_CODE_SESSION_ID; if somehow absent, session_id = null (don't error)
   - "opencode"    → session_id = null (nothing to read; see §1.2)
   - "codex"       → session_id = null (nothing to read; see §1.3)
   - "other"       → session_id = null
```

Order between (b) and (c) is arbitrary today (their var namespaces don't collide) but is fixed here for reproducibility — if a future harness sets both an `OPENCODE_*`-shaped and a `CODEX_*`-shaped var for some reason, (b) wins. Detection **must never throw**: wrap the whole sniff in a function that can only return one of the four `HarnessKind` values, defaulting to `"other"` on any unexpected condition (missing env access, weird values, etc.) — this is a hard D9/§4.3 requirement, not a nice-to-have.

---

## 3. S2 — Transcript path patterns per harness

### 3.1 Claude Code — verified empirically

Root: `~/.claude/projects/`. One subdirectory per distinct working directory ever used with `claude`, named by encoding the cwd:

**Encoding rule (as observed): replace every `/` and every `.` in the cwd with `-`.** A leading `/` becomes a leading `-`.

Confirmed on two live directories on this machine, both matched against the *unencoded* cwd strings stored separately in `~/.claude.json`'s `projects` map:

| cwd (from `~/.claude.json`) | encoded dir (found under `~/.claude/projects/`) |
|---|---|
| `/home/ryan/go/src/github.com/ryanskidmore/poe2` | `-home-ryan-go-src-github-com-ryanskidmore-poe2` |
| `/home/ryan/go/src/github.com/ryanskidmore/slopwork` | `-home-ryan-go-src-github-com-ryanskidmore-slopwork` |

Note `github.com` → `github-com` — confirms `.` is encoded, not just `/`. **Not tested:** underscores, pre-existing hyphens, spaces, or non-ASCII in a path segment — no such example existed on this machine (`~/.claude.json` only lists 4 project paths total, and 2 of those never even got a transcripts directory — see the failure-mode note below). Don't over-trust the rule for exotic paths; the locator spec in §5 includes a defensive fallback specifically to route around this gap.

Inside a project dir: the transcript is `<session-uuid>.jsonl` (one JSON object per line) — directly at the top of the project dir, confirmed byte-for-byte against the task's given data point and against `CLAUDE_CODE_SESSION_ID`. There is **also** a same-named subdirectory `<session-uuid>/` containing `subagents/` and `tool-results/` — this is auxiliary data (subagent transcripts, cached tool output), **not** the main transcript. Don't glob-copy the whole project directory; copy exactly the `.jsonl` file.

**Failure mode confirmed live:** a project directory can exist with **zero** `.jsonl` files in it. `~/.claude/projects/-home-ryan-go-src-github-com-ryanskidmore-poe2/` contains only a `memory/` subdirectory (an unrelated long-running-memory feature) — no transcripts at all, presumably pruned by some retention/cleanup process (a `.last-cleanup` marker file exists under `~/.claude/`). The locator must treat "directory exists but has no `.jsonl` files" as a normal `null` result, not an error.

### 3.2 opencode — verified empirically (installed v1.15.12; re-verify against whatever version actually ships)

Two generations of storage exist on this machine — evidence that opencode's storage format has changed under its users at least once already:

- **Legacy (flat JSON files, superseded)**: `$XDG_DATA_HOME/opencode/project/<encoded-cwd>/storage/session/{info,message}/*.json`. `<encoded-cwd>` here drops the leading `-` that Claude Code's rule produces (e.g. cwd `.../ryanskidmore/hyperlinks` → dir `home-ryan-go-src-...-ryanskidmore-hyperlinks`, no leading dash) — a different encoding from Claude Code's. Not inspected for internal record shape: it's clearly deprecated (`opencode db migrate` — "migrate JSON data to SQLite" — exists specifically to absorb it), low priority.
- **Current (SQLite)**: a single database file, path given by the CLI itself (`opencode db path` → on this machine, `/home/ryan/.local/share/opencode/opencode.db`; `opencode debug paths` confirms the same XDG-style layout: `data`, `log`, `cache`, `config`, `state`, `tmp` all under standard locations). Schema (Drizzle ORM, confirmed via `.schema` on the real file): table `session` (`id`, `project_id`, `directory`, `title`, `time_created`, `time_updated`, …), table `message` (`id`, `session_id`, `data` — a JSON blob column), table `part`. **There is no flat transcript file on disk by default for a session in this version.**
- **Supported extraction path** (the CLI provides this, no need to touch the DB directly): `opencode export <sessionID> [--sanitize]` — writes a single pretty-printed **JSON object** to stdout, shape `{ info: {id, slug, directory, title, time, tokens, cost, model, agent, ...}, messages: [{info, parts}, ...] }`. **This is not JSONL** — see Open Risk #1. `opencode session list [--format table|json] [-n N]` lists sessions, filtered to the current cwd by default (`--all` disables that filter) — this is the practical way to find "the most recent session for this project" without touching the DB directly. Ran this in `slopwork`'s own (opencode-virgin) directory and got a clean empty result (exit 0, no output) — confirms the command degrades gracefully with no sessions rather than erroring.
- Session id format observed live: `ses_<random>` (e.g. `ses_18604e184ffebZf2ac4X6mnEi6`).
- No session id is exposed via env (§1.2) — so "which session is the current one" cannot be determined from inside a running opencode shell without an explicit `--harness`/`--transcript` hand-off from the operator, or a cwd+recency heuristic against `opencode session list`.

### 3.3 Codex — verified empirically (installed codex-cli 0.133.0)

Root: `$CODEX_HOME` (documented, defaults to `~/.codex`).

Transcripts ("rollouts" in Codex's own terminology): `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp-with-dashes>-<uuid>.jsonl`. Confirmed live on this machine:

```
~/.codex/sessions/2026/05/26/rollout-2026-05-26T01-37-49-019e6300-fa61-7242-a47e-7617067c7bff.jsonl
```

This **is** native JSONL (one JSON object per line), unlike opencode. First line is a `session_meta` record:

```json
{"timestamp": "...", "type": "session_meta",
 "payload": {"id": "019e6300-fa61-7242-a47e-7617067c7bff", "timestamp": "...", "cwd": "...",
             "originator": "codex-tui", "cli_version": "0.133.0", "source": "cli",
             "thread_source": "user", "base_instructions": {...}, "git": {"commit_hash", "branch", "repository_url"}}}
```

`payload.id` is an exact match for the UUID in the filename. `payload.cwd` records the working directory the session was started in — this is the field to filter candidate rollout files by, since (unlike Claude Code) Codex's on-disk layout is partitioned by **date**, not by project. Subsequent lines are `event_msg` (turn/thread bookkeeping) and `response_item` records shaped like `{"type": "response_item", "payload": {"type": "message", "role": "user"|"assistant", "content": [{"type": "input_text"|"output_text", "text": "..."}]}}`.

`codex resume [SESSION_ID] [--last] [--all]` confirms Codex tracks "most recent session for the current cwd" internally (cwd-filtered picker by default, `--all` disables filtering) — but it's an interactive/picker UX; we did not find (or need, for v0) a scriptable non-interactive "give me the current session id" query.

No session/thread id is exposed via env for a running shell — see §1.3.

---

## 4. JSONL record shape — Claude Code (detail, feeds D5's transcript viewer)

Fields present on essentially every conversation-adjacent record: `type`, `uuid`, `parentUuid`, `sessionId`, `isSidechain`, `userType`, `cwd`, `version`, `timestamp`, `gitBranch`.

- **`type: "user"`** → `message: { role: "user", content: string | block[] }`. Plain-string content for a simple typed message; a block array otherwise.
- **`type: "assistant"`** → `message: { id, type, role: "assistant", model, content: block[], stop_reason, stop_sequence, usage, container, context_management }`.
- Block `type`s observed inside `content` arrays across the transcript: `text` (`{type, text}`), `thinking` (`{type, thinking, ...}`), `tool_use` (`{type, id, name, input, caller}`), `tool_result` (`{type, tool_use_id, content}`).
- **`type: "system"`** → meta-only record: `isMeta`, `subtype`, `durationMs`, `messageCount`. No `message` field — these are session bookkeeping (e.g. compaction boundaries), not conversation turns.
- Other top-level `type`s observed that carry **no conversation content** and are safe for a transcript viewer to skip/hide by default: `last-prompt`, `mode`, `permission-mode`, `attachment`, `file-history-snapshot`, `ai-title`, `file-history-delta`, `queue-operation`. A first-pass D5 viewer can filter to `type in {"user","assistant"}` and get a clean conversation view; `system` records are useful as dividers/annotations if wanted later.

(Only structural shape was inspected — field names, types, block kinds — never the actual message text, per the task's ground rules.)

---

## 5. Locator function spec for C4

```ts
type HarnessKind = "claude-code" | "opencode" | "codex" | "other";

interface HarnessInfo {
  kind: HarnessKind;
  sessionId: string | null; // from S1 §2 step 4
}

// Returns an absolute path to a transcript readable NOW (to be copied/exported into
// .slop/transcripts/session_<ulid>.jsonl), or null if nothing could be found.
// MUST NOT throw.
function locateTranscript(
  harness: HarnessInfo,
  cwd: string,
  explicitTranscriptPath?: string,
): string | null;
```

**Ordered strategy** (applies uniformly, per §4.3 of `design.md`):

1. **`--transcript <path>` flag**, if the operator passed one → if the file exists, return it verbatim and stop. This is the universal manual escape hatch and works identically regardless of `harness.kind` (including `"other"`).
2. **Env-derived session id**, harness-specific:
   - `claude-code`: encode `cwd` per §3.1's rule → `dir = "~/.claude/projects/" + encode(cwd)`; candidate = `dir + "/" + harness.sessionId + ".jsonl"`. If that exact path doesn't exist (encoding-rule edge case — see §3.1's untested-characters caveat), defensively glob `~/.claude/projects/*/` + `harness.sessionId + ".jsonl"` (bounded and cheap — it's an exact-filename match against a known unique UUID, not a scan). Return the first hit.
   - `opencode`: `harness.sessionId` is always `null` today (§1.2/§3.2) — this step is a no-op, fall through to step 3.
   - `codex`: `harness.sessionId` is always `null` today (§1.3/§3.3) — this step is a no-op, fall through to step 3.
3. **Newest-mtime heuristic**, scoped per harness (last resort before giving up):
   - `claude-code`: newest `*.jsonl` by mtime directly inside `~/.claude/projects/<encode(cwd)>/`. If the directory doesn't exist or has zero `.jsonl` files (confirmed real case, §3.1), return `null`.
   - `codex`: newest `rollout-*.jsonl` under `$CODEX_HOME/sessions/**/` (respect `$CODEX_HOME` if set) **whose first line's `payload.cwd` equals `cwd`** — you must open and parse the first line of each date-bucket candidate, not just glob, since Codex's tree is date-partitioned, not project-partitioned.
   - `opencode`: this isn't a filesystem copy at all — query the sqlite db at `` `opencode db path` `` (or the equivalent XDG default) for `SELECT id FROM session WHERE directory = ? ORDER BY time_updated DESC LIMIT 1`, then shell out to `opencode export <id> --sanitize` and capture stdout to the destination path. Treat any failure (db locked, opencode not on `$PATH`, no matching row) as `null`, not a thrown error.
   - `other`: always `null` (nothing to heuristically search — there is no known on-disk convention).
4. **Nothing found** at any step → return `null`.

**Known-unsound case, must be called out in code comments and covered by a test:** step 3's "newest mtime / newest `time_updated`" heuristic is **not safe under concurrency**. Two concurrent sessions in the same repo/cwd (a first-class scenario per this project's own multi-agent design goal) both have very recent mtimes/`time_updated` values while active — "newest" answers "which session touched this project most recently," not "which one is *mine*." This is exactly why step 2 (an explicit, harness-captured session id) must always be preferred when available, and why **C1's `start` should capture `CLAUDE_CODE_SESSION_ID` once, at session-start time, into the session entity** — rather than re-deriving "the current session" later at `stop`/`review`/`done` time via a heuristic that can silently pick the *other* concurrent agent's transcript.

---

## 6. Non-negotiable fallback behaviour (§4.3, restated for emphasis)

If `locateTranscript` returns `null` at session end (`stop`/`review`/`done`): print/log a warning, write `transcript_ref: null` into the session record, and the state transition **must still succeed** — never block a `stop`/`review`/`done` on a missing transcript. This holds for every `harness.kind`, including `"other"` and including Codex (where, per §1.3, `--harness codex` combined with no `--transcript` flag will routinely hit this path in v0 until a better Codex signal exists).

---

## 7. Open risks & flags for whoever implements C1/C4/D5

1. **opencode export format mismatch.** `opencode export` produces one pretty-printed JSON object (`{info, messages}`), not JSONL — copying it straight to `session_<ulid>.jsonl` gives a file with the wrong internal shape relative to Claude Code's and Codex's native line-delimited JSON. This needs an explicit decision at C4/D5 implementation time (normalize to one-JSON-per-line during capture, or teach D5's viewer to sniff and handle both shapes) — deliberately **not resolved here**, it's implementation work, not spike work.
2. **opencode's detection signal (`OPENCODE=1`) is unofficial.** It works today against the installed v1.15.12 binary (read directly out of its own source), but was found nowhere in opencode's public docs and is unrelated to the two closed GitHub issues asking for exactly this. It could be renamed or removed without notice; re-check against whatever version actually ships when C1 is built (upstream is already 3+ minor versions ahead, project ships very fast — 800+ releases).
3. **Codex has no confirmed universal detection var.** `CODEX_SANDBOX_NETWORK_DISABLED`/`CODEX_SANDBOX` are conditional (only fire under the default sandboxed-exec posture; absent if the user disabled sandboxing) and `CODEX_SANDBOX`'s Linux behavior specifically could not be confirmed from static binary inspection alone. Treat `--harness codex` as Codex's *primary* detection path in v0, not a fallback — this is a documented, acceptable outcome per the plan's own risk #2 ("manual `--transcript` fallback is a documented, acceptable v0 answer for any harness that resists").
4. **Claude Code's cwd-encoding rule is under-tested.** Confirmed on 2 real directories sharing the same path prefix (`/home/ryan/go/src/github.com/ryanskidmore/...`); no character set outside `[a-z0-9/.-]` was available to test on this machine. The glob-by-session-id fallback baked into §5 step 2 exists specifically so the locator doesn't have a hard dependency on getting the encoding rule perfectly right.
5. **`CLAUDE_CODE_SESSION_ID` is undocumented.** Real and reliable in this session (byte-for-byte verified against the known transcript path), but absent from Anthropic's official env-vars page — an internal detail, not a contract. Code must treat its absence as ordinary (fall through to the mtime heuristic), never as an error.
6. **Directories can exist with zero transcripts** (confirmed live for one real Claude Code project on this machine, likely a retention/cleanup interaction) — the mtime-fallback path must return `null` cleanly in that case, not throw on an empty glob.
7. **`AI_AGENT` env var is a local-machine artifact**, not a Claude Code signal — flagged so it doesn't leak into the detection table by accident.
8. **Repo rename**: opencode's canonical repo is now `github.com/anomalyco/opencode` (formerly `sst/opencode`, which still 301-redirects there). If anyone goes spelunking in opencode source later, search under the new org.
