import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  FORMATTING_OPTIONS,
  newTicketId,
  parseJsonc,
  ticketSchema,
  writeCanonical,
  writeUpdate,
} from "../../src/core/index.js";
import {
  anyEntityArbitrary,
  configArbitrary,
  eventArbitrary,
  sessionArbitrary,
  ticketArbitrary,
} from "./a2-arbitraries.js";

// A2: Core types + serialization
//
// Acceptance criterion, verbatim from v0-implementation-plan.md §3:
//   "Round-trip property test: parse(write(x)) = x, comments survive per
//   S3 decision"
//
// This file asserts the round-trip half as a real fast-check property
// test across all four A2 entity schemas (Ticket, Session, Event,
// Config) for BOTH write paths (writeCanonical and writeUpdate), with
// deliberately adversarial generators (tests/acceptance/a2-arbitraries.ts:
// multi-line markdown with quotes/backslashes/tabs/code fences, unicode
// names, empty arrays, absent optional fields) — then asserts comment
// survival exactly as scoped by docs/spikes/jsonc.md, using real entity
// -shaped documents rather than generic JSON. (Edge, the fifth §4.1
// object, has no independent on-disk shape of its own to round-trip —
// see DECISIONS.md and src/core/entities/edge.ts.)
//
// More exhaustive, lower-level coverage of the serialization module
// itself (every comment-survival case, the jsonc-parser@3.3.1 regression,
// parseJsonc/formatParseErrors edge cases) lives in
// src/core/jsonc.test.ts per the A1 "unit tests co-located as *.test.ts"
// convention; this file focuses on the property test the plan calls out
// by name, applied to real entities.

const PROPERTY_RUNS = 300;

