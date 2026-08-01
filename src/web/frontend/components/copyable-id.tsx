/**
 * Identifiers deserve real monospace and click-to-copy (design direction:
 * "ULIDs, `t-<code>` handles, slugs, git SHAs, and JSONC are everywhere...
 * make ids copyable-on-click. This is functional, not decorative.") — used
 * for ticket ids/handles, session ids, git commit SHAs.
 */
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils.js";

export function CopyableId({
  value,
  display,
  className,
  title,
}: {
  value: string;
  display?: string;
  className?: string;
  title?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard API unavailable (insecure context, permissions) — silently no-op, still selectable text.
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={title ?? `Click to copy: ${value}`}
      className={cn(
        "group inline-flex items-center gap-1 rounded-sm font-mono text-xs text-muted-foreground",
        "outline-none transition-colors hover:text-foreground focus-visible:text-foreground",
        className,
      )}
    >
      <span className="truncate">{display ?? value}</span>
      {copied ? (
        <Check className="size-3 shrink-0 text-state-done" aria-hidden="true" />
      ) : (
        <Copy
          className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-70 group-focus-visible:opacity-70"
          aria-hidden="true"
        />
      )}
      <span className="sr-only">{copied ? "Copied" : "Copy to clipboard"}</span>
    </button>
  );
}
