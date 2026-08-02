import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  newTicketId,
  shortTicketCode,
  type Ticket,
  type TicketId,
  ticketSchema,
} from "../core/index.js";
import type { IndexTicketRow } from "./db-index.js";
import type { EventContext, MutationEventSpec } from "./events.js";
import { ambiguousRefMessage, resolveTicketRef, resolveTicketRefs } from "./refs.js";
import { ensureDbDirs } from "./paths.js";
import type { RepoPaths } from "./paths.js";
import { createTicket } from "./tickets.js";

// A4: createTicket now requires an EventContext + a MutationEventSpec —
// these fixtures don't exercise event behavior, so a single fixed pair is
// reused across every createTicket call below.
const ctx: EventContext = { actor: { name: "ryan", kind: "human" }, session: null };
const createdEvent: MutationEventSpec = { verb: "ticket.created" };

function makeIndexRow(
  overrides: Partial<IndexTicketRow> & Pick<IndexTicketRow, "id">,
): IndexTicketRow {
  return {
    slug: "x",
    name: "X",
    state: "open",
    priority: 2,
    parent: null,
    root_id: overrides.id,
    path: [],
    labels: [],
    owner: null,
    latest_note: null,
    last_activity_at: "2026-07-23T10:00:00.000Z",
    active_session: null,
    blocked_by: [],
    related_from: [],
    discovered: [],
    blocked_count: null,
    ready: null,
    stale_at: null,
    review_stale_at: null,
    ...overrides,
  };
}

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

let scratch: string;
let paths: RepoPaths;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "slop-refs-test-"));
  paths = await ensureDbDirs(scratch);
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("resolveTicketRef — full id (exit criterion: not found -> exit 4)", () => {
  it("resolves by the full ticket_<ULID> id", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    await expect(resolveTicketRef(paths, t.id)).resolves.toEqual(t);
  });

  it("a well-formed but nonexistent full id is NOT_FOUND (exit 4)", async () => {
    await expect(resolveTicketRef(paths, newTicketId())).rejects.toMatchObject({ exitCode: 4 });
  });

  it("a ref that matches nothing at all is NOT_FOUND (exit 4)", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    await expect(resolveTicketRef(paths, "totally-unknown-ref")).rejects.toMatchObject({
      exitCode: 4,
    });
  });
});

