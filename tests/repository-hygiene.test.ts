import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

/**
 * Checked-in binary assets (e.g. tests/browser/**\/*.spec.ts-snapshots'
 * Playwright reference screenshots) routinely contain literal NUL bytes and
 * byte sequences that coincidentally match the mojibake markers below —
 * that's normal for arbitrary binary data, not a text-encoding problem. This
 * suite's job is source/text hygiene, so known binary extensions are
 * excluded from the scan rather than producing permanent false positives the
 * moment any binary asset is committed.
 */
const BINARY_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
];

function maintainedPaths(): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: REPO_ROOT },
  );
  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr.toString("utf8")}`);
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => !BINARY_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext)))
    .sort();
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
