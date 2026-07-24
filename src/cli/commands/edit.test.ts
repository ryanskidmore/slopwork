import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapRepo, captureOutput, withCwd } from "../../../tests/support/cli-harness.js";
import { makeTempRepo } from "../../../tests/support/temp-repo.js";
import { EXIT_CODES } from "../../core/exit-codes.js";
import type { TicketId } from "../../core/index.js";
import { readTicket, repoPaths, ticketFilePath } from "../../repo/index.js";
import { pickEditorCommand, runEdit } from "./edit.js";
import { runNew } from "./new.js";

// windows-portability-fsyncdir-crlf-gitignore-cwd-mangling-edi:
//
// `pickEditorCommand` used to fall back unconditionally to `vi`, which
// isn't present on stock Windows. These tests prove the existing
// $VISUAL/$EDITOR precedence is unchanged, and that the platform-dependent
// fallback picks `notepad` on win32 and `vi` everywhere else (mocking
// `process.platform` since this suite runs on a Linux host).

describe("pickEditorCommand", () => {
  const originalPlatform = process.platform;
  const originalVisual = process.env.VISUAL;
  const originalEditor = process.env.EDITOR;

  beforeEach(() => {
    delete process.env.VISUAL;
    delete process.env.EDITOR;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    if (originalVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = originalVisual;
    if (originalEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEditor;
  });

  it("prefers $VISUAL over $EDITOR and over any platform default", () => {
    process.env.VISUAL = "code --wait";
    process.env.EDITOR = "nano";
    expect(pickEditorCommand()).toBe("code --wait");
  });

  it("falls back to $EDITOR when $VISUAL is unset", () => {
    process.env.EDITOR = "nano";
    expect(pickEditorCommand()).toBe("nano");
  });

  it("falls back to vi on posix (linux) when neither $VISUAL nor $EDITOR is set", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    expect(pickEditorCommand()).toBe("vi");
  });

  it("falls back to vi on darwin too (POSIX default unchanged, not just linux)", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    expect(pickEditorCommand()).toBe("vi");
  });

  it("falls back to notepad on win32 when neither $VISUAL nor $EDITOR is set", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    expect(pickEditorCommand()).toBe("notepad");
  });

  it("$VISUAL/$EDITOR still win over the win32 default", () => {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    process.env.EDITOR = "vim";
    expect(pickEditorCommand()).toBe("vim");
  });
});

// ---------------------------------------------------------------------------
// In-process coverage of `runEdit` (real v8 coverage, no subprocess).
//
// `runEdit` spawns `$EDITOR` synchronously (node:child_process's
// spawnSync). Rather than launching a real interactive editor, $EDITOR is
// pointed at a tiny Node script (written into the temp repo, cleaned up
// with it) whose behavior is driven by an env var — the same "fake
// external tool, driven by env" pattern this codebase already uses for
// SLOP_TEST_ATOMIC_WRITE_DELAY_MS (atomic-write.ts) — so every branch
// (no-op, save, abort, invalid JSON, invalid schema) is exercised as a
// REAL spawned process, exactly like a genuine $EDITOR would be, without
// ever blocking on a terminal.
// ---------------------------------------------------------------------------

const FAKE_EDITOR_SCRIPT = `
const fs = require("node:fs");
const filePath = process.argv[2];
const mode = process.env.SLOP_TEST_FAKE_EDITOR_MODE;
if (mode === "abort") process.exit(3);
if (mode === "noop") process.exit(0);
if (mode === "invalid-json") {
  fs.writeFileSync(filePath, "{ not valid jsonc {{{", "utf8");
  process.exit(0);
}
if (mode === "invalid-schema") {
  const ticket = JSON.parse(fs.readFileSync(filePath, "utf8"));
  ticket.state = "not-a-real-state";
  fs.writeFileSync(filePath, JSON.stringify(ticket, null, 2), "utf8");
  process.exit(0);
}
if (mode === "rename") {
  const ticket = JSON.parse(fs.readFileSync(filePath, "utf8"));
  ticket.name = process.env.SLOP_TEST_FAKE_EDITOR_NAME ?? "renamed";
  fs.writeFileSync(filePath, JSON.stringify(ticket, null, 2), "utf8");
  process.exit(0);
}
if (mode === "reparent") {
  const ticket = JSON.parse(fs.readFileSync(filePath, "utf8"));
  ticket.parent = process.env.SLOP_TEST_FAKE_EDITOR_PARENT;
  fs.writeFileSync(filePath, JSON.stringify(ticket, null, 2), "utf8");
  process.exit(0);
}
process.exit(0);
`;