describe("resolveTicketRef — exact slug", () => {
  it("resolves by exact slug", async () => {
    const t = makeTicket({ slug: "add-sso" });
    await createTicket(paths, t, ctx, createdEvent);
    await expect(resolveTicketRef(paths, "add-sso")).resolves.toEqual(t);
  });

  it("an exact slug match wins over an ambiguous short-prefix interpretation", async () => {
    // Two tickets whose ids share a prefix that happens to equal a
    // THIRD ticket's slug exactly — resolving by that slug string must
    // pick the slug match, not error out as an ambiguous prefix.
    const shared = "01ARZ3NDEKTSV4RRFFQ69G5FA";
    const idA = `ticket_${shared}1` as Ticket["id"];
    const idB = `ticket_${shared}2` as Ticket["id"];
    const a = makeTicket({ id: idA, root_id: idA, slug: "candidate-a" });
    const b = makeTicket({ id: idB, root_id: idB, slug: "candidate-b" });
    const slugTicket = makeTicket({ slug: shared.toLowerCase() });
    await createTicket(paths, a, ctx, createdEvent);
    await createTicket(paths, b, ctx, createdEvent);
    await createTicket(paths, slugTicket, ctx, createdEvent);

    // shared.toLowerCase() as a REF also happens to be a prefix of both
    // a.id's and b.id's bare ULID (since they share that literal
    // prefix) — without the "slug wins" rule this would be ambiguous.
    const resolved = await resolveTicketRef(paths, shared.toLowerCase());
    expect(resolved.id).toBe(slugTicket.id);
  });

  // Adversarial-review Finding 5: slug lookup used to be exact-case only
  // while idMatchesRef's short-prefix matching was already
  // case-insensitive (core/ids.ts) — an inconsistency that made
  // "Alpha-Ticket" fail to resolve against slug "alpha-ticket".
  it("resolves a slug ref case-insensitively", async () => {
    const t = makeTicket({ slug: "alpha-ticket" });
    await createTicket(paths, t, ctx, createdEvent);
    await expect(resolveTicketRef(paths, "Alpha-Ticket")).resolves.toEqual(t);
    await expect(resolveTicketRef(paths, "ALPHA-TICKET")).resolves.toEqual(t);
    await expect(resolveTicketRef(paths, "alpha-ticket")).resolves.toEqual(t); // exact case still works
  });

  it("case-insensitive exact slug still wins over an ambiguous short-prefix interpretation (precedence preserved)", async () => {
    const shared = "01ARZ3NDEKTSV4RRFFQ69G5FA";
    const idA = `ticket_${shared}1` as Ticket["id"];
    const idB = `ticket_${shared}2` as Ticket["id"];
    const a = makeTicket({ id: idA, root_id: idA, slug: "candidate-a" });
    const b = makeTicket({ id: idB, root_id: idB, slug: "candidate-b" });
    const slugTicket = makeTicket({ slug: shared.toLowerCase() });
    await createTicket(paths, a, ctx, createdEvent);
    await createTicket(paths, b, ctx, createdEvent);
    await createTicket(paths, slugTicket, ctx, createdEvent);

    // An UPPERCASE version of the ref: still a case-insensitive slug
    // match AND still a prefix match against a/b's ids (idMatchesRef is
    // already case-insensitive) — slug precedence must hold regardless
    // of which side of the comparison the case-folding happened on.
    const resolved = await resolveTicketRef(paths, shared.toUpperCase());
    expect(resolved.id).toBe(slugTicket.id);
  });
});

describe("resolveTicketRef — D12 branch-style slugs (a slug containing a single `/`)", () => {
  it("resolves a slug with a type/ prefix, e.g. fix/ui-not-showing", async () => {
    const t = makeTicket({ slug: "fix/ui-not-showing" });
    await createTicket(paths, t, ctx, createdEvent);
    await expect(resolveTicketRef(paths, "fix/ui-not-showing")).resolves.toEqual(t);
  });

  it("resolves a branch-style slug case-insensitively, same as any other slug", async () => {
    const t = makeTicket({ slug: "feat/add-auth" });
    await createTicket(paths, t, ctx, createdEvent);
    await expect(resolveTicketRef(paths, "FEAT/Add-Auth")).resolves.toEqual(t);
  });

  it("a nonexistent branch-style ref is NOT_FOUND (exit 4), not confused for an external ref or a short prefix", async () => {
    await expect(resolveTicketRef(paths, "fix/does-not-exist")).rejects.toMatchObject({
      exitCode: 4,
    });
  });

  it("does not disturb precedence: id/slug/t-<code> resolution for tickets that DON'T use a branch-style slug still works exactly as before", async () => {
    const withSlash = makeTicket({ slug: "fix/ui-not-showing" });
    const plain = makeTicket({ slug: "plain-ticket" });
    await createTicket(paths, withSlash, ctx, createdEvent);
    await createTicket(paths, plain, ctx, createdEvent);

    // Full id still resolves.
    await expect(resolveTicketRef(paths, plain.id)).resolves.toEqual(plain);
    // Plain slug still resolves.
    await expect(resolveTicketRef(paths, "plain-ticket")).resolves.toEqual(plain);
    // t-<code> handle still resolves.
    await expect(resolveTicketRef(paths, shortTicketCode(plain.id))).resolves.toEqual(plain);
    // Both tickets' own branch-style/plain slugs keep resolving to the
    // right one, side by side (no cross-contamination from the `/`).
    await expect(resolveTicketRef(paths, "fix/ui-not-showing")).resolves.toEqual(withSlash);
  });

  // Short-id-prefix resolution itself (idMatchesRef, step 4) is untouched
  // by D12 and already exhaustively covered by the "unique short prefix,
  // ambiguous prefix" describe block below — not re-derived here to avoid
  // a flaky same-millisecond ULID-prefix collision between two tickets
  // created back-to-back in one test.
});

