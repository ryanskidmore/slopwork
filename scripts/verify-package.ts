#!/usr/bin/env bun
/** Verify the exact npm tarball consumers install, not the working tree. */
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface PackageManifest {
  name: string;
  version: string;
}

export interface PackedFile {
  path: string;
  size: number;
}

export interface PackMetadata {
  name: string;
  version: string;
  filename: string;
  size: number;
  files: PackedFile[];
}

export const REQUIRED_PACKAGE_PATHS = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "bin/slop.mjs",
  "src/cli/index.ts",
  "src/web/generated/app.css",
  "src/web/generated/app.js",
] as const;

function disallowedPath(path: string): boolean {
  return (
    path.startsWith("dist/") ||
    path.startsWith("tests/") ||
    path.includes("node_modules") ||
    path.endsWith(".test.ts")
  );
}

/** Validate `npm pack --json` metadata before installing the archive. */
export function validatePackMetadata(metadata: PackMetadata, manifest: PackageManifest): void {
  if (metadata.name !== manifest.name || metadata.version !== manifest.version) {
    throw new Error(
      `packed identity ${metadata.name}@${metadata.version} does not match ` +
        `${manifest.name}@${manifest.version}`,
    );
  }

  const paths = metadata.files.map((file) => file.path);
  const missing = REQUIRED_PACKAGE_PATHS.filter((path) => !paths.includes(path));
  if (missing.length > 0) {
    throw new Error(`tarball is missing required paths: ${missing.join(", ")}`);
  }

  const disallowed = paths.filter(disallowedPath).sort();
  if (disallowed.length > 0) {
    throw new Error(`tarball contains disallowed paths: ${disallowed.join(", ")}`);
  }
}

/** npm lifecycle output may precede `--json`; find the root JSON array line. */
export function parsePackMetadata(output: string): PackMetadata[] {
  const match = /(?:^|\n)(\[[\s\S]*)$/.exec(output);
  if (!match?.[1]) throw new Error("npm pack did not emit JSON metadata");
  return JSON.parse(match[1]) as PackMetadata[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

function runChecked(command: string, args: string[], cwd: string): CommandResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, CI: "true", npm_config_update_notifier: "false" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n` + `${result.stdout}${result.stderr}`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function assertInstalledFile(packageRoot: string, path: string): Promise<void> {
  const info = await stat(join(packageRoot, path));
  if (!info.isFile() || info.size === 0) {
    throw new Error(`installed package path is missing or empty: ${path}`);
  }
}

export async function verifyPackage(repoRoot: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "slopwork-package-verify-"));
  try {
    const packDir = join(scratch, "pack");
    const installDir = join(scratch, "consumer");
    await mkdir(packDir);
    await mkdir(installDir);

    const manifest = JSON.parse(
      await readFile(join(repoRoot, "package.json"), "utf8"),
    ) as PackageManifest;
    const packed = runChecked(
      "npm",
      ["pack", "--silent", "--json", "--pack-destination", packDir],
      repoRoot,
    );
    const results = parsePackMetadata(packed.stdout);
    if (results.length !== 1 || !results[0]) {
      throw new Error(`npm pack returned ${results.length} package records; expected exactly one`);
    }
    const metadata = results[0];
    validatePackMetadata(metadata, manifest);

    const tarball = join(packDir, metadata.filename);
    await writeFile(
      join(installDir, "package.json"),
      `${JSON.stringify({ name: "slopwork-package-consumer", private: true }, null, 2)}\n`,
      "utf8",
    );
    runChecked(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball],
      installDir,
    );

    const installedRoot = join(installDir, "node_modules", manifest.name);
    for (const path of REQUIRED_PACKAGE_PATHS) await assertInstalledFile(installedRoot, path);

    const executable = join(
      installDir,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "slop.cmd" : "slop",
    );
    const version = runChecked(executable, ["--version"], installDir).stdout.trim();
    if (version !== manifest.version) {
      throw new Error(`installed slop --version returned ${JSON.stringify(version)}`);
    }
    const help = runChecked(executable, ["--help"], installDir).stdout;
    if (!help.includes("Usage: slop")) {
      throw new Error("installed slop --help did not contain the expected usage header");
    }

    process.stdout.write(
      `OK: installed ${manifest.name}@${manifest.version} from ${metadata.filename}; ` +
        `${metadata.files.length} packed files, ${metadata.size} bytes\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await verifyPackage(repoRoot).catch((error: unknown) => {
    process.stderr.write(`package verification failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
