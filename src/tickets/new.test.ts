import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "../core/clock.js";
import type { Ticket } from "../core/index.js";
import { EXIT_CODES, newTicketId, ticketSchema } from "../core/index.js";
import type { EventContext, MutationEventSpec } from "../repo/events.js";
import { ensureDbDirs } from "../repo/paths.js";
import type { RepoPaths } from "../repo/paths.js";
import { createTicket } from "../repo/tickets.js";
import { buildNewTicket } from "./new.js";
import type { NewTicketInput } from "./new.js";

const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };
const actor = { name: "ryan", kind: "human" as const };
const clock = fixedClock(new Date("2026-07-23T12:00:00.000Z"));

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  const id = overrides.id ?? newTicketId();
  return ticketSchema.parse({
    id,
    name: "Ticket",
    slug: `ticket-${id.slice(-8).toLowerCase()}`,
    spec: { summary: "s" },
    state: "open",
    root_id: id,
    provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
    last_activity_at: "2026-07-23T10:00:00.000Z",
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  });
}

function baseInput(overrides: Partial<NewTicketInput> = {}): NewTicketInput {
  return {
    name: "Add auth provider",
    blocksRaw: [],
    relatesToRaw: [],
    acceptance: [],
    context: [],
    labels: [],
    draft: false,
    adhoc: false,
    priority: 2,
    actor,
    ...overrides,
  };
}

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-new-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("buildNewTicket — every §4.2 `new` creation flag", () => {
  it("bare name only: sensible defaults everywhere", async () => {
    const { ticket, warnings } = await buildNewTicket(paths, baseInput(), clock);
    expect(ticket.name).toBe("Add auth provider");
    expect(ticket.slug).toBe("add-auth-provider");
    expect(ticket.spec).toEqual({
      summary: "Add auth provider",
      details_md: "",
      acceptance: [],
      context: [],
      meta: {},
      v: 1,
    });
    expect(ticket.state).toBe("open");
    expect(ticket.priority).toBe(2);
    expect(ticket.labels).toEqual([]);
    expect(ticket.adhoc).toBe(false);
    expect(ticket.parent).toBeUndefined();
    expect(ticket.root_id).toBe(ticket.id);
    expect(ticket.path).toEqual([]);
    expect(ticket.owner).toBeNull();
    expect(ticket.blocks).toEqual([]);
    expect(ticket.discovered_from).toEqual([]);
    expect(ticket.provenance).toEqual({ method: "new", created_by: actor });
    expect(ticket.created_at).toBe("2026-07-23T12:00:00.000Z");
    expect(warnings).toEqual([]);
  });

  it("an empty or whitespace-only name is a clean USAGE_ERROR(2), never a raw ZodError (regression: raw-zoderrors-escape-as-exit)", async () => {
    let caughtEmpty: unknown;
    try {
      await buildNewTicket(paths, baseInput({ name: "" }), clock);
    } catch (err) {
      caughtEmpty = err;
    }
    expect(caughtEmpty).toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
    expect((caughtEmpty as { name?: string }).name).not.toBe("ZodError");

    await expect(buildNewTicket(paths, baseInput({ name: "   " }), clock)).rejects.toMatchObject({
      exitCode: EXIT_CODES.USAGE_ERROR,
    });
  });

  it("--spec (JSON, structural)", async () => {
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({ specRaw: JSON.stringify({ summary: "Custom", acceptance: ["a"] }) }),
      clock,
    );
    expect(ticket.spec.summary).toBe("Custom");
    expect(ticket.spec.acceptance).toEqual(["a"]);
  });

  it("--spec (bare markdown -> details_md, D10)", async () => {
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({ specRaw: "# Notes\nSome prose." }),
      clock,
    );
    expect(ticket.spec.details_md).toBe("# Notes\nSome prose.");
    expect(ticket.spec.summary).toBe("Add auth provider");
  });

  it("--summary/--details/--acceptance/--context: structured spec fields, no --spec needed", async () => {
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({
        summaryRaw: "Structured summary",
        detailsRaw: "Structured prose",
        acceptance: ["criterion 1", "criterion 2"],
        context: ["src/foo.ts:12"],
      }),
      clock,
    );
    expect(ticket.spec.summary).toBe("Structured summary");
    expect(ticket.spec.details_md).toBe("Structured prose");
    expect(ticket.spec.acceptance).toEqual(["criterion 1", "criterion 2"]);
    expect(ticket.spec.context).toEqual(["src/foo.ts:12"]);
  });

  it("--acceptance/--context alone still default summary from the name, same as no --spec at all", async () => {
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({ acceptance: ["criterion 1"] }),
      clock,
    );
    expect(ticket.spec.summary).toBe("Add auth provider");
    expect(ticket.spec.acceptance).toEqual(["criterion 1"]);
  });

  it("combining --spec with a structured field flag is a USAGE_ERROR, before any resolution happens", async () => {
    await expect(
      buildNewTicket(
        paths,
        baseInput({ specRaw: JSON.stringify({ summary: "x" }), summaryRaw: "y" }),
        clock,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
    await expect(
      buildNewTicket(
        paths,
        baseInput({ specRaw: JSON.stringify({ summary: "x" }), acceptance: ["a"] }),
        clock,
      ),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
  });

  it("--parent (local, resolved via slug)", async () => {
    const parent = makeTicket({ name: "Parent", slug: "parent" });
    await createTicket(paths, parent, ctx, createdEvent);
    const { ticket } = await buildNewTicket(paths, baseInput({ parentRaw: "parent" }), clock);
    expect(ticket.parent).toBe(parent.id);
    expect(ticket.root_id).toBe(parent.id);
    expect(ticket.path).toEqual([parent.id]);
  });

  it("--parent jira:PROJ-123 (external; local root; warns only on malformed key)", async () => {
    const { ticket, warnings } = await buildNewTicket(
      paths,
      baseInput({ parentRaw: "jira:PROJ-123" }),
      clock,
    );
    expect(ticket.parent).toBe("jira:PROJ-123");
    expect(ticket.root_id).toBe(ticket.id);
    expect(ticket.path).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("--parent jira:malformed still creates, with a warning, never blocking (§8.2 item 5)", async () => {
    const { ticket, warnings } = await buildNewTicket(
      paths,
      baseInput({ parentRaw: "jira:not-a-key" }),
      clock,
    );
    expect(ticket.parent).toBe("jira:not-a-key");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/doesn't look like/);
  });

  it("--blocks (repeatable, resolved to ticket ids)", async () => {
    const b1 = makeTicket({ slug: "b1" });
    const b2 = makeTicket({ slug: "b2" });
    await createTicket(paths, b1, ctx, createdEvent);
    await createTicket(paths, b2, ctx, createdEvent);
    const { ticket } = await buildNewTicket(paths, baseInput({ blocksRaw: ["b1", "b2"] }), clock);
    expect(ticket.blocks.sort()).toEqual([b1.id, b2.id].sort());
  });

  // ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J: `--relates-to` mirrors `--blocks`
  // exactly (same resolution, same dedup treatment) — the only difference
  // is which ticket field the resolved ids land in.
  it("--relates-to (repeatable, resolved to ticket ids)", async () => {
    const r1 = makeTicket({ slug: "r1" });
    const r2 = makeTicket({ slug: "r2" });
    await createTicket(paths, r1, ctx, createdEvent);
    await createTicket(paths, r2, ctx, createdEvent);
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({ relatesToRaw: ["r1", "r2"] }),
      clock,
    );
    expect(ticket.relates_to.sort()).toEqual([r1.id, r2.id].sort());
  });

  it("--discovered-from (resolved to a one-element array)", async () => {
    const origin = makeTicket({ slug: "origin" });
    await createTicket(paths, origin, ctx, createdEvent);
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({ discoveredFromRaw: "origin" }),
      clock,
    );
    expect(ticket.discovered_from).toEqual([origin.id]);
  });

  it("--label (repeatable)", async () => {
    const { ticket } = await buildNewTicket(
      paths,
      baseInput({ labels: ["type:feature", "team:core"] }),
      clock,
    );
    expect(ticket.labels).toEqual(["type:feature", "team:core"]);
  });

  it("--label starting with + or - is a USAGE_ERROR — that's update's ±label syntax, not new's", async () => {
    await expect(
      buildNewTicket(paths, baseInput({ labels: ["+bug"] }), clock),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
    await expect(
      buildNewTicket(paths, baseInput({ labels: ["-weird"] }), clock),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
    // A good label alongside a bad one still rejects the whole call —
    // never partially applies.
    await expect(
      buildNewTicket(paths, baseInput({ labels: ["good", "+bad"] }), clock),
    ).rejects.toMatchObject({ exitCode: EXIT_CODES.USAGE_ERROR });
  });

  it("--draft (state draft; D13: drafts never ready)", async () => {
    const { ticket } = await buildNewTicket(paths, baseInput({ draft: true }), clock);
    expect(ticket.state).toBe("draft");
  });

  it("--adhoc", async () => {
    const { ticket } = await buildNewTicket(paths, baseInput({ adhoc: true }), clock);
    expect(ticket.adhoc).toBe(true);
  });

  it("--owner", async () => {
    const { ticket } = await buildNewTicket(paths, baseInput({ ownerRaw: "ryan" }), clock);
    expect(ticket.owner).toEqual({ name: "ryan", kind: "human" });
  });

  it("--priority", async () => {
    const { ticket } = await buildNewTicket(paths, baseInput({ priority: 0 }), clock);
    expect(ticket.priority).toBe(0);
  });

  it("rejects an out-of-range priority as a usage error", async () => {
    await expect(buildNewTicket(paths, baseInput({ priority: 9 }), clock)).rejects.toMatchObject({
      exitCode: 2,
    });
  });

  it("all flags combined at once", async () => {
    const parent = makeTicket({ slug: "combo-parent" });
    const blocker = makeTicket({ slug: "combo-blocker" });
    const related = makeTicket({ slug: "combo-related" });
    const origin = makeTicket({ slug: "combo-origin" });
    await createTicket(paths, parent, ctx, createdEvent);
    await createTicket(paths, blocker, ctx, createdEvent);
    await createTicket(paths, related, ctx, createdEvent);
    await createTicket(paths, origin, ctx, createdEvent);

    const { ticket, warnings } = await buildNewTicket(
      paths,
      baseInput({
        specRaw: JSON.stringify({ summary: "Combo summary" }),
        parentRaw: "combo-parent",
        blocksRaw: ["combo-blocker"],
        relatesToRaw: ["combo-related"],
        discoveredFromRaw: "combo-origin",
        labels: ["a:b"],
        draft: true,
        adhoc: true,
        ownerRaw: "ryan",
        priority: 0,
      }),
      clock,
    );

    expect(ticket.spec.summary).toBe("Combo summary");
    expect(ticket.parent).toBe(parent.id);
    expect(ticket.root_id).toBe(parent.id);
    expect(ticket.path).toEqual([parent.id]);
    expect(ticket.blocks).toEqual([blocker.id]);
    expect(ticket.relates_to).toEqual([related.id]);
    expect(ticket.discovered_from).toEqual([origin.id]);
    expect(ticket.labels).toEqual(["a:b"]);
    expect(ticket.state).toBe("draft");
    expect(ticket.adhoc).toBe(true);
    expect(ticket.owner).toEqual({ name: "ryan", kind: "human" });
    expect(ticket.priority).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("throws NOT_FOUND for an unresolvable --blocks ref", async () => {
    await expect(
      buildNewTicket(paths, baseInput({ blocksRaw: ["no-such-ticket"] }), clock),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  it("throws NOT_FOUND for an unresolvable --relates-to ref", async () => {
    await expect(
      buildNewTicket(paths, baseInput({ relatesToRaw: ["no-such-ticket"] }), clock),
    ).rejects.toMatchObject({ exitCode: 4 });
  });

  // B3: buildNewTicket now runs the graph module (edges.ts) before
  // returning — a cycle is structurally impossible at creation (see B3's
  // report for why), but the degree cap and --blocks/--relates-to
  // deduplication are both real, reachable creation-time behaviors.
  describe("B3: graph validation wired into `new`", () => {
    it("--blocks repeated for the SAME ticket is deduplicated, not stored twice", async () => {
      const b1 = makeTicket({ slug: "b1" });
      await createTicket(paths, b1, ctx, createdEvent);
      const { ticket } = await buildNewTicket(paths, baseInput({ blocksRaw: ["b1", "b1"] }), clock);
      expect(ticket.blocks).toEqual([b1.id]);
    });

    it("rejects --blocks past the per-ticket per-edge-kind cap (exit 6)", async () => {
      const blockers: Ticket[] = [];
      for (let i = 0; i < 501; i++) {
        const t = makeTicket({ slug: `blocker-${i}` });
        await createTicket(paths, t, ctx, createdEvent);
        blockers.push(t);
      }
      await expect(
        buildNewTicket(paths, baseInput({ blocksRaw: blockers.map((b) => b.slug) }), clock),
      ).rejects.toMatchObject({ exitCode: 6 });
    });

    // ticket_01KYA3Z9FNZ2FDMDRWNKR9EV7J: `--relates-to` goes through the
    // exact same resolution + validation path as `--blocks` above.
    it("--relates-to repeated for the SAME ticket is deduplicated, not stored twice", async () => {
      const r1 = makeTicket({ slug: "r1" });
      await createTicket(paths, r1, ctx, createdEvent);
      const { ticket } = await buildNewTicket(
        paths,
        baseInput({ relatesToRaw: ["r1", "r1"] }),
        clock,
      );
      expect(ticket.relates_to).toEqual([r1.id]);
    });

    it("rejects --relates-to past the per-ticket per-edge-kind cap (exit 6)", async () => {
      const relateds: Ticket[] = [];
      for (let i = 0; i < 501; i++) {
        const t = makeTicket({ slug: `related-${i}` });
        await createTicket(paths, t, ctx, createdEvent);
        relateds.push(t);
      }
      await expect(
        buildNewTicket(paths, baseInput({ relatesToRaw: relateds.map((r) => r.slug) }), clock),
      ).rejects.toMatchObject({ exitCode: 6 });
    });
  });

  // D12: explicit `--slug` (short, branch-style handle, optionally with a
  // single "<type>/" prefix) — validated/normalized rather than derived
  // from `name`, but going through the SAME collision rule as the
  // auto-generated path.
  describe("D12: --slug (short, branch-style handle)", () => {
    it("is accepted, normalized (lowercased), and stored verbatim otherwise", async () => {
      const { ticket } = await buildNewTicket(
        paths,
        baseInput({ name: "Fix: UI not showing", slugRaw: "fix/ui-not-showing" }),
        clock,
      );
      expect(ticket.slug).toBe("fix/ui-not-showing");
    });

    it("lowercases a mixed-case --slug", async () => {
      const { ticket } = await buildNewTicket(
        paths,
        baseInput({ slugRaw: "FEAT/Add-Auth" }),
        clock,
      );
      expect(ticket.slug).toBe("feat/add-auth");
    });

    it("wins over auto-generation from name — name is NOT slugified when --slug is given", async () => {
      const { ticket } = await buildNewTicket(
        paths,
        baseInput({ name: "Completely different long name here", slugRaw: "short-handle" }),
        clock,
      );
      expect(ticket.slug).toBe("short-handle");
    });

    it("an invalid --slug is rejected as a usage error (exit 2), before touching the disk", async () => {
      await expect(
        buildNewTicket(paths, baseInput({ slugRaw: "not a valid slug" }), clock),
      ).rejects.toMatchObject({ exitCode: 2 });
      await expect(
        buildNewTicket(paths, baseInput({ slugRaw: "a/b/c" }), clock),
      ).rejects.toMatchObject({ exitCode: 2 });
      await expect(
        buildNewTicket(paths, baseInput({ slugRaw: "/leading" }), clock),
      ).rejects.toMatchObject({ exitCode: 2 });
      await expect(buildNewTicket(paths, baseInput({ slugRaw: "" }), clock)).rejects.toMatchObject({
        exitCode: 2,
      });
    });

    it("uniqueness: a --slug colliding with an existing ticket gets a -2 suffix, never overwritten", async () => {
      const existing = makeTicket({ slug: "fix/ui-not-showing" });
      await createTicket(paths, existing, ctx, createdEvent);
      const { ticket } = await buildNewTicket(
        paths,
        baseInput({ slugRaw: "fix/ui-not-showing" }),
        clock,
      );
      expect(ticket.slug).toBe("fix/ui-not-showing-2");
      expect(ticket.slug).not.toBe(existing.slug);
    });

    it("uniqueness: two auto-generated tickets that would slug the same get distinct slugs", async () => {
      const first = await buildNewTicket(paths, baseInput({ name: "Same name" }), clock);
      await createTicket(paths, first.ticket, ctx, createdEvent);
      const second = await buildNewTicket(paths, baseInput({ name: "Same name" }), clock);
      expect(second.ticket.slug).not.toBe(first.ticket.slug);
      expect(second.ticket.slug).toBe("same-name-2");
    });
  });
});
