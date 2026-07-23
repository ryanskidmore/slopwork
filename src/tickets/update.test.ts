import { describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import type { Ticket } from "../core/index.js";
import { newTicketId, ticketSchema } from "../core/index.js";
import { buildUpdate, parseLabelOp } from "./update.js";
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
  return { labelOps: [], ...overrides };
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

  describe("--state", () => {
    it("performs a legal direct transition (open -> in_progress), verb ticket.state_changed", () => {
      const before = makeTicket({ state: "open" });
      const result = buildUpdate(before, baseInput({ state: "in_progress" }), clock);
      expect(result.ticket.state).toBe("in_progress");
      expect(result.verb).toBe("ticket.state_changed");
      expect(result.payload).toMatchObject({ from: "open", to: "in_progress" });
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

    it("review -> in_progress clears the review sub-object (D15 changes-requested re-entry)", () => {
      const before = makeTicket({
        state: "review",
        review: { requested_at: "2026-07-23T09:00:00.000Z", by: { name: "ryan", kind: "human" } },
      });
      const result = buildUpdate(before, baseInput({ state: "in_progress" }), clock);
      expect(result.ticket.state).toBe("in_progress");
      expect(result.ticket.review).toBeUndefined();
    });

    it("same-state is a legal no-op (verb stays ticket.updated if nothing else changed... here progress also given to have something to do)", () => {
      const before = makeTicket({ state: "open" });
      const result = buildUpdate(before, baseInput({ state: "open", progress: "note" }), clock);
      expect(result.ticket.state).toBe("open");
      expect(result.verb).toBe("ticket.updated");
    });
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
        state: "in_progress",
      }),
      clock,
    );
    expect(result.ticket.latest_note).toBe("note");
    expect(result.ticket.priority).toBe(0);
    expect(result.ticket.labels.sort()).toEqual(["x", "y"].sort());
    expect(result.ticket.name).toBe("Renamed");
    expect(result.ticket.state).toBe("in_progress");
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
