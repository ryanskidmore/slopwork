import { describe, expect, it } from "vitest";
import { rewriteLabelArgv } from "./argv.js";

describe("rewriteLabelArgv", () => {
  it("rewrites the documented `--label +x -y` form into repeated --label=value tokens", () => {
    expect(rewriteLabelArgv(["update", "ref", "--label", "+x", "-y"])).toEqual([
      "update",
      "ref",
      "--label=+x",
      "--label=-y",
    ]);
  });

  it("absorbs more than two consecutive values", () => {
    expect(rewriteLabelArgv(["update", "ref", "--label", "+a", "-b", "+c"])).toEqual([
      "update",
      "ref",
      "--label=+a",
      "--label=-b",
      "--label=+c",
    ]);
  });

  it("leaves the repeated-flag form (--label +x --label -y) unchanged in shape (each --label independently rewritten to its one value)", () => {
    expect(rewriteLabelArgv(["update", "ref", "--label", "+x", "--label", "-y"])).toEqual([
      "update",
      "ref",
      "--label=+x",
      "--label=-y",
    ]);
  });

  it("leaves the already-unambiguous --label=value form completely untouched", () => {
    const argv = ["update", "ref", "--label=+x", "--label=-y"];
    expect(rewriteLabelArgv(argv)).toEqual(argv);
  });

  it("does not swallow a following real flag", () => {
    expect(rewriteLabelArgv(["update", "ref", "--label", "+a", "--priority", "1"])).toEqual([
      "update",
      "ref",
      "--label=+a",
      "--priority",
      "1",
    ]);
  });

  it("does not swallow a following real flag even when it's the very first thing after --label", () => {
    // --label with nothing value-shaped after it: left as-is, so
    // Commander's own "missing required argument" error still fires.
    expect(rewriteLabelArgv(["update", "ref", "--label", "--priority", "1"])).toEqual([
      "update",
      "ref",
      "--label",
      "--priority",
      "1",
    ]);
  });

  it("a bare trailing --label (nothing after it at all) is left untouched", () => {
    expect(rewriteLabelArgv(["update", "ref", "--label"])).toEqual(["update", "ref", "--label"]);
  });

  it("does not touch --progress/--name/--spec values, even ones starting with a dash", () => {
    const argv = ["update", "ref", "--progress", "-1 regression", "--name", "-foo"];
    expect(rewriteLabelArgv(argv)).toEqual(argv);
  });

  it("only ever rewrites the literal token '--label', never a substring match", () => {
    const argv = ["update", "ref", "--labeled", "something"];
    expect(rewriteLabelArgv(argv)).toEqual(argv);
  });

  it("passes an argv with no --label at all straight through", () => {
    const argv = ["new", "A name", "--priority", "1"];
    expect(rewriteLabelArgv(argv)).toEqual(argv);
  });

  it("leaves `new`'s plain a:b label form untouched — no leading sigil means Commander never had a problem with it", () => {
    const argv = ["new", "A name", "--label", "type:feature"];
    expect(rewriteLabelArgv(argv)).toEqual(argv);
  });

  it("still rewrites for `new` when a label value happens to start with a sigil", () => {
    expect(rewriteLabelArgv(["new", "A name", "--label", "-weird"])).toEqual([
      "new",
      "A name",
      "--label=-weird",
    ]);
  });

  it("stops absorbing at a bare positional-looking token with no leading sigil", () => {
    // "y" has no leading +/- at all, so it's not a candidate value —
    // absorption stops after "+x", and "y" passes through unchanged.
    expect(rewriteLabelArgv(["update", "ref", "--label", "+x", "y"])).toEqual([
      "update",
      "ref",
      "--label=+x",
      "y",
    ]);
  });
});
