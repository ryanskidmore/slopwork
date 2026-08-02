import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

function maintainedPaths(): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: REPO_ROOT },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString("utf8")}`);
  }
  return result.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

describe("repository source hygiene", () => {
  it("contains no literal NUL bytes in maintained files", () => {
    const offenders = maintainedPaths().filter((path) =>
      readFileSync(join(REPO_ROOT, path)).includes(0),
    );
    expect(offenders, "replace source control bytes with escaped literals").toEqual([]);
  });

  it("contains no known mojibake markers in maintained text", () => {
    const markers = [
      String.fromCodePoint(0xfffd),
      String.fromCodePoint(0xc3),
      String.fromCodePoint(0xc2),
      String.fromCodePoint(0xe2, 0x20ac),
      String.fromCodePoint(0x101, 0x20ac, 0x201d),
    ];
    const offenders = maintainedPaths().filter((path) => {
      const text = readFileSync(join(REPO_ROOT, path), "utf8");
      return markers.some((marker) => text.includes(marker));
    });
    expect(offenders, "repair text encoding before committing maintained files").toEqual([]);
  });

  it("keeps retired transcript settings out of active tooling configuration", () => {
    for (const path of [".gitignore", "bench/run.ts"]) {
      const text = readFileSync(join(REPO_ROOT, path), "utf8");
      expect(text, path).not.toContain("transcripts");
    }
  });
});