describe("resolveTicketRef — unique short prefix, ambiguous prefix (git-style)", () => {
  it("resolves a unique short prefix", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    const shortRef = t.id.slice("ticket_".length, "ticket_".length + 8);
    await expect(resolveTicketRef(paths, shortRef)).resolves.toEqual(t);
  });

  it("an ambiguous short prefix errors git-style with exit code 5 and lists every candidate", async () => {
    const shared = "01ARZ3NDEKTSV4RRFFQ69G5FA";
    const idA = `ticket_${shared}1` as Ticket["id"];
    const idB = `ticket_${shared}2` as Ticket["id"];
    const a = makeTicket({ id: idA, root_id: idA, name: "Alpha ticket", slug: "alpha-ticket" });
    const b = makeTicket({ id: idB, root_id: idB, name: "Beta ticket", slug: "beta-ticket" });
    await createTicket(paths, a, ctx, createdEvent);
    await createTicket(paths, b, ctx, createdEvent);

    let threw: unknown;
    try {
      await resolveTicketRef(paths, shared.slice(0, 10));
    } catch (err) {
      threw = err;
    }
    expect(threw).toMatchObject({ exitCode: 5 });
    const message = (threw as Error).message;
    expect(message).toMatch(/ambiguous/i);
    expect(message).toContain(a.id);
    expect(message).toContain(b.id);
    expect(message).toContain(a.name);
    expect(message).toContain(b.name);
    expect(message).toContain(a.slug);
    expect(message).toContain(b.slug);
  });

  it("ambiguousRefMessage is modeled on git's error format", () => {
    const a = makeIndexRow({
      id: "ticket_01ARZ3NDEKTSV4RRFFQ69G5FA1" as Ticket["id"],
      slug: "alpha",
      name: "Alpha",
    });
    const b = makeIndexRow({
      id: "ticket_01ARZ3NDEKTSV4RRFFQ69G5FA2" as Ticket["id"],
      slug: "beta",
      name: "Beta",
    });
    const message = ambiguousRefMessage("01ARZ", [a, b]);
    expect(message).toMatch(/^short ref "01ARZ" is ambiguous/);
    expect(message).toContain("hint: the candidates are:");
    expect(message).toContain('hint:   ticket_01ARZ3NDEKTSV4RRFFQ69G5FA1  "Alpha" (alpha)');
  });
});