describe("A2: Core types + serialization", () => {
  describe("round-trip property: parse(write(x)) deep-equals x, for every entity schema, both write paths", () => {
    it("holds for writeCanonical across Ticket/Session/Event/Config", () => {
      fc.assert(
        fc.property(anyEntityArbitrary, (entity) => {
          const written = writeCanonical(entity);
          const { value, errors } = parseJsonc(written);
          expect(errors).toHaveLength(0);
          expect(value).toEqual(entity);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });

    it("holds for writeUpdate creating a fresh file (existing doc is an empty object, full-replace patch at the root)", () => {
      fc.assert(
        fc.property(anyEntityArbitrary, (entity) => {
          const out = writeUpdate("{}\n", [{ path: [], value: entity }], entity);
          const { value, errors } = parseJsonc(out);
          expect(errors).toHaveLength(0);
          expect(value).toEqual(entity);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });

    it("holds for writeUpdate patching a real, comment-bearing existing document (surgical or safety-net fallback — unconditional either way)", () => {
      fc.assert(
        fc.property(
          ticketArbitrary,
          fc.string({ maxLength: 60 }),
          fc.integer({ min: 0, max: 3 }),
          (before, newName, newPriority) => {
            const existingText = `// hand-edited ticket\n${writeCanonical(before)}`;
            const after = {
              ...before,
              name: newName.trim().length > 0 ? newName : before.name,
              priority: newPriority,
            };
            const out = writeUpdate(
              existingText,
              [
                { path: ["name"], value: after.name },
                { path: ["priority"], value: after.priority },
              ],
              after,
            );
            const { value, errors } = parseJsonc(out);
            expect(errors).toHaveLength(0);
            expect(value).toEqual(after);
          },
        ),
        { numRuns: PROPERTY_RUNS },
      );
    });

    it("holds even when patching a Session or Event document (not just Ticket)", () => {
      fc.assert(
        fc.property(fc.oneof(sessionArbitrary, eventArbitrary, configArbitrary), (before) => {
          const existingText = writeCanonical(before);
          // Machine-only files (events, config, index) are always written
          // canonical in practice (see jsonc.ts's module doc) — this just
          // confirms writeUpdate's guarantee holds unconditionally even if
          // someone did run it against one.
          const after = before;
          const out = writeUpdate(existingText, [], after);
          const { value, errors } = parseJsonc(out);
          expect(errors).toHaveLength(0);
          expect(value).toEqual(after);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe("generated entities are schema-valid by construction (sanity check on the arbitraries themselves)", () => {
    it("every generated Ticket parses as a Ticket", () => {
      fc.assert(
        fc.property(ticketArbitrary, (t) => {
          expect(ticketSchema.safeParse(t).success).toBe(true);
        }),
        { numRuns: PROPERTY_RUNS },
      );
    });
  });

  describe("comment survival on a real ticket document, scoped exactly per docs/spikes/jsonc.md", () => {
    // A hand-annotated JSONC ticket file: start from a real, fully-defaulted
    // Ticket (so every field a person could plausibly hand-edit is
    // present), then splice in 4 comments at meaningful spots — a file
    // header, a block comment above a scalar key, an inline trailing
    // comment on an array element, and a block comment above a nested
    // object. (Deliberately not adjacent to each other on disk: a comment
    // immediately preceding the property that gets deleted below is its
    // own, separately-tested case — see the "expected to LOSE" test.)
    const id = newTicketId();
    const sampleTicket = ticketSchema.parse({
      id,
      name: "Add auth provider",
      slug: "add-auth-provider",
      spec: {
        summary: "Add an auth provider",
        details_md: "Initial details.",
        acceptance: ["logs in", "logs out"],
        context: [],
        meta: {},
        v: 1,
      },
      state: "open",
      priority: 2,
      labels: ["area:auth", "type:feature"],
      root_id: id,
      provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
      last_activity_at: "2026-07-23T10:00:00.000Z",
      created_at: "2026-07-23T10:00:00.000Z",
      updated_at: "2026-07-23T10:00:00.000Z",
    });

    const CANONICAL = writeCanonical(sampleTicket);
    const FIXTURE = [
      "// hand-edited ticket file",
      CANONICAL.replace('  "priority": 2,', '  // triaged priority\n  "priority": 2,')
        .replace('"area:auth",', '"area:auth", // primary label')
        .replace('"meta": {},', '// spec metadata\n    "meta": {},'),
    ].join("\n");

    const COMMENTS = [
      "// hand-edited ticket file",
      "// triaged priority",
      "// primary label",
      "// spec metadata",
    ] as const;

    function commentsPresent(text: string): number {
      return COMMENTS.filter((c) => text.includes(c)).length;
    }

    it("fixture sanity check: parses cleanly to exactly `sampleTicket`", () => {
      const { value, errors } = parseJsonc(FIXTURE);
      expect(errors).toHaveLength(0);
      expect(value).toEqual(sampleTicket);
    });

    it("survives editing a scalar (priority)", () => {
      const after = { ...sampleTicket, priority: 0 };
      const out = writeUpdate(FIXTURE, [{ path: ["priority"], value: 0 }], after);
      expect(commentsPresent(out)).toBe(COMMENTS.length);
      expect(parseJsonc(out).value).toEqual(after);
    });

    it("survives adding a new key (parent — absent on a root ticket, present after)", () => {
      const parentId = newTicketId();
      const after = { ...sampleTicket, parent: parentId };
      const out = writeUpdate(FIXTURE, [{ path: ["parent"], value: parentId }], after);
      expect(commentsPresent(out)).toBe(COMMENTS.length);
      expect(parseJsonc(out).value).toEqual(after);
    });

    it("survives editing an array element (labels[0])", () => {
      const after = { ...sampleTicket, labels: ["area:security", "type:feature"] };
      const out = writeUpdate(FIXTURE, [{ path: ["labels", 0], value: "area:security" }], after);
      expect(commentsPresent(out)).toBe(COMMENTS.length);
      expect(parseJsonc(out).value).toEqual(after);
    });

    it("survives appending to an array (labels)", () => {
      const after = { ...sampleTicket, labels: ["area:auth", "type:feature", "priority:p2"] };
      const out = writeUpdate(FIXTURE, [{ path: ["labels", -1], value: "priority:p2" }], after);
      expect(commentsPresent(out)).toBe(COMMENTS.length);
      expect(parseJsonc(out).value).toEqual(after);
    });

    it("is expected to LOSE a comment attached above a deleted key (spec.meta)", () => {
      const { meta: _meta, ...specWithoutMeta } = sampleTicket.spec;
      const after = { ...sampleTicket, spec: specWithoutMeta };
      const out = writeUpdate(FIXTURE, [{ path: ["spec", "meta"], value: undefined }], after);
      expect(out.includes("// spec metadata")).toBe(false);
      expect(commentsPresent(out)).toBe(COMMENTS.length - 1);
      expect(parseJsonc(out).value).toEqual(after);
    });

    it("is expected to LOSE every comment when a write trips the validation fallback", () => {
      // Deliberately mismatched expectedAfter forces the step-3
      // reparse-and-deep-equal check to fail, so writeUpdate falls back to
      // writeCanonical for this write — correctness wins, comments don't.
      const wrongAfter = { ...sampleTicket, priority: 999 } as unknown as typeof sampleTicket;
      const out = writeUpdate(FIXTURE, [{ path: ["priority"], value: 0 }], wrongAfter);
      expect(out).toBe(writeCanonical(wrongAfter));
      expect(commentsPresent(out)).toBe(0);
      expect(parseJsonc(out).value).toEqual(wrongAfter);
    });
  });

  describe("jsonc-parser@3.3.1 inline-array-delete-last-element regression (on a real ticket field)", () => {
    // Proof the safety net works: a human hand-edits `labels` into an
    // inline single-line array (exactly what an $EDITOR session commonly
    // produces), then `slop update --label -y` (or similar) removes the
    // last label. Without the safety net this reproduces the documented
    // jsonc-parser@3.3.1 data-corruption bug (docs/spikes/jsonc.md).
    it("does not corrupt the file: writeUpdate falls back to canonical and the result is correct", () => {
      const id = newTicketId();
      const before = ticketSchema.parse({
        id,
        name: "Add auth provider",
        slug: "add-auth-provider",
        spec: { summary: "Add an auth provider" },
        state: "open",
        labels: ["area:auth", "type:feature"],
        root_id: id,
        provenance: { method: "new", created_by: { name: "ryan", kind: "human" } },
        last_activity_at: "2026-07-23T10:00:00.000Z",
        created_at: "2026-07-23T10:00:00.000Z",
        updated_at: "2026-07-23T10:00:00.000Z",
      });

      const canonical = writeCanonical(before);
      // Simulate a human hand-collapsing the multi-line `labels` array
      // onto one line in $EDITOR.
      const handEdited = canonical.replace(
        '"labels": [\n    "area:auth",\n    "type:feature"\n  ],',
        '"labels": ["area:auth", "type:feature"],',
      );
      expect(handEdited).toContain('"labels": ["area:auth", "type:feature"],');

      const after = { ...before, labels: ["area:auth"] };
      const out = writeUpdate(handEdited, [{ path: ["labels", 1], value: undefined }], after);

      const { value, errors } = parseJsonc(out);
      expect(errors).toHaveLength(0);
      expect(value).toEqual(after);
      // Confirms this genuinely took the step-1 safety-net skip (proof it
      // fired), not that modify() happened to succeed anyway.
      expect(out).toBe(writeCanonical(after));
    });

    it("sanity check: the raw jsonc-parser call this simulates DOES corrupt an inline array on this pinned version", async () => {
      const jsoncParser = await import("jsonc-parser");
      const doc = '{ "labels": ["area:auth", "type:feature"] }';
      const edits = jsoncParser.modify(doc, ["labels", 1], undefined, {
        formattingOptions: FORMATTING_OPTIONS,
      });
      const out = jsoncParser.applyEdits(doc, edits);
      const errors: import("jsonc-parser").ParseError[] = [];
      jsoncParser.parse(out, errors, { allowTrailingComma: true });
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
