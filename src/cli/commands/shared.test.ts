import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  EXIT_CODES,
  newSessionId,
  newTicketId,
  type Session,
  sessionSchema,
} from "../../core/index.js";
import { SlopError } from "../errors.js";
import {
  collect,
  parseIntegerOption,
  parsePriority,
  printWarning,
  readStdin,
  sessionOwnershipWarning,
} from "./shared.js";

// cli-input-validation-reject-truncated-numerics-fix-actor-fai:
//
// `Number.parseInt` silently truncates leading-numeric garbage —
// `parseInt("2abc", 10)` is `2`, not NaN — so `parseIntegerOption` used to
// accept `--priority 2abc` as `2` (persisting a DIFFERENT value than what
// was typed, a data-integrity gap) and `--priority 1.9` as `1`, instead of
// rejecting either. These tests prove the fix: only a value whose full
// trimmed text is a plain integer is accepted; anything else is a
// SlopError carrying EXIT_CODES.USAGE_ERROR (exit 2), the documented
// "invalid args/flags" contract.

describe("parseIntegerOption", () => {
  const parseLimit = parseIntegerOption("--limit");

  it("accepts a plain integer", () => {
    expect(parseLimit("3")).toBe(3);
  });

  it("accepts a negative integer", () => {
    expect(parseLimit("-5")).toBe(-5);
  });

  it("accepts an integer with surrounding whitespace", () => {
    expect(parseLimit(" 7 ")).toBe(7);
  });

  it("rejects trailing garbage instead of truncating it (--limit 3xyz)", () => {
    expect(() => parseLimit("3xyz")).toThrow(SlopError);
    try {
      parseLimit("3xyz");
      throw new Error("expected parseLimit to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SlopError);
      expect((err as SlopError).exitCode).toBe(EXIT_CODES.USAGE_ERROR);
      expect((err as SlopError).message).toContain("--limit");
      expect((err as SlopError).message).toContain("3xyz");
    }
  });

  it("rejects a decimal instead of truncating it (1.9 -> would have been 1)", () => {
    expect(() => parseLimit("1.9")).toThrow(SlopError);
  });

  it("rejects a value that is entirely non-numeric", () => {
    expect(() => parseLimit("notanumber")).toThrow(SlopError);
  });

  it("rejects an empty string", () => {
    expect(() => parseLimit("")).toThrow(SlopError);
  });

  it("every rejection carries USAGE_ERROR (exit 2), never the GENERIC_ERROR default", () => {
    for (const bad of ["3xyz", "1.9", "abc", ""]) {
      try {
        parseLimit(bad);
        throw new Error(`expected parseLimit(${JSON.stringify(bad)}) to throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(SlopError);
        expect((err as SlopError).exitCode).toBe(EXIT_CODES.USAGE_ERROR);
      }
    }
  });
});

describe('parsePriority (parseIntegerOption("--priority"))', () => {
  it("persists exactly what was typed for a valid integer", () => {
    expect(parsePriority("2")).toBe(2);
  });

  it("rejects '2abc' rather than silently persisting priority 2", () => {
    expect(() => parsePriority("2abc")).toThrow(SlopError);
  });

  it("rejects '1.9' rather than silently truncating to priority 1", () => {
    expect(() => parsePriority("1.9")).toThrow(SlopError);
  });
});

describe("collect", () => {
  it("appends to and returns the same accumulator array (Commander's 'repeatable option' reducer shape)", () => {
    const acc: string[] = [];
    const first = collect("a", acc);
    expect(first).toBe(acc); // same array instance, mutated in place
    expect(first).toEqual(["a"]);
    const second = collect("b", first);
    expect(second).toEqual(["a", "b"]);
  });

  it("starting from a fresh [] default, each call accumulates in order", () => {
    let acc: string[] = [];
    acc = collect("x", acc);
    acc = collect("y", acc);
    acc = collect("z", acc);
    expect(acc).toEqual(["x", "y", "z"]);
  });
});

describe("printWarning", () => {
  it("writes 'warning: <message>' to stderr", () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      printWarning("something worth flagging");
      expect(spy).toHaveBeenCalledWith("warning: something worth flagging\n");
    } finally {
      spy.mockRestore();
    }
  });
});

// ticket_01KYAPN9NXY6RPSV6WGR42CJHJ: session ownership is a WARNING, not
// an enforced gate — see sessionOwnershipWarning's own doc for the full
// decision (recorded there and in docs/agent-workflow.md, "Session
// ownership").
describe("sessionOwnershipWarning", () => {
  function makeSession(overrides: Partial<Session> = {}): Session {
    return sessionSchema.parse({
      id: newSessionId(),
      ticket: newTicketId(),
      actor: { name: "ryan", kind: "human" },
      harness: { kind: "claude-code", session_id: null },
      git: { branch: null, commit_at_start: null },
      started_at: "2026-07-23T09:00:00.000Z",
      ...overrides,
    });
  }

  it("returns null when the acting actor's name matches the session's own actor name", () => {
    const session = makeSession({ actor: { name: "ryan", kind: "human" } });
    expect(sessionOwnershipWarning(session, { name: "ryan", kind: "agent" })).toBeNull();
  });

  it("returns a non-null warning when the names differ", () => {
    const session = makeSession({ actor: { name: "ryan", kind: "human" } });
    const warning = sessionOwnershipWarning(session, { name: "someone-else", kind: "agent" });
    expect(warning).not.toBeNull();
  });

  it("the warning names BOTH the acting actor and who started the session, plus the session id", () => {
    const session = makeSession({ actor: { name: "first-actor", kind: "human" } });
    const warning = sessionOwnershipWarning(session, { name: "second-actor", kind: "agent" });
    expect(warning).toContain("second-actor");
    expect(warning).toContain("first-actor");
    expect(warning).toContain(session.id);
  });

  it("points at docs/agent-workflow.md's Session ownership section", () => {
    const session = makeSession({ actor: { name: "a", kind: "human" } });
    const warning = sessionOwnershipWarning(session, { name: "b", kind: "human" });
    expect(warning).toMatch(/docs\/agent-workflow\.md/);
    expect(warning).toMatch(/session ownership/i);
  });

  it("compares by name only, NOT kind — the same person can legitimately act as human in one invocation and agent in another", () => {
    const session = makeSession({ actor: { name: "ryan", kind: "human" } });
    expect(sessionOwnershipWarning(session, { name: "ryan", kind: "agent" })).toBeNull();
  });

  it("is case-sensitive — 'Ryan' and 'ryan' are different actors (matches D17's plain-string identity, no normalization elsewhere in this codebase)", () => {
    const session = makeSession({ actor: { name: "ryan", kind: "human" } });
    expect(sessionOwnershipWarning(session, { name: "Ryan", kind: "human" })).not.toBeNull();
  });
});

describe("readStdin", () => {
  it("reads all of stdin as UTF-8 text", async () => {
    const fake = Readable.from(["hello ", "world"]);
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: fake, configurable: true });
    try {
      await expect(readStdin()).resolves.toBe("hello world");
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    }
  });

  it("returns an empty string for empty stdin", async () => {
    const fake = Readable.from([]);
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: fake, configurable: true });
    try {
      await expect(readStdin()).resolves.toBe("");
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    }
  });

  it("concatenates Buffer chunks correctly (multi-byte content)", async () => {
    const fake = Readable.from([Buffer.from("multi"), Buffer.from("-byte"), Buffer.from(" text")]);
    const originalStdin = process.stdin;
    Object.defineProperty(process, "stdin", { value: fake, configurable: true });
    try {
      await expect(readStdin()).resolves.toBe("multi-byte text");
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
    }
  });
});