describe("resolveTicketRef — t-<code> short handles (ticket_01KY9RVF2DCG6TDQ8EBSGXQXT1)", () => {
  it("resolves a ticket's own t-<code> handle", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    const handle = shortTicketCode(t.id);
    await expect(resolveTicketRef(paths, handle)).resolves.toEqual(t);
  });

  it("resolves the handle case-insensitively", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    const handle = shortTicketCode(t.id);
    await expect(resolveTicketRef(paths, handle.toUpperCase())).resolves.toEqual(t);
  });

  it("a well-formed but nonexistent code is NOT_FOUND (exit 4)", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    // A different, deterministically-picked, valid-shaped code that isn't
    // this (or any) ticket's actual derived code.
    const real = shortTicketCode(t.id);
    const bogus = real === "t-00000" ? "t-00001" : "t-00000";
    await expect(resolveTicketRef(paths, bogus)).rejects.toMatchObject({
      exitCode: 4,
    });
  });

  it("a forced collision (two distinct ids sharing a derived code) is AMBIGUOUS_REF (exit 5), listing both candidates — never silently picked", async () => {
    // A real sha256-collision pair for shortTicketCode, found once via
    // brute-force search offline and hardcoded here so this test is
    // deterministic (searching for a collision live, in-test, against a
    // 36^5 ≈ 60.5M code space is not something to do on every test run).
    // Both are valid ticket_<ULID> ids (26-char Crockford base32 bodies);
    // shortTicketCode(idA) === shortTicketCode(idB) === "t-l4slk".
    const idA = "ticket_01KY9TRHGW7KQ1430JE45DH5NF" as Ticket["id"];
    const idB = "ticket_01KY9TRHH3NTEFFY28BH37YJQ9" as Ticket["id"];
    const collidingCode = "t-l4slk";
    expect(shortTicketCode(idA)).toBe(collidingCode);
    expect(shortTicketCode(idB)).toBe(collidingCode);

    const a = makeTicket({ id: idA, root_id: idA, name: "Collision A", slug: "collision-a" });
    const b = makeTicket({ id: idB, root_id: idB, name: "Collision B", slug: "collision-b" });
    await createTicket(paths, a, ctx, createdEvent);
    await createTicket(paths, b, ctx, createdEvent);

    let threw: unknown;
    try {
      await resolveTicketRef(paths, collidingCode);
    } catch (err) {
      threw = err;
    }
    expect(threw).toMatchObject({ exitCode: 5 });
    const message = (threw as Error).message;
    expect(message).toMatch(/ambiguous/i);
    expect(message).toContain(a.id);
    expect(message).toContain(b.id);
    expect(message).toContain(a.slug);
    expect(message).toContain(b.slug);
  });

  it("precedence: a real slug that happens to look t--ish still resolves as a slug, not a code lookup", async () => {
    // "t-shirt" is NOT t-<code>-shaped (SHORT_TICKET_CODE_LENGTH is 5, and
    // this slug's suffix is 6 chars plus contains no non-alnum weirdness
    // that would matter either way) — but the point of this test is the
    // PRECEDENCE rule itself: slug lookup runs before code lookup, so even
    // if a slug were exactly code-shaped it must still win. Assert both:
    // the slug resolves correctly, and it is never confused for a code.
    const t = makeTicket({ slug: "t-shirt-feature" });
    await createTicket(paths, t, ctx, createdEvent);
    await expect(resolveTicketRef(paths, "t-shirt-feature")).resolves.toEqual(t);
  });

  it("precedence: an exact-code-shaped slug still resolves as that slug, even though it also matches the t-<code> shape", async () => {
    // A slug that is itself exactly 't-' + 5 lowercase alnum chars — the
    // shape short-code resolution also accepts. Slug wins regardless of
    // whether it happens to be this ticket's own derived code or a
    // completely unrelated string; what matters is that the slug branch
    // (which runs first) intercepts it before code resolution ever runs.
    const t = makeTicket({ slug: "t-abcde" });
    const other = makeTicket({ name: "Some other ticket" });
    await createTicket(paths, t, ctx, createdEvent);
    await createTicket(paths, other, ctx, createdEvent);

    const resolved = await resolveTicketRef(paths, "t-abcde");
    expect(resolved.id).toBe(t.id);
  });
});

describe("resolveTicketRef — external refs are not resolvable (D1)", () => {
  it("a jira: ref throws a distinct, clearly-worded USAGE_ERROR (exit 2), not NOT_FOUND", async () => {
    let threw: unknown;
    try {
      await resolveTicketRef(paths, "jira:PROJ-123");
    } catch (err) {
      threw = err;
    }
    expect(threw).toMatchObject({ exitCode: 2 });
    expect((threw as Error).message).toMatch(/external ref/i);
    expect((threw as Error).message).toMatch(/--parent/);
  });
});

describe("resolveTicketRef — auto-heals the index (exercises the A3 self-heal path via an ordinary read)", () => {
  it("resolves correctly even when index.jsonc has never been written", async () => {
    const t = makeTicket();
    await createTicket(paths, t, ctx, createdEvent);
    // paths.indexFile deliberately never created — a fresh clone, or a
    // repo where reindex has never run.
    await expect(resolveTicketRef(paths, t.slug)).resolves.toEqual(t);
  });
});

