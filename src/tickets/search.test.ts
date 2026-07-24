import { describe, expect, it } from "vitest";
import type { SearchField } from "./search.js";
import {
  buildSnippet,
  compareHits,
  markTerms,
  matchTicketFields,
  rankSearchResults,
  searchTerms,
} from "./search.js";

describe("searchTerms", () => {
  it("lowercases, splits on whitespace, and drops empties/dupes", () => {
    expect(searchTerms("  Auth   Provider  auth ")).toEqual(["auth", "provider"]);
  });

  it("an empty/whitespace-only query yields no terms", () => {
    expect(searchTerms("")).toEqual([]);
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("matchTicketFields — case-insensitivity and multi-word AND-across-fields semantics", () => {
  const fields: SearchField[] = [
    { kind: "name", text: "Add Auth Provider" },
    { kind: "summary", text: "Summary text" },
    { kind: "details_md", text: "Deep inside: this ticket concerns the widget subsystem." },
  ];

  it("matches case-insensitively", () => {
    expect(matchTicketFields(fields, searchTerms("AUTH"))).not.toBeNull();
    expect(matchTicketFields(fields, searchTerms("auth"))).not.toBeNull();
  });

  it("a term present in no field at all returns no match (can't pass by matching everything)", () => {
    expect(matchTicketFields(fields, searchTerms("nonexistentzzz"))).toBeNull();
  });

  it("multi-word query: all terms must appear SOMEWHERE, not as one exact phrase", () => {
    // "auth" is only in `name`; "widget" is only in `details_md`. Neither
    // field alone contains the phrase "auth widget", but both terms are
    // present somewhere in the ticket.
    const result = matchTicketFields(fields, searchTerms("auth widget"));
    expect(result).not.toBeNull();
  });

  it("multi-word query where one term is entirely absent fails the whole ticket", () => {
    const result = matchTicketFields(fields, searchTerms("auth nonexistentzzz"));
    expect(result).toBeNull();
  });

  it("empty fields (blank text) are skipped, never spuriously matched", () => {
    const withBlank: SearchField[] = [{ kind: "details_md", text: "   " }];
    expect(matchTicketFields(withBlank, searchTerms("anything"))).toBeNull();
  });

  it("a zero-term query never matches", () => {
    expect(matchTicketFields(fields, [])).toBeNull();
  });
});

describe("compareHits — the field-weight-then-term-count rule", () => {
  it("a name hit outranks a details_md hit even with fewer matched terms", () => {
    const nameHit = { field: { kind: "name" as const, text: "x" }, matchedTerms: ["a"] };
    const detailsHit = {
      field: { kind: "details_md" as const, text: "y" },
      matchedTerms: ["a", "b"],
    };
    expect(compareHits(nameHit, detailsHit)).toBeLessThan(0);
  });

  it("within the same field, more matched terms outranks fewer", () => {
    const twoTerms = { field: { kind: "summary" as const, text: "x" }, matchedTerms: ["a", "b"] };
    const oneTerm = { field: { kind: "summary" as const, text: "y" }, matchedTerms: ["a"] };
    expect(compareHits(twoTerms, oneTerm)).toBeLessThan(0);
  });

  it("notes rank below details_md, which ranks below summary/name/slug", () => {
    const note = { field: { kind: "note" as const, text: "x" }, matchedTerms: ["a"] };
    const details = { field: { kind: "details_md" as const, text: "x" }, matchedTerms: ["a"] };
    const summary = { field: { kind: "summary" as const, text: "x" }, matchedTerms: ["a"] };
    expect(compareHits(note, details)).toBeGreaterThan(0);
    expect(compareHits(details, summary)).toBeGreaterThan(0);
  });
});

describe("buildSnippet", () => {
  it("marks the matched term and includes surrounding context", () => {
    const field: SearchField = {
      kind: "details_md",
      text: "some leading words here then the widget subsystem needs love and trailing words follow after that",
    };
    const result = matchTicketFields([field], searchTerms("widget"));
    expect(result).not.toBeNull();
    const snippet = buildSnippet(result?.best as NonNullable<typeof result>["best"]);
    expect(snippet).toContain("**widget**");
    expect(snippet).toContain("subsystem");
  });

  it("adds an ellipsis only on the truncated side(s)", () => {
    const shortField: SearchField = { kind: "summary", text: "widget" };
    const shortResult = matchTicketFields([shortField], searchTerms("widget"));
    const shortSnippet = buildSnippet(shortResult?.best as NonNullable<typeof shortResult>["best"]);
    expect(shortSnippet).not.toContain("…");
    expect(shortSnippet).toBe("**widget**");

    const longText = `${"x".repeat(100)} widget ${"y".repeat(100)}`;
    const longField: SearchField = { kind: "details_md", text: longText };
    const longResult = matchTicketFields([longField], searchTerms("widget"));
    const longSnippet = buildSnippet(longResult?.best as NonNullable<typeof longResult>["best"]);
    expect(longSnippet.startsWith("…")).toBe(true);
    expect(longSnippet.endsWith("…")).toBe(true);
    expect(longSnippet).toContain("**widget**");
  });

  it("marks every matched term present in the window, for a multi-word query", () => {
    const field: SearchField = { kind: "summary", text: "the quick brown fox jumps" };
    const result = matchTicketFields([field], searchTerms("quick fox"));
    const snippet = buildSnippet(result?.best as NonNullable<typeof result>["best"]);
    expect(snippet).toContain("**quick**");
    expect(snippet).toContain("**fox**");
  });

  // E1: a term that's already markdown-bold in the source text (common in
  // spec.details_md) used to get marked a SECOND time, producing
  // `****term****` — asterisk soup, not readable bold. It must be left
  // alone (already reads cleanly) rather than double-wrapped.
  it("does not double-mark a term that's already markdown-bold in the source text", () => {
    const field: SearchField = {
      kind: "details_md",
      text: "please see the **widget** subsystem for details on this",
    };
    const result = matchTicketFields([field], searchTerms("widget"));
    const snippet = buildSnippet(result?.best as NonNullable<typeof result>["best"]);
    expect(snippet).toContain("**widget**");
    expect(snippet).not.toContain("****widget****");
    expect(snippet).not.toContain("***widget***");
  });

  it("still marks a plain (not-yet-bold) occurrence of a term that ALSO appears bold elsewhere in the same text", () => {
    const full = markTerms(
      "already **widget** noted once, and mentioned again as widget later on",
      ["widget"],
    );
    expect(full).not.toContain("****widget****");
    // Both occurrences read as exactly one bold marker each: the
    // already-bold one is left alone, the plain one is newly marked.
    expect(full.match(/\*\*widget\*\*/g)?.length).toBe(2);
  });
});

describe("rankSearchResults", () => {
  function ranked(id: string, lastActivityAt: string, hit: { kind: SearchField["kind"] }) {
    const field: SearchField = { kind: hit.kind, text: "widget" };
    const result = matchTicketFields([field], searchTerms("widget"));
    if (!result) throw new Error("test setup: expected a match");
    return { ticket: { id, last_activity_at: lastActivityAt }, result };
  }

  it("a name match sorts above a details_md-only match", () => {
    const nameMatch = ranked("ticket_b", "2026-01-01T00:00:00.000Z", { kind: "name" });
    const detailsMatch = ranked("ticket_a", "2026-06-01T00:00:00.000Z", { kind: "details_md" });
    // detailsMatch has the later last_activity_at, so this also proves
    // field weight wins over recency, not just id order.
    const order = rankSearchResults([detailsMatch, nameMatch]);
    expect(order.map((r) => r.ticket.id)).toEqual(["ticket_b", "ticket_a"]);
  });

  it("within the same field weight, more recent last_activity_at sorts first", () => {
    const older = ranked("ticket_old", "2026-01-01T00:00:00.000Z", { kind: "summary" });
    const newer = ranked("ticket_new", "2026-06-01T00:00:00.000Z", { kind: "summary" });
    const order = rankSearchResults([older, newer]);
    expect(order.map((r) => r.ticket.id)).toEqual(["ticket_new", "ticket_old"]);
  });

  it("is a pure sort (does not mutate the input array)", () => {
    const a = ranked("ticket_a", "2026-01-01T00:00:00.000Z", { kind: "name" });
    const b = ranked("ticket_b", "2026-01-01T00:00:00.000Z", { kind: "note" });
    const input = [b, a];
    const output = rankSearchResults(input);
    expect(input).toEqual([b, a]); // unchanged
    expect(output.map((r) => r.ticket.id)).toEqual(["ticket_a", "ticket_b"]);
  });
});
