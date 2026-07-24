import { describe, expect, it } from "vitest";
import { detectHarness, sniffHarnessKind } from "./harness.js";

describe("sniffHarnessKind (docs/spikes/findings.md §2 precedence)", () => {
  it("detects claude-code via CLAUDECODE=1", () => {
    expect(sniffHarnessKind({ CLAUDECODE: "1" })).toBe("claude-code");
  });

  it("detects opencode via OPENCODE=1", () => {
    expect(sniffHarnessKind({ OPENCODE: "1" })).toBe("opencode");
  });

  it("detects codex via either sandbox var (weak signal)", () => {
    expect(sniffHarnessKind({ CODEX_SANDBOX_NETWORK_DISABLED: "1" })).toBe("codex");
    expect(sniffHarnessKind({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
  });

  it("falls back to 'other' — a legitimate result, not an error — for a plain shell env", () => {
    expect(sniffHarnessKind({})).toBe("other");
  });

  it("claude-code beats opencode beats codex when multiple signals are somehow present (fixed order, step (a) first)", () => {
    expect(sniffHarnessKind({ CLAUDECODE: "1", OPENCODE: "1", CODEX_SANDBOX: "seatbelt" })).toBe(
      "claude-code",
    );
    expect(sniffHarnessKind({ OPENCODE: "1", CODEX_SANDBOX: "seatbelt" })).toBe("opencode");
  });

  it("CLAUDECODE set to anything other than the literal string '1' does not count", () => {
    expect(sniffHarnessKind({ CLAUDECODE: "0" })).toBe("other");
    expect(sniffHarnessKind({ CLAUDECODE: "true" })).toBe("other");
  });
});

describe("detectHarness", () => {
  it("captures CLAUDE_CODE_SESSION_ID when sniffed as claude-code", () => {
    const harness = detectHarness({
      env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "e918eac1-44bc-4d17-84dd-9a68736f92e4" },
    });
    expect(harness).toEqual({
      kind: "claude-code",
      session_id: "e918eac1-44bc-4d17-84dd-9a68736f92e4",
    });
  });

  it("session_id is null for claude-code when CLAUDE_CODE_SESSION_ID is absent (undocumented var — must degrade, never error)", () => {
    expect(detectHarness({ env: { CLAUDECODE: "1" } })).toEqual({
      kind: "claude-code",
      session_id: null,
    });
  });

  it("session_id is null for claude-code when CLAUDE_CODE_SESSION_ID is blank/whitespace", () => {
    expect(
      detectHarness({ env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "   " } }).session_id,
    ).toBeNull();
  });

  it("session_id is always null for opencode/codex/other — no id exposed to the environment (findings.md §1.2/§1.3)", () => {
    expect(detectHarness({ env: { OPENCODE: "1" } })).toEqual({
      kind: "opencode",
      session_id: null,
    });
    expect(detectHarness({ env: { CODEX_SANDBOX: "seatbelt" } })).toEqual({
      kind: "codex",
      session_id: null,
    });
    expect(detectHarness({ env: {} })).toEqual({ kind: "other", session_id: null });
  });

  it("--harness flag ALWAYS wins over env sniffing, no exceptions (D17/findings.md §2 step 1)", () => {
    // env disagrees entirely (looks like Claude Code) — the flag still wins.
    const harness = detectHarness({
      harnessFlag: "opencode",
      env: { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "should-be-ignored" },
    });
    expect(harness.kind).toBe("opencode");
    // and session id capture still follows the WINNING kind, not the env's kind.
    expect(harness.session_id).toBeNull();
  });

  it("--harness claude-code still captures CLAUDE_CODE_SESSION_ID from the real env even though the flag, not sniffing, chose the kind", () => {
    const harness = detectHarness({
      harnessFlag: "claude-code",
      env: { CLAUDE_CODE_SESSION_ID: "abc-123" }, // no CLAUDECODE=1 at all
    });
    expect(harness).toEqual({ kind: "claude-code", session_id: "abc-123" });
  });

  it("an unrecognised --harness value degrades to sniffing rather than throwing (defensive; the CLI layer is the real validation gate)", () => {
    expect(() =>
      detectHarness({ harnessFlag: "not-a-real-harness", env: { OPENCODE: "1" } }),
    ).not.toThrow();
    expect(detectHarness({ harnessFlag: "not-a-real-harness", env: { OPENCODE: "1" } }).kind).toBe(
      "opencode",
    );
  });

  it("never throws, even against a maximally weird env object", () => {
    expect(() => detectHarness({ env: {} })).not.toThrow();
    expect(() => sniffHarnessKind({})).not.toThrow();
  });
});
