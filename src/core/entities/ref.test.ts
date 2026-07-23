import { describe, expect, it } from "vitest";
import { newTicketId } from "../ids.js";
import { checkJiraRefFormat, externalRefSchema, parentRefSchema, parseParentRef } from "./ref.js";

describe("externalRefSchema / parentRefSchema", () => {
  it("accepts jira: refs", () => {
    expect(externalRefSchema.safeParse("jira:PROJ-123").success).toBe(true);
  });

  it("accepts other <system>:<key> shapes (not blocked to jira only)", () => {
    expect(externalRefSchema.safeParse("gh:owner/repo#123").success).toBe(true);
  });

  it("rejects a ref with no colon", () => {
    expect(externalRefSchema.safeParse("not-a-ref").success).toBe(false);
  });

  it("parentRefSchema accepts both a local ticket id and an external ref", () => {
    const ticketId = newTicketId();
    expect(parentRefSchema.safeParse(ticketId).success).toBe(true);
    expect(parentRefSchema.safeParse("jira:PROJ-123").success).toBe(true);
    expect(parentRefSchema.safeParse("garbage").success).toBe(false);
  });
});

describe("parseParentRef", () => {
  it("parses a local ticket id", () => {
    const ticketId = newTicketId();
    const parsed = parseParentRef(ticketId);
    expect(parsed.kind).toBe("local");
    expect(parsed.kind === "local" && parsed.ticketId).toBe(ticketId);
  });

  it("parses an external ref into system + key", () => {
    const parsed = parseParentRef("jira:PROJ-123");
    expect(parsed).toEqual({
      kind: "external",
      raw: "jira:PROJ-123",
      system: "jira",
      key: "PROJ-123",
    });
  });

  it("throws on something that's neither a local id nor <system>:<key>", () => {
    expect(() => parseParentRef("not-a-ref-at-all")).toThrow();
  });
});

describe("checkJiraRefFormat (design.md §8.2 item 5: warn, never block)", () => {
  it("is ok for a well-formed jira ref", () => {
    expect(checkJiraRefFormat("jira:PROJ-123")).toEqual({ ok: true });
  });

  it("is ok (not applicable) for a local ticket id", () => {
    expect(checkJiraRefFormat(newTicketId())).toEqual({ ok: true });
  });

  it("is ok (not applicable) for a non-jira external system", () => {
    expect(checkJiraRefFormat("gh:owner/repo#123")).toEqual({ ok: true });
  });

  it("warns but does not fail (ok: false with a warning message) for a malformed jira key", () => {
    const result = checkJiraRefFormat("jira:notaproperkey");
    expect(result.ok).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("jira:notaproperkey");
  });

  it("never throws for any structurally valid ref, however weird the key", () => {
    expect(() => checkJiraRefFormat("jira:")).not.toThrow();
  });
});
