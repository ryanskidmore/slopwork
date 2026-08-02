import { describe, expect, it } from "vitest";
import { EXIT_CODES } from "../core/exit-codes.js";
import { SlopError } from "../cli/errors.js";
import { RemoteBackend } from "./remote.js";

// The remote backend (G2, t-an2d7) is a stub — no real implementation
// exists yet (future work, once a real server exists to talk to). Every
// method fails immediately (a SYNCHRONOUS throw — `notImplemented` never
// awaits anything, so the throw happens before any Promise is even
// returned; the declared `Promise<T>` return types are the async
// StorageBackend contract's shape, not a promise this stub ever actually
// produces) with one clear, consistent GENERIC_ERROR naming
// docs/storage-backends.md and the configured (or absent) url. This
// suite's job is exactly that: prove every method fails the SAME
// consistent way, never crashes ambiguously or silently succeeds.

describe("RemoteBackend", () => {
  it("kind is 'remote'", () => {
    expect(new RemoteBackend().kind).toBe("remote");
  });

  it("every method's error names docs/storage-backends.md, the method attempted, and 'no url configured' when constructed bare", () => {
    const backend = new RemoteBackend();
    expect(() => backend.readTicket()).toThrow(SlopError);
    expect(() => backend.readTicket()).toThrow(/docs\/storage-backends\.md/);
    expect(() => backend.readTicket()).toThrow(/attempted "readTicket"/);
    expect(() => backend.readTicket()).toThrow(/no url configured/);
    try {
      backend.readTicket();
      throw new Error("expected readTicket() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SlopError);
      expect((err as SlopError).exitCode).toBe(EXIT_CODES.GENERIC_ERROR);
    }
  });

  it("names the configured url instead, when one was given", () => {
    const backend = new RemoteBackend({ url: "https://example.com/slop" });
    expect(() => backend.listTickets()).toThrow(
      /configured remote at https:\/\/example\.com\/slop/,
    );
  });

  it("every StorageBackend method fails the same consistent way, naming itself", () => {
    const backend = new RemoteBackend({ url: "https://example.com/slop" });
    const methodCalls: [string, () => unknown][] = [
      ["readTicket", () => backend.readTicket()],
      ["listTickets", () => backend.listTickets()],
      ["listTicketsTolerant", () => backend.listTicketsTolerant()],
      ["createTicket", () => backend.createTicket()],
      ["updateTicket", () => backend.updateTicket()],
      ["readSession", () => backend.readSession()],
      ["listSessions", () => backend.listSessions()],
      ["listSessionsTolerant", () => backend.listSessionsTolerant()],
      ["createSession", () => backend.createSession()],
      ["updateSession", () => backend.updateSession()],
      ["readEvent", () => backend.readEvent()],
      ["appendEvent", () => backend.appendEvent()],
      ["queryEvents", () => backend.queryEvents()],
      ["listEvents", () => backend.listEvents()],
      ["listEventsTolerant", () => backend.listEventsTolerant()],
      ["resolveTicketRef", () => backend.resolveTicketRef()],
      ["resolveTicketRefs", () => backend.resolveTicketRefs()],
      ["loadIndex", () => backend.loadIndex()],
      ["rebuildIndex", () => backend.rebuildIndex()],
      ["transact", () => backend.transact(async () => undefined)],
      ["sweepTempFiles", () => backend.sweepTempFiles()],
      ["migrateEventShards", () => backend.migrateEventShards()],
    ];
    for (const [name, call] of methodCalls) {
      expect(call, name).toThrow(new RegExp(`attempted "${name}"`));
    }
  });
});
