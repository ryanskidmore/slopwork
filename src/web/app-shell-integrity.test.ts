import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EventIntegrityBanner } from "./frontend/components/integrity-banner.js";

describe("EventIntegrityBanner", () => {
  it("renders an alert that says derived activity may be incomplete", () => {
    const html = renderToStaticMarkup(
      createElement(EventIntegrityBanner, {
        problems: [
          {
            kind: "read_error",
            id: "event_01KZ0000000000000000000000",
            path: "/repo/.slop/db/events/bad.jsonc",
            message: "invalid JSONC",
          },
        ],
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Audit integrity warning:");
    expect(html).toContain("Activity and awaiting-input state may be incomplete.");
  });

  it("renders nothing for a clean event read", () => {
    expect(renderToStaticMarkup(createElement(EventIntegrityBanner, { problems: [] }))).toBe("");
  });
});
