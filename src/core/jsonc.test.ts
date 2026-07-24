import { describe, expect, it } from "vitest";
import {
  FORMATTING_OPTIONS,
  formatParseErrors,
  parseJsonc,
  writeCanonical,
  writeUpdate,
} from "./jsonc.js";

// Fixture modeled on the S3 spike's own 7-comment hand-authored ticket
// fixture (docs/spikes/jsonc.md, "Load-bearing empirical findings"): file
// header, a block comment above a key, an inline `/* */`, a comment on an
// empty-array line, a comment attached to an array element, a comment
// above a nested object, and a trailing inline `//` on an array element.
const FIXTURE = `// file header comment
{
  "id": "ticket_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "name": "Add auth provider",
  // block comment above priority
  "priority": 2,
  "spec": {
    "summary": "test" /* inline block comment */,
    "details_md": "details",
    "acceptance": [], // comment on empty array line
    "context": [
      "ctx one", // comment attached to array element
      "ctx two"
    ],
    // comment above nested object
    "meta": {}
  },
  "labels": [
    "area:auth",
    "type:feature" // second label
  ]
}
`;

const FIXTURE_COMMENTS = [
  "// file header comment",
  "// block comment above priority",
  "/* inline block comment */",
  "// comment on empty array line",
  "// comment attached to array element",
  "// comment above nested object",
  "// second label",
] as const;

/** The FIXTURE's shape. Has an index signature (not `any`) since some tests add a brand new key (e.g. "owner") that isn't part of the fixture's original fields. */
interface FixtureDoc {
  id: string;
  name: string;
  priority: number;
  spec: {
    summary: string;
    details_md: string;
    acceptance: string[];
    context: string[];
    // Optional (not just present-but-typed-Record) so the "delete a key
    // with an attached comment" test below can `delete after.spec.meta`
    // — TS requires an operand of `delete` to be an optional property.
    meta?: Record<string, unknown>;
  };
  labels: string[];
  [extraKey: string]: unknown;
}

function baseline(): FixtureDoc {
  const { value, errors } = parseJsonc<FixtureDoc>(FIXTURE);
  expect(errors).toHaveLength(0);
  return structuredClone(value);
}

function countPresentComments(text: string): number {
  return FIXTURE_COMMENTS.filter((c) => text.includes(c)).length;
}

