/**
 * Read/write `.slop/config.yaml` (design.md §3). Shared by `slop init`
 * (writes a fresh config; reads an existing one back for the idempotent
 * re-init path) and `slop instructions` (reads project/jira to interpolate
 * into the rendered rules).
 *
 * This is deliberately NOT a general YAML library — `Bun.YAML` already is
 * one, and is the established convention elsewhere in this codebase (see
 * src/web/fixture-data-source.ts, tests/fixtures/generate-web-db.ts). It
 * isn't usable here: `Bun`-only globals are unavailable inside vitest's
 * test workers (DECISIONS.md's D5 entry, verified directly there — the
 * `Bun` global is `undefined` in a `*.test.ts` file even when `vitest`
 * itself was launched via `bun run test`), and this work item's own
 * acceptance test needs to parse a freshly-written `config.yaml` directly
 * inside a vitest test (`tests/acceptance/D1.test.ts`: "config.yaml
 * parses against the A2 schema with correct autodetected values"), not
 * only via a spawned subprocess.
 *
 * config.yaml's actual shape (per config.ts's zod schema) is narrow: flat
 * string scalars, one level of nested maps (`remotes`, `defaults`), no
 * lists, no numbers/booleans. A restricted-subset hand-rolled
 * parser/writer for exactly that shape is a few dozen lines and fully
 * portable — safer than depending on `Bun.YAML` staying available at
 * runtime forever, and directly testable. Do not extend this into a
 * general YAML parser; if a future config.yaml shape needs lists, nested
 * depth >2, or non-string scalars, that's a new decision, not a silent
 * capability creep here.
 */

function stripComment(line: string): string {
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Index of the `: ` (or end-of-string `:`) that separates `key` from `value`, outside any quotes. `-1` if none. */
function findKeyColon(s: string): number {
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ":" && (i === s.length - 1 || s[i + 1] === " ")) return i;
  }
  return -1;
}

function parseScalar(rest: string): string {
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
    return rest.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (rest.length >= 2 && rest.startsWith("'") && rest.endsWith("'")) {
    return rest.slice(1, -1).replace(/''/g, "'");
  }
  return rest;
}

/**
 * Parse a `config.yaml`-shaped document into a plain object: string
 * scalars, and one level of nested objects for keys written with no
 * inline value (e.g. `remotes:` followed by indented `repo:`/`jira:`
 * lines). Throws with a `<line>: <text>` message on anything outside
 * that restricted shape (a list, deeper nesting, ...) — config.yaml is
 * meant to be simple and hand-editable; a genuinely malformed file should
 * fail loudly rather than silently produce a wrong config.
 */
export function parseConfigYamlText(text: string): unknown {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [
    { indent: -1, obj: root },
  ];

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const withoutComment = stripComment(rawLine);
    if (withoutComment.trim().length === 0) continue;

    const indent = withoutComment.length - withoutComment.trimStart().length;
    const trimmed = withoutComment.trim();
    const colonIdx = findKeyColon(trimmed);
    if (colonIdx === -1) {
      throw new Error(`slopwork config.yaml: cannot parse line: "${rawLine}"`);
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trim();

    while (stack.length > 1 && indent <= (stack[stack.length - 1]?.indent ?? -1)) {
      stack.pop();
    }
    const parentFrame = stack[stack.length - 1];
    if (!parentFrame) {
      throw new Error(`slopwork config.yaml: unexpected indentation: "${rawLine}"`);
    }

    if (rest.length === 0) {
      const nested: Record<string, unknown> = {};
      parentFrame.obj[key] = nested;
      stack.push({ indent, obj: nested });
    } else {
      parentFrame.obj[key] = parseScalar(rest);
    }
  }

  return root;
}

function needsQuoting(value: string): boolean {
  if (value === "") return true;
  if (/^[\s"'#]/.test(value)) return true;
  if (/:( |$)/.test(value)) return true;
  if (/ #/.test(value)) return true;
  if (/^(true|false|null|yes|no|~)$/i.test(value)) return true;
  return false;
}

function yamlScalar(value: string): string {
  if (!needsQuoting(value)) return value;
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/** The bag of values `stringifyConfigYaml` renders — deliberately narrower than the full zod `Config` type: only what `slop init` ever decides at write time. */
export interface ConfigYamlInput {
  project: string;
  /** Omit entirely when detection found nothing (D17: falls back further at read time). */
  user?: string;
  /** Omit entirely when autodetection found no git remote. */
  repo?: string;
  /**
   * `undefined` = never prompted (key absent). `""` = prompted and
   * declined, or explicitly set blank (config.ts's documented
   * distinction). Any other string = the configured Jira base URL.
   */
  jira?: string;
  staleAfter: string;
  reviewStaleAfter: string;
  transcripts: string;
}

/**
 * Render `config.yaml` in design.md §3's exact shape (field order,
 * comments). Always regenerated from a full {@link ConfigYamlInput} —
 * `slop init` only ever calls this once, to create a brand-new
 * config.yaml; an existing one is read back (via
 * {@link parseConfigYamlText}) and left untouched, never re-stringified,
 * so a human's hand-edits (comments included) are never silently
 * reformatted away.
 */
export function stringifyConfigYaml(input: ConfigYamlInput): string {
  const lines: string[] = [`project: ${yamlScalar(input.project)}`];
  if (input.user !== undefined) {
    lines.push(`user: ${yamlScalar(input.user)}                    # actor fallback (D17)`);
  }
  lines.push("remotes:");
  if (input.repo !== undefined) {
    lines.push(`  repo: ${yamlScalar(input.repo)}   # autodetected`);
  }
  if (input.jira !== undefined) {
    lines.push(`  jira: ${yamlScalar(input.jira)}       # prompted or blank`);
  }
  lines.push("defaults:");
  lines.push(`  stale_after: ${input.staleAfter}`);
  lines.push(`  review_stale_after: ${input.reviewStaleAfter}`);
  lines.push(`transcripts: ${input.transcripts}            # local | commit | off`);
  return `${lines.join("\n")}\n`;
}