// CI-was-red root cause: `buildNewTicket` resolved each `--blocks`/`--relates-to`
// ref with its own `resolveTicketRef`, and every one of those re-ran the index
// fingerprint scan + parse — O(refs x tickets). `resolveTicketRefs` shares one
// load across the batch. These assert the batched form stays behaviourally
// identical to the loop it replaced, since a faster resolver that resolves
// differently would be worse than the slow one.
describe("resolveTicketRefs (batched — one index load for many refs)", () => {
  it("resolves a mix of slug, full id and short prefix identically to the one-at-a-time form", async () => {
    // Explicit, deliberately-divergent ids: `newTicketId()` is monotonic, so
    // ids minted in one millisecond share almost their whole prefix (see
    // docs/benchmarks.md) — a naive `id.slice(0, 20)` here is genuinely
    // ambiguous, which is correct behaviour but not what this test is about.
    const alpha = makeTicket({
      id: "ticket_01AAAAAAAAAAAAAAAAAAAAAAAA" as TicketId,
      slug: "alpha",
    });
    const beta = makeTicket({ id: "ticket_01BBBBBBBBBBBBBBBBBBBBBBBB" as TicketId, slug: "beta" });
    const gamma = makeTicket({
      id: "ticket_01CCCCCCCCCCCCCCCCCCCCCCCC" as TicketId,
      slug: "gamma",
    });
    for (const t of [alpha, beta, gamma]) await createTicket(paths, t, ctx, createdEvent);

    const refs = ["alpha", beta.id, "ticket_01C"];
    const batched = await resolveTicketRefs(paths, refs);

    const oneByOne: Ticket[] = [];
    for (const r of refs) oneByOne.push(await resolveTicketRef(paths, r));

    expect(batched.map((t) => t.id)).toEqual(oneByOne.map((t) => t.id));
    expect(batched.map((t) => t.id)).toEqual([alpha.id, beta.id, gamma.id]);
  });

  it("preserves order, including duplicate refs (dedup is the caller's job, not this function's)", async () => {
    const a = makeTicket({ slug: "dup-a" });
    const b = makeTicket({ slug: "dup-b" });
    for (const t of [a, b]) await createTicket(paths, t, ctx, createdEvent);

    const resolved = await resolveTicketRefs(paths, ["dup-b", "dup-a", "dup-b"]);
    expect(resolved.map((t) => t.id)).toEqual([b.id, a.id, b.id]);
  });

  it("throws on the first unresolvable ref, exactly as the loop did (NOT_FOUND, exit 4)", async () => {
    const a = makeTicket({ slug: "present" });
    await createTicket(paths, a, ctx, createdEvent);
    await expect(resolveTicketRefs(paths, ["present", "no-such-ticket"])).rejects.toMatchObject({
      exitCode: 4,
    });
  });

  it("an ambiguous ref still reports AMBIGUOUS_REF (exit 5) from inside a batch", async () => {
    // Two ids sharing the "ticket_01D" prefix — the batch path must surface
    // ambiguity exactly like the single-ref path, not quietly pick one.
    const one = makeTicket({
      id: "ticket_01DAAAAAAAAAAAAAAAAAAAAAAA" as TicketId,
      slug: "amb-one",
    });
    const two = makeTicket({
      id: "ticket_01DBBBBBBBBBBBBBBBBBBBBBBB" as TicketId,
      slug: "amb-two",
    });
    await createTicket(paths, one, ctx, createdEvent);
    await createTicket(paths, two, ctx, createdEvent);
    await expect(resolveTicketRefs(paths, ["ticket_01D"])).rejects.toMatchObject({
      exitCode: 5,
    });
  });

  it("returns [] for an empty ref list", async () => {
    expect(await resolveTicketRefs(paths, [])).toEqual([]);
  });
});
