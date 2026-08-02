import { AlertTriangle } from "lucide-react";
import { createElement } from "react";
import type { EventReadProblemDTO } from "../../api/types.js";

export function EventIntegrityBanner({ problems }: { problems: readonly EventReadProblemDTO[] }) {
  if (problems.length === 0) return null;
  return createElement(
    "div",
    {
      role: "alert",
      className:
        "flex items-start gap-2 border-b border-destructive/35 bg-destructive/10 px-4 py-2 text-sm text-destructive",
    },
    createElement(AlertTriangle, {
      className: "mt-0.5 size-4 shrink-0",
      "aria-hidden": "true",
    }),
    createElement(
      "span",
      null,
      createElement("strong", { className: "font-semibold" }, "Audit integrity warning:"),
      ` ${problems.length} event file problem(s). Activity and awaiting-input state may be incomplete.`,
    ),
  );
}
