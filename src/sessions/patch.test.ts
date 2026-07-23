import { describe, expect, it } from "vitest";
import { newSessionId, newTicketId, sessionSchema } from "../core/index.js";
import type { Session } from "../core/index.js";
import { diffSessionPatch } from "./patch.js";

function makeSession(overrides: Partial<Session> = {}): Session {
  return sessionSchema.parse({
    id: newSessionId(),
    ticket: newTicketId(),
    actor: { name: "ryan", kind: "human" },
    harness: { kind: "claude-code", session_id: null },
    git: { branch: "main", commit_at_start: "abc123" },
    started_at: "2026-07-23T09:00:00.000Z",
    ...overrides,
  });
}

describe("diffSessionPatch", () => {
  it("produces one entry per changed field, defaulting to the ended_at/end_summary pair", () => {
    const before = makeSession();
    const after = { ...before, ended_at: "2026-07-23T10:00:00.000Z", end_summary: "done for now" };
    const patch = diffSessionPatch(before, after);
    expect(patch).toEqual([
      { path: ["ended_at"], value: "2026-07-23T10:00:00.000Z" },
      { path: ["end_summary"], value: "done for now" },
    ]);
  });

  it("omits fields that did not change", () => {
    const before = makeSession();
    const after = { ...before, ended_at: "2026-07-23T10:00:00.000Z" };
    const patch = diffSessionPatch(before, after);
    expect(patch).toEqual([{ path: ["ended_at"], value: "2026-07-23T10:00:00.000Z" }]);
  });

  it("produces no entries when nothing changed", () => {
    const before = makeSession();
    expect(diffSessionPatch(before, before)).toEqual([]);
  });

  it("supports an explicit field list beyond the default pair", () => {
    const before = makeSession();
    const after = { ...before, actor: { name: "other", kind: "agent" as const } };
    const patch = diffSessionPatch(before, after, ["actor"]);
    expect(patch).toEqual([{ path: ["actor"], value: { name: "other", kind: "agent" } }]);
  });
});
