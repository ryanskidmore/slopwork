import {
  GitBranch,
  GitPullRequestArrow,
  HelpCircle,
  ListTree,
  Search,
  TimerReset,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import type { ConfigDTO } from "../../api/types.js";
import { useApiQuery } from "../hooks/use-api-query.js";
import { fetchConfig } from "../lib/api.js";
import { CommandPalette, useCommandPaletteShortcut } from "./command-palette.js";
import { ThemeToggle } from "./theme-toggle.js";
import { Button } from "./ui/button.js";

const NAV_ITEMS = [
  { to: "/tickets", label: "Tickets", icon: ListTree },
  { to: "/tree", label: "Tree", icon: GitBranch },
  { to: "/review", label: "Review", icon: GitPullRequestArrow },
  { to: "/questions", label: "Questions", icon: HelpCircle },
  { to: "/stale", label: "Stale", icon: TimerReset },
];

function navClass(isActive: boolean): string {
  return (
    "flex h-9 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors " +
    "sm:inline-flex sm:h-auto sm:px-2.5 sm:py-1.5 " +
    (isActive
      ? "bg-secondary text-secondary-foreground"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground")
  );
}

function loadConfig(signal: AbortSignal): Promise<ConfigDTO> {
  return fetchConfig({ signal });
}

export function AppShell() {
  const {
    data: config,
    error: configError,
    retry: retryConfig,
  } = useApiQuery<ConfigDTO>(loadConfig);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useCommandPaletteShortcut(setPaletteOpen);

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/75">
        <div className="mx-auto grid max-w-7xl grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 px-3 py-2 sm:flex sm:h-14 sm:gap-4 sm:px-4 sm:py-0">
          <div className="flex shrink-0 items-center gap-2 font-semibold">
            <SpineMark />
            <span className="hidden sm:inline">
              slop web
              {config?.project && (
                <span className="ml-1.5 font-normal text-muted-foreground">— {config.project}</span>
              )}
            </span>
          </div>
          <nav
            className="order-last col-span-4 grid min-w-0 grid-cols-5 items-center gap-1 sm:order-none sm:flex sm:flex-1"
            aria-label="Main"
          >
            {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                aria-label={label}
                title={label}
                className={({ isActive }) => navClass(isActive)}
              >
                <Icon className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">{label}</span>
              </NavLink>
            ))}
          </nav>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 text-muted-foreground"
            onClick={() => setPaletteOpen(true)}
            aria-label="Jump to ticket"
          >
            <Search className="size-3.5" />
            <span className="hidden md:inline">Jump to ticket</span>
            <kbd className="ml-2 hidden rounded border border-border bg-muted px-1 font-mono text-[10px] md:inline">
              ⌘K
            </kbd>
          </Button>
          <ThemeToggle />
        </div>
      </header>
      {config?.warning && (
        <div
          role="alert"
          className="border-b border-overlay-stale/40 bg-overlay-stale/10 px-4 py-2 text-sm text-overlay-stale"
        >
          <strong className="font-semibold">Config warning:</strong> {config.warning}
        </div>
      )}
      {configError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-center gap-x-2 border-b border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          Project configuration is unavailable.
          <button type="button" className="font-medium underline" onClick={retryConfig}>
            Retry
          </button>
        </div>
      )}
      <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
        <Outlet />
      </main>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

/** The audit-spine motif, reused as the app's own mark: a thread (the
 * spine) with a human (circle) and agent (diamond) marker on it — same
 * shapes the ticket-detail timeline uses, so the brand mark and the
 * signature element are visibly the same idea. */
function SpineMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 32 32" aria-hidden="true" className="shrink-0">
      <line x1="16" y1="4" x2="16" y2="28" stroke="var(--color-spine)" strokeWidth="2.5" />
      <circle cx="16" cy="9" r="4.5" fill="var(--color-actor-human)" />
      <rect
        x="11.5"
        y="18.5"
        width="9"
        height="9"
        rx="1.5"
        fill="var(--color-actor-agent)"
        transform="rotate(45 16 23)"
      />
    </svg>
  );
}
