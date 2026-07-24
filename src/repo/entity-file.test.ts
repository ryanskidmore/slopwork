import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SlopError } from "../cli/errors.js";
import { EXIT_CODES } from "../core/exit-codes.js";
import {
  createEntityFileCanonical,
  deleteEntityFile,
  listEntityIds,
  readEntityFile,
  updateEntityFile,
} from "./entity-file.js";

const widgetSchema = z.object({ id: z.string(), count: z.number().int() });
type Widget = z.infer<typeof widgetSchema>;

let scratch: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-entity-file-test-"));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("readEntityFile", () => {
  it("throws NOT_FOUND (exit 4) naming the path when the file is missing", async () => {
    const path = join(scratch, "missing.jsonc");
    let threw: unknown;
    try {
      await readEntityFile(path, widgetSchema);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SlopError);
    expect((threw as SlopError).exitCode).toBe(EXIT_CODES.NOT_FOUND);
    expect((threw as SlopError).message).toContain(path);
  });

  it("throws a clear, actionable error naming the file and location for a JSONC syntax error", async () => {
    const path = join(scratch, "broken.jsonc");
    await writeFile(path, '{ "id": "a" "count": 1 }');
    let threw: unknown;
    try {
      await readEntityFile(path, widgetSchema);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SlopError);
    expect((threw as SlopError).message).toContain(path);
    // "path:line:col: Message" per formatParseErrors.
    expect((threw as SlopError).message).toMatch(new RegExp(`${path}:\\d+:\\d+:`));
  });

  it("throws a clear, actionable error naming the file and field for a schema validation failure (parses cleanly, wrong shape)", async () => {
    const path = join(scratch, "wrong-shape.jsonc");
    await writeFile(path, '{ "id": "a", "count": "not a number" }\n');
    let threw: unknown;
    try {
      await readEntityFile(path, widgetSchema);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SlopError);
    expect((threw as SlopError).exitCode).toBe(EXIT_CODES.GENERIC_ERROR);
    expect((threw as SlopError).message).toContain(path);
    expect((threw as SlopError).message).toContain("count");
  });

  it("catches the case parseJsonc alone would miss: a clean-parsing duplicate-key file that validates to the wrong shape", async () => {
    // spikes/jsonc.md: duplicate keys are silently accepted by parseJsonc
    // (last one wins), so a hand-corrupted duplicate key can only be
    // caught by validating, never by parse errors alone.
    const path = join(scratch, "dup-key.jsonc");
    await writeFile(path, '{ "id": "a", "count": 1, "count": "oops" }\n');
    let threw: unknown;
    try {
      await readEntityFile(path, widgetSchema);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SlopError);
    expect((threw as SlopError).message).toContain("count");
  });

  it("succeeds and returns the validated value for a clean file", async () => {
    const path = join(scratch, "ok.jsonc");
    await writeFile(path, '{ "id": "a", "count": 3 }\n');
    await expect(readEntityFile(path, widgetSchema)).resolves.toEqual({ id: "a", count: 3 });
  });

  // Polish batch item 3: a non-ENOENT read failure (EACCES here — a file
  // that exists but this process can't read; EIO would hit the same
  // catch branch) used to escape as Node's raw, path-less `Error` instead
  // of a clean, actionable SlopError naming the file.
  it("wraps a non-ENOENT read failure (EACCES) in a SlopError naming the path and the underlying cause, not a raw Error", async () => {
    const path = join(scratch, "unreadable.jsonc");
    await writeFile(path, '{ "id": "a", "count": 1 }\n');
    await chmod(path, 0o000);
    try {
      let threw: unknown;
      try {
        await readEntityFile(path, widgetSchema);
      } catch (err) {
        threw = err;
      }
      expect(threw).toBeInstanceOf(SlopError);
      expect((threw as SlopError).exitCode).toBe(EXIT_CODES.GENERIC_ERROR);
      expect((threw as SlopError).message).toContain(path);
      expect((threw as SlopError).message.toLowerCase()).toMatch(/eacces|permission/);
    } finally {
      // Restore so afterEach's `rm(scratch, { recursive: true, force: true })` can remove it.
      await chmod(path, 0o644);
    }
  });
});

describe("createEntityFileCanonical / updateEntityFile", () => {
  it("creates a new file readable back as the same value", async () => {
    const path = join(scratch, "w.jsonc");
    const value: Widget = { id: "a", count: 1 };
    await createEntityFileCanonical(path, value);
    await expect(readEntityFile(path, widgetSchema)).resolves.toEqual(value);
  });

  it("updateEntityFile preserves hand-added comments via writeUpdate, not a blind stringify", async () => {
    const path = join(scratch, "w.jsonc");
    await writeFile(path, '// hand comment\n{\n  "id": "a",\n  "count": 1\n}\n');
    const after: Widget = { id: "a", count: 2 };
    await updateEntityFile(path, [{ path: ["count"], value: 2 }], after);
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("// hand comment");
    await expect(readEntityFile(path, widgetSchema)).resolves.toEqual(after);
  });

  it("updateEntityFile throws NOT_FOUND for a nonexistent file", async () => {
    const path = join(scratch, "nope.jsonc");
    await expect(
      updateEntityFile(path, [{ path: ["count"], value: 2 }], { id: "a", count: 2 }),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
  });

  // Polish batch item 3, updateEntityFile's own read (it shares
  // readEntityFile's read-mapping helper, not a second hand-rolled copy).
  it("updateEntityFile wraps a non-ENOENT read failure (EACCES) in a SlopError naming the path, not a raw Error", async () => {
    const path = join(scratch, "unreadable.jsonc");
    await writeFile(path, '{ "id": "a", "count": 1 }\n');
    await chmod(path, 0o000);
    try {
      await expect(
        updateEntityFile(path, [{ path: ["count"], value: 2 }], { id: "a", count: 2 }),
      ).rejects.toMatchObject({
        exitCode: EXIT_CODES.GENERIC_ERROR,
        message: expect.stringContaining(path),
      });
    } finally {
      await chmod(path, 0o644);
    }
  });
});

describe("deleteEntityFile", () => {
  it("removes an existing file", async () => {
    const path = join(scratch, "w.jsonc");
    await writeFile(path, "{}\n");
    await deleteEntityFile(path);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("throws NOT_FOUND for a nonexistent file", async () => {
    const path = join(scratch, "nope.jsonc");
    await expect(deleteEntityFile(path)).rejects.toMatchObject({ exitCode: EXIT_CODES.NOT_FOUND });
  });
});

describe("listEntityIds", () => {
  const isWidgetId = (v: string): v is `widget_${string}` => v.startsWith("widget_");

  it("returns only files matching the id predicate, sorted ascending, ignoring everything else", async () => {
    await mkdir(scratch, { recursive: true });
    await writeFile(join(scratch, "widget_b.jsonc"), "{}\n");
    await writeFile(join(scratch, "widget_a.jsonc"), "{}\n");
    await writeFile(join(scratch, ".tmp-xyz-widget_c.jsonc"), "partial");
    await writeFile(join(scratch, "index.jsonc"), "{}\n");
    await writeFile(join(scratch, "not-an-entity.txt"), "x");

    const ids = await listEntityIds(scratch, isWidgetId);
    expect(ids).toEqual(["widget_a", "widget_b"]);
  });

  it("returns an empty array for a missing directory", async () => {
    await expect(listEntityIds(join(scratch, "nope"), isWidgetId)).resolves.toEqual([]);
  });
});
