import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { isTicketId } from "../../src/core/index.js";
import { ensureDbDirs, listEvents, ticketFilePath } from "../../src/repo/index.js";
import { openStorage } from "../../src/storage/open.js";

const workerPath = join(dirname(fileURLToPath(import.meta.url)), "mutation-journal-kill-worker.ts");

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

function firstLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(
      () => reject(new Error("worker did not report its ticket id")),
      5_000,
    );
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolve(stdout.slice(0, newline));
      }
    });
    child.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function waitUntil(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${description}`);
}

it("recovers exactly one event on storage reopen after SIGKILL between entity and event writes", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "slop-mutation-kill-test-"));
  const paths = await ensureDbDirs(scratch);
  const child = spawn("bun", [workerPath, scratch], {
    env: { ...process.env, SLOP_TEST_MUTATION_DELAY_AFTER_ENTITY_MS: "30000" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const id = await firstLine(child);
    expect(isTicketId(id)).toBe(true);
    if (!isTicketId(id)) throw new Error(`worker emitted invalid ticket id: ${id}`);
    const path = ticketFilePath(paths, id);

    await waitUntil(async () => {
      try {
        await readFile(path, "utf8");
        const journals = (await readdir(paths.mutationJournalDir)).filter((name) =>
          name.endsWith(".jsonc"),
        );
        return journals.length === 1;
      } catch {
        return false;
      }
    }, "the committed entity and pending journal");
    await expect(listEvents(paths)).resolves.toEqual([]);

    expect(child.kill("SIGKILL")).toBe(true);
    await waitForExit(child);

    const storage = await openStorage(paths);
    await expect(storage.readTicket(id)).resolves.toMatchObject({ id });
    const events = await storage.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entity: { kind: "ticket", id },
      verb: "ticket.created",
      payload: { interrupted: true },
    });
    await expect(readdir(paths.mutationJournalDir)).resolves.toEqual([]);
    await expect(access(paths.lockFile)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    await rm(scratch, { recursive: true, force: true });
  }
}, 15_000);