describe("parseJsonc", () => {
  it("never throws and tolerates comments plus trailing commas", () => {
    const { value, errors } = parseJsonc<{ a: number; b: number[] }>(
      '{ "a": 1, /* c */ "b": [1,2,3,], }',
    );
    expect(errors).toHaveLength(0);
    expect(value).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it("reports errors (but still returns a best-effort value) for malformed input", () => {
    const { errors } = parseJsonc('{ "a": 1 "b": 2 }');
    expect(errors.length).toBeGreaterThan(0);
  });

  it("treats empty content as an error (a .slop/db file should never legitimately be empty)", () => {
    const { errors } = parseJsonc("");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("round-trips the comment fixture with zero errors", () => {
    const { errors } = parseJsonc(FIXTURE);
    expect(errors).toHaveLength(0);
  });
});

describe("formatParseErrors", () => {
  it("produces path:line:col: message lines", () => {
    const text = '{\n  "a": 1,\n  "b": ,\n}';
    const { errors } = parseJsonc(text);
    const lines = formatParseErrors("tickets/ticket_x.jsonc", text, errors);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/^tickets\/ticket_x\.jsonc:\d+:\d+: \S+/);
    }
    // Concretely: the stray comma sits on line 3, column 8.
    expect(lines[0]).toBe("tickets/ticket_x.jsonc:3:8: ValueExpected");
  });

  it("returns an empty array for a clean document", () => {
    expect(formatParseErrors("f.jsonc", "{}", [])).toEqual([]);
  });
});

describe("writeCanonical", () => {
  it("is JSON.stringify(value, null, 2) with a trailing newline", () => {
    const value = { b: 2, a: 1 };
    expect(writeCanonical(value)).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });

  it("round-trips through parseJsonc with zero errors", () => {
    const value = { name: "x", nested: { arr: [1, 2, 3] } };
    const { value: reparsed, errors } = parseJsonc(writeCanonical(value));
    expect(errors).toHaveLength(0);
    expect(reparsed).toEqual(value);
  });

  it("is idempotent / deterministic", () => {
    const value = { z: 1, a: [1, 2, { k: "v" }] };
    expect(writeCanonical(value)).toBe(writeCanonical(value));
  });
});

describe("writeUpdate — comment survival (scoped exactly per docs/spikes/jsonc.md)", () => {
  it("survives editing an existing scalar, nested deep inside the document", () => {
    const after = baseline();
    after.spec.summary = "updated summary";
    const out = writeUpdate(
      FIXTURE,
      [{ path: ["spec", "summary"], value: "updated summary" }],
      after,
    );
    expect(countPresentComments(out)).toBe(FIXTURE_COMMENTS.length);
    expect(parseJsonc(out).value).toEqual(after);
  });

  it("survives adding a new top-level key", () => {
    const after = baseline();
    after.owner = "sam";
    const out = writeUpdate(FIXTURE, [{ path: ["owner"], value: "sam" }], after);
    expect(countPresentComments(out)).toBe(FIXTURE_COMMENTS.length);
    expect(parseJsonc(out).value).toEqual(after);
  });

  it("survives adding a key inside a nested, currently-empty object", () => {
    const after = baseline();
    expect(after.spec.meta).toBeDefined();
    (after.spec.meta as Record<string, unknown>).estimate_pts = 3;
    const out = writeUpdate(FIXTURE, [{ path: ["spec", "meta", "estimate_pts"], value: 3 }], after);
    expect(countPresentComments(out)).toBe(FIXTURE_COMMENTS.length);
    expect(parseJsonc(out).value).toEqual(after);
  });

  it("survives editing an array element in place", () => {
    const after = baseline();
    after.spec.context[0] = "ctx one updated";
    const out = writeUpdate(
      FIXTURE,
      [{ path: ["spec", "context", 0], value: "ctx one updated" }],
      after,
    );
    expect(countPresentComments(out)).toBe(FIXTURE_COMMENTS.length);
    expect(parseJsonc(out).value).toEqual(after);
  });

  it("survives appending to an array (comment presence, not exact attachment)", () => {
    const after = baseline();
    after.labels.push("priority:p2");
    const out = writeUpdate(FIXTURE, [{ path: ["labels", -1], value: "priority:p2" }], after);
    // Per the spike: the trailing comment on the previous last element may
    // visually migrate to trail the new element instead — assert it's
    // still present *somewhere*, not that it stayed attached to "type:feature".
    expect(countPresentComments(out)).toBe(FIXTURE_COMMENTS.length);
    expect(parseJsonc(out).value).toEqual(after);
  });

  it("round-trips a multi-line markdown edit exactly, comments intact", () => {
    const md = [
      "Paragraph one.",
      "Quotes: \"double\" and 'single'.",
      "Backslashes: \\ and \\\\ and a literal \\n.",
      "Tab:\tindented.",
      "```ts",
      'const x = "fenced code block";',
      "```",
    ].join("\n");
    const after = baseline();
    after.spec.details_md = md;
    const out = writeUpdate(FIXTURE, [{ path: ["spec", "details_md"], value: md }], after);
    const { value: reparsed, errors } = parseJsonc<FixtureDoc>(out);
    expect(errors).toHaveLength(0);
    expect(reparsed.spec.details_md).toBe(md);
    expect(countPresentComments(out)).toBe(FIXTURE_COMMENTS.length);
  });

  it("applies multiple patch entries in one call, all comments intact", () => {
    const after = baseline();
    after.priority = 0;
    after.name = "Add auth provider (renamed)";
    const out = writeUpdate(
      FIXTURE,
      [
        { path: ["priority"], value: 0 },
        { path: ["name"], value: "Add auth provider (renamed)" },
      ],
      after,
    );
    expect(countPresentComments(out)).toBe(FIXTURE_COMMENTS.length);
    expect(parseJsonc(out).value).toEqual(after);
  });
});

describe("writeUpdate — comments expected to be lost (scoped exactly per docs/spikes/jsonc.md)", () => {
  it("loses a comment that was attached above a deleted key (destroyed with it)", () => {
    const after = baseline();
    delete after.spec.meta;
    const out = writeUpdate(FIXTURE, [{ path: ["spec", "meta"], value: undefined }], after);
    expect(out.includes("// comment above nested object")).toBe(false);
    // Every other comment is unaffected.
    expect(countPresentComments(out)).toBe(FIXTURE_COMMENTS.length - 1);
    // Still correct, just not comment-preserving for that one comment.
    expect(parseJsonc(out).value).toEqual(after);
  });

  it("loses a comment trailing a deleted (non-last) array element", () => {
    const after = baseline();
    after.spec.context = ["ctx two"];
    const out = writeUpdate(FIXTURE, [{ path: ["spec", "context", 0], value: undefined }], after);
    expect(out.includes("// comment attached to array element")).toBe(false);
    expect(countPresentComments(out)).toBe(FIXTURE_COMMENTS.length - 1);
    expect(parseJsonc(out).value).toEqual(after);
  });

  it("loses every comment when a write trips the validation fallback", () => {
    // Deliberately lie about `expectedAfter` relative to what the patch
    // would really produce, forcing step 3's deep-equal check to fail so
    // the safety net falls back to canonical for this write.
    const doc = '{ "a": 1, "b": 2 } // trailing comment';
    const wrongExpected = { a: 1, b: 999 };
    const out = writeUpdate(doc, [{ path: ["a"], value: 5 }], wrongExpected);
    expect(out).toBe(writeCanonical(wrongExpected));
    expect(out.includes("// trailing comment")).toBe(false);
    expect(parseJsonc(out).value).toEqual(wrongExpected);
  });
});

describe("writeUpdate — round-trip correctness holds unconditionally", () => {
  it("modify() throwing on a delete through a missing intermediate path still yields a correct file", () => {
    const doc = '{"a":1}';
    const expected = { a: 1 };
    const out = writeUpdate(doc, [{ path: ["b", "c"], value: undefined }], expected);
    const { value, errors } = parseJsonc(out);
    expect(errors).toHaveLength(0);
    expect(value).toEqual(expected);
  });
});

describe("writeUpdate — jsonc-parser@3.3.1 inline-array-delete-last-element regression", () => {
  // docs/spikes/jsonc.md: modify() on an inline `["a","b","c"]` array, removing
  // the last element, corrupts the document in the installed stable
  // version (3.3.1) — `applyEdits` produces malformed JSON that silently
  // reparses into wrong data. This is the exact scenario writeUpdate's
  // step-1 safety net exists to catch before it ever reaches modify().
  it("does not reproduce the bug: output is valid JSON with the correct value", () => {
    const doc = '{ "labels": ["a", "b", "c"] }';
    const expected = { labels: ["a", "b"] };

    const out = writeUpdate(doc, [{ path: ["labels", 2], value: undefined }], expected);

    const { value, errors } = parseJsonc<{ labels: string[] }>(out);
    expect(errors).toHaveLength(0);
    expect(value).toEqual(expected);
    // Confirm this genuinely took the canonical-fallback path (proof the
    // safety net's step-1 skip fired), not that modify() got lucky.
    expect(out).toBe(writeCanonical(expected));
  });

  it("sanity check: applying jsonc-parser's modify()+applyEdits() directly to this exact input DOES corrupt it", async () => {
    // This is not a test of our code — it's the empirical grounding for
    // why the safety net above is necessary at all, pinned so a future
    // jsonc-parser upgrade that fixes the bug is visible (this test would
    // start failing, signalling the step-1 skip is no longer required for
    // correctness, only for its comment-preservation cost).
    const jsoncParser = await import("jsonc-parser");
    const doc = '{ "labels": ["a", "b", "c"] }';
    const edits = jsoncParser.modify(doc, ["labels", 2], undefined, {
      formattingOptions: FORMATTING_OPTIONS,
    });
    const out = jsoncParser.applyEdits(doc, edits);
    const errors: import("jsonc-parser").ParseError[] = [];
    jsoncParser.parse(out, errors, { allowTrailingComma: true });
    expect(errors.length).toBeGreaterThan(0);
  });
});