async function writeFakeEditor(root: string): Promise<string> {
  const scriptPath = join(root, "fake-editor.cjs");
  await writeFile(scriptPath, FAKE_EDITOR_SCRIPT, "utf8");
  return scriptPath;
}

async function jsonNewTicket(
  root: string,
  name: string,
  extra: { parent?: string } = {},
): Promise<TicketId> {
  const out = captureOutput();
  try {
    await withCwd(root, () =>
      runNew(name, {
        blocks: [],
        relatesTo: [],
        label: [],
        acceptance: [],
        context: [],
        json: true,
        ...extra,
      }),
    );
    return (JSON.parse(out.stdout()) as { id: TicketId }).id;
  } finally {
    out.restore();
  }
}

describe("runEdit (in-process)", () => {
  const originalVisual = process.env.VISUAL;
  const originalEditor = process.env.EDITOR;
  const originalMode = process.env.SLOP_TEST_FAKE_EDITOR_MODE;
  const originalName = process.env.SLOP_TEST_FAKE_EDITOR_NAME;
  const originalParent = process.env.SLOP_TEST_FAKE_EDITOR_PARENT;

  afterEach(() => {
    if (originalVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = originalVisual;
    if (originalEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = originalEditor;
    if (originalMode === undefined) delete process.env.SLOP_TEST_FAKE_EDITOR_MODE;
    else process.env.SLOP_TEST_FAKE_EDITOR_MODE = originalMode;
    if (originalName === undefined) delete process.env.SLOP_TEST_FAKE_EDITOR_NAME;
    else process.env.SLOP_TEST_FAKE_EDITOR_NAME = originalName;
    if (originalParent === undefined) delete process.env.SLOP_TEST_FAKE_EDITOR_PARENT;
    else process.env.SLOP_TEST_FAKE_EDITOR_PARENT = originalParent;
  });

  it("no changes: prints 'no changes to <id>' and leaves the file untouched", async () => {
    const root = await makeTempRepo("slop-edit-inproc-noop-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Untouched by edit");
    const scriptPath = await writeFakeEditor(root);
    process.env.VISUAL = `node ${scriptPath}`;
    process.env.SLOP_TEST_FAKE_EDITOR_MODE = "noop";

    const out = captureOutput();
    try {
      await withCwd(root, () => runEdit(id));
      expect(out.stdout()).toContain(`no changes to ${id}`);
    } finally {
      out.restore();
    }
  });

  it("saves a valid rename through the editor", async () => {
    const root = await makeTempRepo("slop-edit-inproc-rename-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Original name");
    const scriptPath = await writeFakeEditor(root);
    process.env.VISUAL = `node ${scriptPath}`;
    process.env.SLOP_TEST_FAKE_EDITOR_MODE = "rename";
    process.env.SLOP_TEST_FAKE_EDITOR_NAME = "Renamed via editor";

    const out = captureOutput();
    try {
      await withCwd(root, () => runEdit(id));
      expect(out.stdout()).toContain(`saved ${id}`);
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    expect((await readTicket(paths, id)).name).toBe("Renamed via editor");
  });

  it("a nonzero editor exit aborts without saving, leaving the file byte-for-byte unchanged", async () => {
    const root = await makeTempRepo("slop-edit-inproc-abort-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Aborted edit ticket");
    const paths = repoPaths(root);
    const before = await readFile(ticketFilePath(paths, id), "utf8");
    const scriptPath = await writeFakeEditor(root);
    process.env.VISUAL = `node ${scriptPath}`;
    process.env.SLOP_TEST_FAKE_EDITOR_MODE = "abort";

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runEdit(id))).rejects.toThrow(/left unchanged/);
    } finally {
      out.restore();
    }
    const after = await readFile(ticketFilePath(paths, id), "utf8");
    expect(after).toBe(before);
  });

  it("invalid JSON is rejected, the user's edit is rescued to a temp file, and the original is restored", async () => {
    const root = await makeTempRepo("slop-edit-inproc-invalidjson-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Invalid json edit ticket");
    const paths = repoPaths(root);
    const before = await readFile(ticketFilePath(paths, id), "utf8");
    const scriptPath = await writeFakeEditor(root);
    process.env.VISUAL = `node ${scriptPath}`;
    process.env.SLOP_TEST_FAKE_EDITOR_MODE = "invalid-json";

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runEdit(id))).rejects.toThrow(
        /NOT saved[\s\S]*preserved at/,
      );
    } finally {
      out.restore();
    }
    const after = await readFile(ticketFilePath(paths, id), "utf8");
    expect(after).toBe(before);
  });

  it("an invalid schema value (bad state) is rejected and rolled back (USAGE_ERROR-shaped)", async () => {
    const root = await makeTempRepo("slop-edit-inproc-invalidschema-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Invalid schema edit ticket");
    const paths = repoPaths(root);
    const before = await readFile(ticketFilePath(paths, id), "utf8");
    const scriptPath = await writeFakeEditor(root);
    process.env.VISUAL = `node ${scriptPath}`;
    process.env.SLOP_TEST_FAKE_EDITOR_MODE = "invalid-schema";

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runEdit(id))).rejects.toThrow(/failed validation/);
    } finally {
      out.restore();
    }
    const after = await readFile(ticketFilePath(paths, id), "utf8");
    expect(after).toBe(before);
  });

  it("a --parent change reparents the ticket and recomputes descendant ancestry", async () => {
    const root = await makeTempRepo("slop-edit-inproc-reparent-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const oldParent = await jsonNewTicket(root, "Old parent");
    const newParent = await jsonNewTicket(root, "New parent");
    const child = await jsonNewTicket(root, "Child ticket", { parent: oldParent });

    const scriptPath = await writeFakeEditor(root);
    process.env.VISUAL = `node ${scriptPath}`;
    process.env.SLOP_TEST_FAKE_EDITOR_MODE = "reparent";
    process.env.SLOP_TEST_FAKE_EDITOR_PARENT = newParent;

    const out = captureOutput();
    try {
      await withCwd(root, () => runEdit(child));
      expect(out.stdout()).toContain(`saved ${child}`);
    } finally {
      out.restore();
    }
    const paths = repoPaths(root);
    const reparented = await readTicket(paths, child);
    expect(reparented.parent).toBe(newParent);
    expect(reparented.root_id).toBe(newParent);
  });

  it("no editor configured ($VISUAL/$EDITOR both unset): throws a clear usage error", async () => {
    const root = await makeTempRepo("slop-edit-inproc-noeditor-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "No editor ticket");
    delete process.env.VISUAL;
    process.env.EDITOR = "   "; // whitespace-only -> no usable command

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runEdit(id))).rejects.toThrow(/no editor configured/);
    } finally {
      out.restore();
    }
  });

  // edit-vi-fallback-hangs-agents: the regression this ticket closes.
  // Before the fix, this exact shape ($VISUAL/$EDITOR both unset, no TTY —
  // vitest workers never have one, same as any harness-driven pipe) fell
  // through to `spawnSync("vi", ..., {stdio: "inherit"})` and blocked
  // FOREVER, hanging this very test (and the whole suite) rather than
  // failing. That it completes at all — let alone quickly, with the
  // documented USAGE_ERROR/exit-2 shape and a non-interactive-alternative
  // pointer — IS the regression proof.
  it("no $VISUAL/$EDITOR and non-TTY: fails fast (USAGE_ERROR, exit 2) instead of hanging, naming the non-interactive alternative", async () => {
    const root = await makeTempRepo("slop-edit-inproc-nontty-fallback-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Non-TTY fallback ticket");
    delete process.env.VISUAL;
    delete process.env.EDITOR;

    const before = await readFile(ticketFilePath(repoPaths(root), id), "utf8");

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runEdit(id))).rejects.toMatchObject({
        exitCode: EXIT_CODES.USAGE_ERROR,
        message: expect.stringMatching(/not a TTY/i),
      });
    } finally {
      out.restore();
    }
    // Never touched the file: this is a pure pre-flight refusal, no editor
    // process was ever spawned.
    const after = await readFile(ticketFilePath(repoPaths(root), id), "utf8");
    expect(after).toBe(before);
  });

  it("no $VISUAL/$EDITOR and non-TTY: the error names update --parent/--blocks/--owner/--relates-to as the non-interactive alternative", async () => {
    const root = await makeTempRepo("slop-edit-inproc-nontty-alt-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    const id = await jsonNewTicket(root, "Non-TTY alternative-pointer ticket");
    delete process.env.VISUAL;
    delete process.env.EDITOR;

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runEdit(id))).rejects.toThrow(
        /update <ref> --parent.*--blocks.*--owner.*--relates-to/s,
      );
    } finally {
      out.restore();
    }
  });

  it("throws NOT_FOUND for an unresolvable ref before ever touching $EDITOR", async () => {
    const root = await makeTempRepo("slop-edit-inproc-notfound-");
    await bootstrapRepo(root, { project: "p", user: "ryan" });
    process.env.VISUAL = "this-should-never-run";

    const out = captureOutput();
    try {
      await expect(withCwd(root, () => runEdit("no-such-ticket"))).rejects.toThrow();
    } finally {
      out.restore();
    }
  });
});
