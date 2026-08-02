import { describe, expect, it } from "vitest";
import { SlopError } from "../cli/errors.js";
import { parseOwnerRaw } from "./owner.js";

describe("parseOwnerRaw", () => {
  it("a bare name (no prefix) stays human — back-compat with pre-t-9uvbr docs/examples", () => {
    expect(parseOwnerRaw("priya")).toEqual({ name: "priya", kind: "human" });
  });

  it("human:<name> is explicit human", () => {
    expect(parseOwnerRaw("human:priya")).toEqual({ name: "priya", kind: "human" });
  });

  it("agent:<name> is agent", () => {
    expect(parseOwnerRaw("agent:codex-3")).toEqual({ name: "codex-3", kind: "agent" });
  });

  it("trims whitespace after the prefix", () => {
    expect(parseOwnerRaw("agent:  codex-3  ")).toEqual({ name: "codex-3", kind: "agent" });
  });

  it("a name that merely CONTAINS a colon but has no recognized prefix stays a bare human name", () => {
    expect(parseOwnerRaw("team:infra")).toEqual({ name: "team:infra", kind: "human" });
  });

  it("rejects agent:/human: with nothing after the colon", () => {
    expect(() => parseOwnerRaw("agent:")).toThrow(SlopError);
    expect(() => parseOwnerRaw("agent:   ")).toThrow(SlopError);
  });
});
