import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import {
  type PackMetadata,
  REQUIRED_PACKAGE_PATHS,
  parsePackMetadata,
  validatePackMetadata,
} from "../../scripts/verify-package.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const ciPath = join(repoRoot, ".github", "workflows", "ci.yml");
const releasePath = join(repoRoot, ".github", "workflows", "release.yml");

function readWorkflow(path: string): string {
  return readFileSync(path, "utf8");
}

function namedStep(workflow: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start === -1) throw new Error(`workflow step not found: ${name}`);
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function validMetadata(): PackMetadata {
  return {
    name: pkg.name,
    version: pkg.version,
    filename: `${pkg.name}-${pkg.version}.tgz`,
    size: 1,
    files: REQUIRED_PACKAGE_PATHS.map((path) => ({ path, size: 1 })),
  };
}

describe("release workflow guardrails", () => {
  it("defines coverage, build, binary, and installed-package checks in the required gate", () => {
    const requiredGate = pkg.scripts["check:required"];
    for (const command of [
      "bun run lint",
      "bun run format:check",
      "bun run typecheck",
      "bun run test:coverage",
      "bun run build",
      "bun run verify:dist",
      "bun run verify:package",
    ]) {
      expect(requiredGate).toContain(command);
    }
    expect(requiredGate).not.toMatch(/bun run test(?:\s|$)/);
  });

  it("keeps both workflows on the same repository-owned required gate", () => {
    const ci = readWorkflow(ciPath);
    const release = readWorkflow(releasePath);
    expect(ci.match(/run: bun run check:required/g)).toHaveLength(1);
    expect(release.match(/run: bun run check:required/g)).toHaveLength(1);
    expect(release).not.toMatch(/run: bun run test(?:\s|$)/);
  });

  it("makes manual dispatch dry-run-only and real publishing tag-push-only", () => {
    const release = readWorkflow(releasePath);
    expect(release).toContain("workflow_dispatch:");
    expect(release).not.toContain("inputs.dry_run");
    const manual = namedStep(release, "Confirm manual validation only");
    expect(manual).toContain("if: github.event_name == 'workflow_dispatch'");
    expect(manual).not.toContain("npm publish");
    const publish = namedStep(release, "Publish to npm");
    expect(publish).toContain(
      "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
    );
    expect(publish).toContain("run: npm publish --access public");
    expect(release.match(/run: npm publish/g)).toHaveLength(1);
  });

  it("is syntactically valid YAML", () => {
    const script = [
      "for (const path of process.argv.slice(1)) {",
      "  Bun.YAML.parse(await Bun.file(path).text());",
      "}",
    ].join("\n");
    const result = spawnSync("bun", ["-e", script, ciPath, releasePath], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("npm tarball contract", () => {
  it("parses pack metadata after prepack lifecycle output", () => {
    const metadata = validMetadata();
    expect(
      parsePackMetadata(`$ bun run build:web\nbuilt assets\n${JSON.stringify([metadata])}`),
    ).toEqual([metadata]);
  });

  it("accepts the complete expected package surface", () => {
    expect(() => validatePackMetadata(validMetadata(), pkg)).not.toThrow();
  });

  it("rejects a missing runtime entry or generated web asset", () => {
    for (const missing of ["src/cli/index.ts", "src/web/generated/app.js"]) {
      const metadata = validMetadata();
      metadata.files = metadata.files.filter((file) => file.path !== missing);
      expect(() => validatePackMetadata(metadata, pkg)).toThrow(missing);
    }
  });

  it("rejects tests, compiled binaries, and node_modules", () => {
    for (const path of ["src/core/foo.test.ts", "dist/slop", "node_modules/pkg/index.js"]) {
      const metadata = validMetadata();
      metadata.files.push({ path, size: 1 });
      expect(() => validatePackMetadata(metadata, pkg)).toThrow(path);
    }
  });

  it("rejects a tarball whose identity differs from package.json", () => {
    expect(() => validatePackMetadata({ ...validMetadata(), version: "99.0.0" }, pkg)).toThrow(
      /does not match/,
    );
  });
});
