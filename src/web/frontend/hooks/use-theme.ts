import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

const STORAGE_KEY = "slop-web-theme";

function applyTheme(pref: ThemePreference): void {
  const root = document.documentElement;
  if (pref === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = pref;
  }
}

function readStored(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // localStorage unavailable — fall through to "system"
  }
  return "system";
}

/**
 * Dark/light theme toggle (constraint: "Dark AND light both first-class —
 * respect prefers-color-scheme, WITH a toggle"). `"system"` defers entirely
 * to the `prefers-color-scheme` media query (index.css's `@media` block);
 * `"light"`/`"dark"` stamp `data-theme` on `<html>`, which the same CSS
 * unconditionally overrides to. The inline blocking script in server.ts's
 * shell HTML applies the stored preference before first paint, so this hook
 * only needs to keep state in sync after hydration, not fix an initial
 * flash.
 */
export function useTheme(): {
  theme: ThemePreference;
  resolvedTheme: "light" | "dark";
  setTheme: (t: ThemePreference) => void;
} {
  const [theme, setThemeState] = useState<ThemePreference>(() => readStored());
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Tracks the OS preference live (not just at mount) so "System" stays
  // accurate if the user flips their OS theme without reloading the tab.
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const mql = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemPrefersDark(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const setTheme = useCallback((next: ThemePreference) => {
    setThemeState(next);
    try {
      if (next === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage unavailable — in-memory state still works for this tab
    }
  }, []);

  const resolvedTheme: "light" | "dark" =
    theme === "system" ? (systemPrefersDark ? "dark" : "light") : theme;

  return { theme, resolvedTheme, setTheme };
}
