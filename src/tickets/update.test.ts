import { describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import type { Ticket } from "../core/index.js";
import { EXIT_CODES, newTicketId, ticketSchema } from "../core/index.js";
import { SlopError } from "../cli/errors.js";
import { buildUpdate, parseLabelOp, parseRelatesToOpText } from "./update.js";
import type { UpdateInput } from "./update.js";

const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "A ticket",
    slug: "a-ticket",
    spec: { summary: "s" },
    state: "open",
    priority: 2,
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function baseInput(overrides: Partial<UpdateInput> = {}): UpdateInput {
  return { labelOps: [], acceptance: [], context: [], ...overrides };
}

describe("parseLabelOp", () => {
  it("parses + and -", () => {
    expect(parseLabelOp("+bug")).toEqual({ op: "+", label: "bug" });
    expect(parseLabelOp("-triage")).toEqual({ op: "-", label: "triage" });
  });

  it("rejects a missing sigil", () => {
    expect(() => parseLabelOp("bug")).toThrow();
  });

  it("rejects an empty label after the sigil", () => {
    expect(() => parseLabelOp("+")).toThrow();
  });
});

// ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J: `--relates-to <±ref>` uses the same
// sigil convention as `--label <±label>` — mirrors parseLabelOp's own
// tests, just naming a ref rather than a label.
describe("parseRelatesToOpText", () => {
  it("parses + and -", () => {
    expect(parseRelatesToOpText("+auth-migration")).toEqual({
      op: "+",
      ref: "auth-migration",
    });
    expect(parseRelatesToOpText("-old-spike")).toEqual({ op: "-", ref: "old-spike" });
  });

  it("rejects a missing sigil", () => {
    expect(() => parseRelatesToOpText("auth-migration")).toThrow();
  });

  it("rejects an empty ref after the sigil", () => {
    expect(() => parseRelatesToOpText("+")).toThrow();
  });
});

describe("buildUpdate", () => {
  it("rejects a call with no flags at all", () => {
    expect(() => buildUpdate(makeTicket(), baseInput(), clock)).toThrow();
  });

  it("--progress: sets latest_note, bumps last_activity_at and updated_at, verb ticket.updated", () => {
    const before = makeTicket();
    const result = buildUpdate(before, baseInput({ progress: "made progress" }), clock);
    expect(result.ticket.latest_note).toBe("made progress");
    expect(result.ticket.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    expect(result.ticket.updated_at).toBe("2026-07-23T12:00:00.000Z");
    expect(result.verb).toBe("ticket.updated");
    expect(result.payload).toMatchObject({ progress: "made progress" });
  });

  it("--priority", () => {
    const result = buildUpdate(makeTicket({ priority: 2 }), baseInput({ priority: 0 }), clock);
    expect(result.ticket.priority).toBe(0);
  });

  it("--label +x -y adds and removes", () => {
    const before = makeTicket({ labels: ["keep", "drop"] });
    const result = buildUpdate(before, baseInput({ labelOps: ["+new", "-drop"] }), clock);
    expect(result.ticket.labels.sort()).toEqual(["keep", "new"].sort());
  });

  it("--label + on an already-present label is a no-op (no duplicate)", () => {
    const before = makeTicket({ labels: ["dup"] });
    const result = buildUpdate(before, baseInput({ labelOps: ["+dup"] }), clock);
    expect(result.ticket.labels).toEqual(["dup"]);
  });

  // ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J: `--relates-to <±ref>` add/remove.
  // `buildUpdate` only ever sees already-resolved `TicketId`s here — ref
  // resolution is `src/cli/commands/update.ts`'s job (see this module's
  // top doc) — so these tests exercise `relatesToOps` directly, the same
  // way the `--label` tests above pass already-parsed `labelOps` text.
  describe("--relates-to", () => {
    it("+id adds a relates-to edge", () => {
      const target = newTicketId();
      const before = makeTicket({ relates_to: [] });
      const result = buildUpdate(
        before,
        baseInput({ relatesToOps: [{ op: "+", id: target }] }),
        clock,
      );
      expect(result.ticket.relates_to).toEqual([target]);
      expect(result.payload).toMatchObject({ relates_to: [target] });
    });

    it("-id removes a relates-to edge", () => {
      const target = newTicketId();
      const before = makeTicket({ relates_to: [target] });
      const result = buildUpdate(
        before,
        baseInput({ relatesToOps: [{ op: "-", id: target }] }),
        clock,
      );
      expect(result.ticket.relates_to).toEqual([]);
    });

    it("+id and -id combined in one call: add one, remove another", () => {
      const keep = newTicketId();
      const drop = newTicketId();
      const add = newTicketId();
      const before = makeTicket({ relates_to: [keep, drop] });
      const result = buildUpdate(
        before,
        baseInput({
          relatesToOps: [
            { op: "+", id: add },
            { op: "-", id: drop },
          ],
        }),
        clock,
      );
      expect(result.ticket.relates_to.sort()).toEqual([keep, add].sort());
    });

    it("+id on an already-present target is a no-op (no duplicate, edges are a set)", () => {
      const target = newTicketId();
      const before = makeTicket({
        relates_to: [target],
        updated_at: "2026-07-23T10:00:00.000Z",
        last_activity_at: "2026-07-23T10:00:00.000Z",
      });
      const result = buildUpdate(
        before,
        baseInput({ relatesToOps: [{ op: "+", id: target }] }),
        clock,
      );
      expect(result.ticket.relates_to).toEqual([target]);
      // Fully redundant, nothing else given: no bump, empty patch, empty
      // payload — same "no fake mutation" rule as the `--label` no-op above.
      expect(result.ticket.updated_at).toBe("2026-07-23T10:00:00.000Z");
      expect(result.patch).toEqual([]);
      expect(result.payload).toEqual({});
    });

    it("-id on an absent target is a no-op", () => {
      const before = makeTicket({ relates_to: [] });
      const result = buildUpdate(
        before,
        baseInput({ relatesToOps: [{ op: "-", id: newTicketId() }] }),
        clock,
      );
      expect(result.ticket.relates_to).toEqual([]);
      expect(result.patch).toEqual([]);
    });

    it("the patch includes relates_to when it actually changed", () => {
      const target = newTicketId();
      const before = makeTicket({ relates_to: [] });
      const result = buildUpdate(
        before,
        baseInput({ relatesToOps: [{ op: "+", id: target }] }),
        clock,
      );
      const paths = result.patch.map((p) => p.path[0]);
      expect(paths).toContain("relates_to");
      expect(paths).toContain("updated_at");
    });
  });

  it("--name renames WITHOUT touching the slug (D12: slugs are stable handles)", () => {
    const before = makeTicket({ name: "Old name", slug: "old-slug" });
    const result = buildUpdate(before, baseInput({ name: "New name" }), clock);
    expect(result.ticket.name).toBe("New name");
    expect(result.ticket.slug).toBe("old-slug");
  });

  it("--spec (JSON) replaces the whole spec", () => {
    const before = makeTicket({
      spec: {
        summary: "old",
        details_md: "old detail",
        acceptance: [],
        context: [],
        meta: {},
        v: 1,
      },
    });
    const result = buildUpdate(
      before,
      baseInput({ specRaw: JSON.stringify({ summary: "new summary" }) }),
      clock,
    );
    expect(result.ticket.spec.summary).toBe("new summary");
    expect(result.ticket.spec.details_md).toBe("");
  });

  it("--spec (bare markdown) replaces details_md, defaulting summary from the CURRENT name", () => {
    const before = makeTicket({ name: "Ticket name" });
    const result = buildUpdate(before, baseInput({ specRaw: "just prose" }), clock);
    expect(result.ticket.spec.details_md).toBe("just prose");
    expect(result.ticket.spec.summary).toBe("Ticket name");
  });

  describe("--summary/--details/--acceptance/--context (structured spec field flags)", () => {
    function specTicket(): Ticket {
      return makeTicket({
        spec: {
          summary: "old summary",
          details_md: "old detail",
          acceptance: ["old criterion"],
          context: ["old context"],
          meta: {},
          v: 1,
        },
      });
    }

    it("--summary alone changes only summary, everything else on the current spec is untouched", () => {
      const before = specTicket();
      const result = buildUpdate(before, baseInput({ summaryRaw: "new summary" }), clock);
      expect(result.ticket.spec.summary).toBe("new summary");
      expect(result.ticket.spec.details_md).toBe("old detail");
      expect(result.ticket.spec.acceptance).toEqual(["old criterion"]);
      expect(result.ticket.spec.context).toEqual(["old context"]);
    });

    it("--details alone changes only details_md", () => {
      const before = specTicket();
      const result = buildUpdate(before, baseInput({ detailsRaw: "new detail" }), clock);
      expect(result.ticket.spec.details_md).toBe("new detail");
      expect(result.ticket.spec.summary).toBe("old summary");
    });

    it("--acceptance replaces the whole acceptance array, leaving context untouched", () => {
      const before = specTicket();
      const result = buildUpdate(before, baseInput({ acceptance: ["new criterion"] }), clock);
      expect(result.ticket.spec.acceptance).toEqual(["new criterion"]);
      expect(result.ticket.spec.context).toEqual(["old context"]);
    });

    it("--context replaces the whole context array, leaving acceptance untouched", () => {
      const before = specTicket();
      const result = buildUpdate(before, baseInput({ context: ["new context"] }), clock);
      expect(result.ticket.spec.context).toEqual(["new context"]);
      expect(result.ticket.spec.acceptance).toEqual(["old criterion"]);
    });

    it("payload.spec is true when a structured field flag actually changed the spec", () => {
      const before = specTicket();
      const result = buildUpdate(before, baseInput({ summaryRaw: "new summary" }), clock);
      expect(result.payload.spec).toBe(true);
    });

    it("combining --spec with a structured field flag is a USAGE_ERROR, current spec left untouched", () => {
      const before = specTicket();
      expect(() =>
        buildUpdate(
          before,
          baseInput({ specRaw: JSON.stringify({ summary: "x" }), summaryRaw: "y" }),
          clock,
        ),
      ).toThrow(SlopError);
      try {
        buildUpdate(
          before,
          baseInput({ specRaw: JSON.stringify({ summary: "x" }), acceptance: ["a"] }),
          clock,
        );
        expect.unreachable("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SlopError);
        expect((err as SlopError).exitCode).toBe(EXIT_CODES.USAGE_ERROR);
      }
    });
  });

  describe("--state", () => {
    it("performs a legal direct transition (open -> draft, D13), verb ticket.state_changed", () => {
      const before = makeTicket({ state: "open" });
      const result = buildUpdate(before, baseInput({ state: "draft" }), clock);
      expect(result.ticket.state).toBe("draft");
      expect(result.verb).toBe("ticket.state_changed");
      expect(result.payload).toMatchObject({ from: "open", to: "draft" });
      // A state change is activity: last_activity_at bumps too.
      expect(result.ticket.last_activity_at).toBe("2026-07-23T12:00:00.000Z");
    });

    it("rejects an unknown state name as a usage error", () => {
      expect(() => buildUpdate(makeTicket(), baseInput({ state: "bogus" }), clock)).toThrow();
    });

    it('rejects an illegal transition with exit 6 (CONFLICT) — "must reject illegal transitions per §2"', () => {
      const before = makeTicket({ state: "draft" });
      let thrown: unknown;
      try {
        buildUpdate(before, baseInput({ state: "in_progress" }), clock);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ exitCode: 6 });
    });

    // Fix 1 (adversarial-review, C3 escape-hatch hole): `update --state`
    // is now restricted to D13's side-effect-free `draft <-> open` edges
    // ONLY — every session-carrying/session-creating/cascading edge is
    // rejected here, each with a message naming the dedicated command.

    it("rejects setting in_progress directly (needs a fresh session — slop start), exit 6", () => {
      let thrown: unknown;
      try {
        buildUpdate(makeTicket({ state: "open" }), baseInput({ state: "in_progress" }), clock);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ exitCode: 6 });
      expect((thrown as Error).message).toMatch(/slop start/);
    });

    it("rejects setting review directly (needs slop review --mr), exit 6", () => {
      let thrown: unknown;
      try {
        buildUpdate(makeTicket({ state: "in_progress" }), baseInput({ state: "review" }), clock);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ exitCode: 6 });
    });

    it("rejects setting done directly (needs slop done), exit 6", () => {
      const before = makeTicket({
        state: "review",
        review: { requested_at: "2026-07-23T09:00:00.000Z", by: { name: "ryan", kind: "human" } },
      });
      let thrown: unknown;
      try {
        buildUpdate(before, baseInput({ state: "done" }), clock);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ exitCode: 6 });
    });

    it("rejects setting dropped directly — the escape hatch that used to resurrect a dropped ticket via a later `stop` (needs slop drop --reason, which finalizes the session and cascades), exit 6", () => {
      const before = makeTicket({ state: "in_progress", active_session: null });
      let thrown: unknown;
      try {
        buildUpdate(before, baseInput({ state: "dropped" }), clock);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ exitCode: 6 });
      expect((thrown as Error).message).toMatch(/slop drop/);
    });

    it("rejects review -> in_progress directly — the escape hatch that used to be an unlogged, session-less changes-requested path (needs slop start: fresh session + logged re_entry), exit 6", () => {
      const before = makeTicket({
        state: "review",
        review: { requested_at: "2026-07-23T09:00:00.000Z", by: { name: "ryan", kind: "human" } },
      });
      let thrown: unknown;
      try {
        buildUpdate(before, baseInput({ state: "in_progress" }), clock);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ exitCode: 6 });
    });

    it("rejects in_progress -> open directly — the escape hatch that used to orphan the active session (needs slop stop, which ends it), exit 6", () => {
      const before = makeTicket({ state: "in_progress" });
      let thrown: unknown;
      try {
        buildUpdate(before, baseInput({ state: "open" }), clock);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toMatchObject({ exitCode: 6 });
      expect((thrown as Error).message).toMatch(/slop stop/);
    });

    it("same-state is a legal no-op (verb stays ticket.updated if nothing else changed... here progress also given to have something to do)", () => {
      const before = makeTicket({ state: "open" });
      const result = buildUpdate(before, baseInput({ state: "open", progress: "note" }), clock);
      expect(result.ticket.state).toBe("open");
      expect(result.verb).toBe("ticket.updated");
    });

    // Polish batch item 1: a same-state call with no other real field
    // change is a fake mutation and must do NOTHING — no bumped
    // updated_at/last_activity_at, no patch, an empty payload (so a
    // caller can tell there's nothing worth writing or emitting an event
    // for) — mirroring draft.ts/undraft.ts's E1 same-state no-op.
    it("--state <same>, nothing else given: no updated_at/last_activity_at bump, empty patch, empty payload", () => {
      const before = makeTicket({
        state: "open",
        updated_at: "2026-07-23T10:00:00.000Z",
        last_activity_at: "2026-07-23T10:00:00.000Z",
      });
      const result = buildUpdate(before, baseInput({ state: "open" }), clock);
      expect(result.ticket.state).toBe("open");
      expect(result.ticket.updated_at).toBe("2026-07-23T10:00:00.000Z");
      expect(result.ticket.last_activity_at).toBe("2026-07-23T10:00:00.000Z");
      expect(result.patch).toEqual([]);
      expect(result.verb).toBe("ticket.updated");
      expect(result.payload).toEqual({});
    });

    it("--state <same> combined with a real change (--priority) still bumps updated_at and produces a patch for the real change only", () => {
      const before = makeTicket({
        state: "open",
        priority: 2,
        updated_at: "2026-07-23T10:00:00.000Z",
      });
      const result = buildUpdate(before, baseInput({ state: "open", priority: 0 }), clock);
      expect(result.ticket.state).toBe("open");
      expect(result.ticket.priority).toBe(0);
      expect(result.ticket.updated_at).toBe("2026-07-23T12:00:00.000Z");
      const paths = result.patch.map((p) => p.path[0]);
      expect(paths).toContain("priority");
      expect(paths).toContain("updated_at");
      expect(paths).not.toContain("state");
    });
  });

  // Polish batch item 1, general case: a redundant --label add (already
  // present, so applyLabelOps produces no actual change) with nothing
  // else given is the same kind of fake mutation as a same-state --state
  // call — must not bump timestamps or produce a patch either.
  it("a fully redundant --label +already-present with nothing else given is also a no-op: no bump, empty patch", () => {
    const before = makeTicket({
      labels: ["dup"],
      updated_at: "2026-07-23T10:00:00.000Z",
      last_activity_at: "2026-07-23T10:00:00.000Z",
    });
    const result = buildUpdate(before, baseInput({ labelOps: ["+dup"] }), clock);
    expect(result.ticket.labels).toEqual(["dup"]);
    expect(result.ticket.updated_at).toBe("2026-07-23T10:00:00.000Z");
    expect(result.ticket.last_activity_at).toBe("2026-07-23T10:00:00.000Z");
    expect(result.patch).toEqual([]);
    expect(result.payload).toEqual({});
  });

  it("combining multiple flags in one call", () => {
    const before = makeTicket({ state: "open", priority: 2, labels: ["x"] });
    const result = buildUpdate(
      before,
      baseInput({
        progress: "note",
        priority: 0,
        labelOps: ["+y"],
        name: "Renamed",
        state: "draft",
      }),
      clock,
    );
    expect(result.ticket.latest_note).toBe("note");
    expect(result.ticket.priority).toBe(0);
    expect(result.ticket.labels.sort()).toEqual(["x", "y"].sort());
    expect(result.ticket.name).toBe("Renamed");
    expect(result.ticket.state).toBe("draft");
    expect(result.verb).toBe("ticket.state_changed");
  });

  it("the patch only touches fields that actually changed", () => {
    const before = makeTicket({ priority: 2 });
    const result = buildUpdate(before, baseInput({ priority: 0 }), clock);
    const paths = result.patch.map((p) => p.path[0]);
    expect(paths).toContain("priority");
    expect(paths).toContain("updated_at");
    expect(paths).not.toContain("name");
    expect(paths).not.toContain("labels");
  });
});
