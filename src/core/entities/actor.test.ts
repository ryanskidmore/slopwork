import { describe, expect, it } from "vitest";
import { actorSchema, resolveActorName } from "./actor.js";

describe("actorSchema", () => {
  it("accepts a valid human actor", () => {
    expect(actorSchema.safeParse({ name: "ryan", kind: "human" }).success).toBe(true);
  });

  it("accepts a valid agent actor", () => {
    expect(actorSchema.safeParse({ name: "claude-code", kind: "agent" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(actorSchema.safeParse({ name: "", kind: "human" }).success).toBe(false);
    expect(actorSchema.safeParse({ name: "   ", kind: "human" }).success).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(actorSchema.safeParse({ name: "ryan", kind: "robot" }).success).toBe(false);
  });

  it("trims the name", () => {
    expect(actorSchema.parse({ name: "  ryan  ", kind: "human" }).name).toBe("ryan");
  });
});

describe("resolveActorName (D17 order: --as > SLOP_ACTOR > config user > git user.name)", () => {
  it("prefers --as over everything else", () => {
    expect(
      resolveActorName({
        asFlag: "flag-actor",
        slopActorEnv: "env-actor",
        configUser: "config-actor",
        gitUserName: "git-actor",
      }),
    ).toBe("flag-actor");
  });

  it("falls back to SLOP_ACTOR when --as is absent", () => {
    expect(
      resolveActorName({
        slopActorEnv: "env-actor",
        configUser: "config-actor",
        gitUserName: "git-actor",
      }),
    ).toBe("env-actor");
  });

  it("falls back to config user when flag and env are absent", () => {
    expect(
      resolveActorName({
        configUser: "config-actor",
        gitUserName: "git-actor",
      }),
    ).toBe("config-actor");
  });

  it("falls back to git config user.name last", () => {
    expect(resolveActorName({ gitUserName: "git-actor" })).toBe("git-actor");
  });

  it("returns null when nothing resolved", () => {
    expect(resolveActorName({})).toBeNull();
  });

  it("treats blank/whitespace-only candidates as absent and skips them", () => {
    expect(
      resolveActorName({
        asFlag: "   ",
        slopActorEnv: "",
        configUser: "config-actor",
      }),
    ).toBe("config-actor");
  });

  it("trims the resolved value", () => {
    expect(resolveActorName({ asFlag: "  ryan  " })).toBe("ryan");
  });
});
