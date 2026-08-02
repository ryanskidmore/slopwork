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

  // t-9uvbr: --discovered-from hits the exact same Commander limitation as
  // --label (a ±ref value is just as `-`-shaped) — same rewrite, different
  // flag token.
  describe("--discovered-from (t-9uvbr)", () => {
    it("rewrites the `--discovered-from +x -y` form into repeated --discovered-from=value tokens", () => {
      expect(rewriteLabelArgv(["update", "ref", "--discovered-from", "+x", "-y"])).toEqual([
        "update",
        "ref",
        "--discovered-from=+x",
        "--discovered-from=-y",
      ]);
    });

    it("leaves the already-unambiguous --discovered-from=value form untouched", () => {
      const argv = ["update", "ref", "--discovered-from=+x"];
      expect(rewriteLabelArgv(argv)).toEqual(argv);
    });

    it("a bare trailing --discovered-from (nothing after it) is left untouched", () => {
      expect(rewriteLabelArgv(["update", "ref", "--discovered-from"])).toEqual([
        "update",
        "ref",
        "--discovered-from",
      ]);
    });

    it("a --label and a --discovered-from in the same invocation are each rewritten independently", () => {
      expect(
        rewriteLabelArgv([
          "update",
          "ref",
          "--label",
          "+bug",
          "-triage",
          "--discovered-from",
          "+spike-1",
        ]),
      ).toEqual(["update", "ref", "--label=+bug", "--label=-triage", "--discovered-from=+spike-1"]);
    });
  });

  it("only ever rewrites the literal allowlisted flag tokens, never a substring match on --discovered-from", () => {
    const argv = ["update", "ref", "--discovered-from-ish", "something"];
    expect(rewriteLabelArgv(argv)).toEqual(argv);
  });

  // G5 (t-z4ci3, post-G3 polish): `update --blocks <±ref>`/`update
  // --relates-to <±ref>` hit the exact same Commander limitation as
  // --label/--discovered-from — added to the same allowlist.
  describe("--blocks / --relates-to (t-z4ci3)", () => {
    it("rewrites the `update --blocks -ref` form (a lone `-ref` value) into an unambiguous --blocks=-ref token", () => {
      expect(rewriteLabelArgv(["update", "ref", "--blocks", "-ref"])).toEqual([
        "update",
        "ref",
        "--blocks=-ref",
      ]);
    });

    it("rewrites the `--blocks +x -y` form into repeated --blocks=value tokens", () => {
      expect(rewriteLabelArgv(["update", "ref", "--blocks", "+x", "-y"])).toEqual([
        "update",
        "ref",
        "--blocks=+x",
        "--blocks=-y",
      ]);
    });

    it("rewrites the `--relates-to +x -y` form into repeated --relates-to=value tokens", () => {
      expect(rewriteLabelArgv(["update", "ref", "--relates-to", "+x", "-y"])).toEqual([
        "update",
        "ref",
        "--relates-to=+x",
        "--relates-to=-y",
      ]);
    });

    it("leaves the already-unambiguous --blocks=value / --relates-to=value forms untouched", () => {
      const argv = ["update", "ref", "--blocks=-x", "--relates-to=+y"];
      expect(rewriteLabelArgv(argv)).toEqual(argv);
    });

    it("a bare trailing --blocks/--relates-to (nothing after it) is left untouched", () => {
      expect(rewriteLabelArgv(["update", "ref", "--blocks"])).toEqual([
        "update",
        "ref",
        "--blocks",
      ]);
      expect(rewriteLabelArgv(["update", "ref", "--relates-to"])).toEqual([
        "update",
        "ref",
        "--relates-to",
      ]);
    });

    it("--label, --blocks, and --relates-to together in one invocation are each rewritten independently", () => {
      expect(
        rewriteLabelArgv([
          "update",
          "ref",
          "--label",
          "+bug",
          "--blocks",
          "-old-blocker",
          "--relates-to",
          "+spike-1",
        ]),
      ).toEqual([
        "update",
        "ref",
        "--label=+bug",
        "--blocks=-old-blocker",
        "--relates-to=+spike-1",
      ]);
    });
  });

  it("only ever rewrites the literal allowlisted flag tokens, never a substring match on --blocks/--relates-to", () => {
    const argv = ["update", "ref", "--blocks-ish", "something", "--relates-to-ish", "something"];
    expect(rewriteLabelArgv(argv)).toEqual(argv);
  });
});
