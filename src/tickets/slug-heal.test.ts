import { describe, expect, it } from "vitest";
import { newTicketId } from "../core/index.js";
import type { TicketId } from "../core/index.js";
import type { DuplicateSlugProblem } from "../repo/db-index.js";
import { planSlugHeal } from "./slug-heal.js";

/** Real (monotonic) ids, oldest first — mirrors how `buildIndex` sorts a
 * `DuplicateSlugProblem`'s own `ids` ascending before ever calling here. */
function idsInOrder(n: number): TicketId[] {
  const ids: TicketId[] = [];
  for (let i = 0; i < n; i++) ids.push(newTicketId());
  return ids.sort();
}

describe("planSlugHeal", () => {
  it("the oldest id in a group is never planned — only the newer duplicates", () => {
    const [oldest, newer] = idsInOrder(2);
    const problems: DuplicateSlugProblem[] = [
      { slug: "auth-migration", ids: [oldest as TicketId, newer as TicketId] },
    ];
    const plans = planSlugHeal(problems, new Set(["auth-migration"]));
    expect(plans).toHaveLength(1);
    expect(plans[0]?.id).toBe(newer);
    expect(plans[0]?.from).toBe("auth-migration");
    expect(plans[0]?.to).toBe("auth-migration-2");
  });

  it("three-way duplicate gets git-style -2/-3 suffixes in oldest-first order", () => {
    const [a, b, c] = idsInOrder(3);
    const problems: DuplicateSlugProblem[] = [
      { slug: "fix-login", ids: [a as TicketId, b as TicketId, c as TicketId] },
    ];
    const plans = planSlugHeal(problems, new Set(["fix-login"]));
    expect(plans).toEqual([
      { id: b, from: "fix-login", to: "fix-login-2" },
      { id: c, from: "fix-login", to: "fix-login-3" },
    ]);
  });

  it("skips an already-taken suffix (e.g. a real ticket already sitting at slug-2)", () => {
    const [oldest, newer] = idsInOrder(2);
    const problems: DuplicateSlugProblem[] = [
      { slug: "spike", ids: [oldest as TicketId, newer as TicketId] },
    ];
    // "spike-2" is already claimed by some unrelated, non-duplicated ticket.
    const plans = planSlugHeal(problems, new Set(["spike", "spike-2"]));
    expect(plans).toEqual([{ id: newer, from: "spike", to: "spike-3" }]);
  });

  it("two independent duplicated slugs never collide with each other's freshly-assigned suffixes", () => {
    const [a1, a2] = idsInOrder(2);
    const [b1, b2] = idsInOrder(2);
    const problems: DuplicateSlugProblem[] = [
      { slug: "x", ids: [a1 as TicketId, a2 as TicketId] },
      { slug: "x-2", ids: [b1 as TicketId, b2 as TicketId] },
    ];
    // "x-2" is itself a duplicated slug here, so planning "x"'s duplicate
    // must skip straight past it to "x-3" rather than colliding.
    const plans = planSlugHeal(problems, new Set(["x", "x-2"]));
    expect(plans).toEqual([
      { id: a2, from: "x", to: "x-3" },
      { id: b2, from: "x-2", to: "x-2-2" },
    ]);
  });

  it("a group with no duplicates (length 1) plans nothing — defensive, never reached in practice", () => {
    const [only] = idsInOrder(1);
    const problems: DuplicateSlugProblem[] = [{ slug: "solo", ids: [only as TicketId] }];
    expect(planSlugHeal(problems, new Set(["solo"]))).toEqual([]);
  });

  it("no problems at all plans nothing", () => {
    expect(planSlugHeal([], new Set())).toEqual([]);
  });
});
