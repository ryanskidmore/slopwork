import { describe, expect, it } from "vitest";
import {
  type TranscriptLinesSource,
  getTranscriptPage,
  parseTranscriptLine,
  toolResultText,
} from "./transcript.js";

/** An in-memory TranscriptLinesSource that counts how many lines it was asked to yield, so tests can assert the streaming reader actually stops early. */
function sourceFromRecords(records: unknown[]): TranscriptLinesSource & { linesYielded: number } {
  const source = {
    linesYielded: 0,
    async *lines(): AsyncGenerator<string> {
      for (const record of records) {
        source.linesYielded++;
        yield JSON.stringify(record);
      }
    },
  };
  return source;
}

describe("parseTranscriptLine", () => {
  it("parses a well-formed record", () => {
    expect(parseTranscriptLine('{"type":"user"}')).toEqual({ type: "user" });
  });

  it("returns null for blank lines", () => {
    expect(parseTranscriptLine("")).toBeNull();
    expect(parseTranscriptLine("   ")).toBeNull();
  });

  it("returns null for malformed JSON without throwing", () => {
    expect(parseTranscriptLine("{not json")).toBeNull();
  });

  it("returns null for valid JSON that isn't a typed record", () => {
    expect(parseTranscriptLine("42")).toBeNull();
    expect(parseTranscriptLine('{"no_type": true}')).toBeNull();
  });
});

describe("getTranscriptPage", () => {
  const records = [
    { type: "user", message: { role: "user", content: "hi" } },
    { type: "system", subtype: "compact" },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    },
    { type: "last-prompt" },
    { type: "user", message: { role: "user", content: "again" } },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "again reply" }] },
    },
  ];

  it("filters to user/assistant by default, excluding system and always-hidden types", () => {
    const source = sourceFromRecords(records);
    const page = getTranscriptPage(source, { offset: 0, limit: 10, includeSystem: false });
    return page.then((p) => {
      expect(p.records.map((r) => r.type)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(p.hasMore).toBe(false);
    });
  });

  it("includes system records when includeSystem is set", async () => {
    const source = sourceFromRecords(records);
    const page = await getTranscriptPage(source, { offset: 0, limit: 10, includeSystem: true });
    expect(page.records.map((r) => r.type)).toEqual([
      "user",
      "system",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("paginates with offset/limit and reports hasMore", async () => {
    const source = sourceFromRecords(records);
    const page = await getTranscriptPage(source, { offset: 0, limit: 2, includeSystem: false });
    expect(page.records.map((r) => r.type)).toEqual(["user", "assistant"]);
    expect(page.hasMore).toBe(true);

    const source2 = sourceFromRecords(records);
    const page2 = await getTranscriptPage(source2, { offset: 2, limit: 2, includeSystem: false });
    expect(page2.records.map((r) => r.type)).toEqual(["user", "assistant"]);
    expect(page2.hasMore).toBe(false);
  });

  it("stops reading the underlying source once the page + lookahead is satisfied (streaming, not a full-file load)", async () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({
      type: i % 2 === 0 ? "user" : "assistant",
      message: { role: i % 2 === 0 ? "user" : "assistant", content: `msg ${i}` },
    }));
    const source = sourceFromRecords(many);
    const page = await getTranscriptPage(source, { offset: 0, limit: 5, includeSystem: false });
    expect(page.records).toHaveLength(5);
    expect(page.hasMore).toBe(true);
    // Bounded by offset+limit+1, nowhere near the full 10,000-record file.
    expect(source.linesYielded).toBeLessThan(10);
  });
});

describe("toolResultText", () => {
  it("passes through a plain string", () => {
    expect(toolResultText("plain")).toBe("plain");
  });

  it("joins text sub-blocks from an array", () => {
    expect(
      toolResultText([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });

  it("falls back to JSON for non-text content", () => {
    expect(toolResultText({ weird: 1 })).toContain('"weird"');
  });
});
