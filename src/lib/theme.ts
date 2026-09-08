// Theme provider — light / dark / system.
//
// Reads + writes `data-theme` on <html>. The Tailwind config's
// `darkMode: ["class", '[data-theme="dark"]']` flips every dark:-
// variant utility based on that attribute, and tokens.css uses the
// same selector to swap the CSS variable values for surfaces,
// borders, fg, accent, etc.
//
// Storage: `localStorage["clipwright.theme"]` holds one of
// "light" | "dark" | "system". When unset (first launch), we treat
// it as "system" — read `prefers-color-scheme` and apply it,
// without writing anything back. Listening to the media query keeps
// "system" reactive: the user can flip their OS theme and the app
// follows.
//
// Why not a React context: the provider runs ONCE at module load
// (so the very first paint is themed correctly — no FOUC) and
// exposes a `useTheme()` hook backed by a tiny zustand-style
// listener pattern. The toggle component subscribes via
// `useSyncExternalStore`, which is the React-blessed way to
// integrate external mutable state.
//
// Memorable thing for this module: it's small enough that a
// reader can hold the whole flow in their head. No FOUC, no
// flicker on toggle, no re-paint of unrelated components.

import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "clipwright.theme";
const ATTR = "data-theme";

// ── Listener registry ──────────────────────────────────────────
// `subscribers` holds every `useSyncExternalStore` subscriber's
// `onStoreChange` callback. We call them all when the resolved
// theme changes (either because the user picked a different
// choice OR because the OS preference flipped while in system
// mode).
const subscribers = new Set<() => void>();
function notify() {
  subscribers.forEach((cb) => cb());
}

function readChoice(): ThemeChoice {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // localStorage can throw in some sandboxed contexts; default
    // to system rather than crashing.
  }
  return "system";
}

function osPreference(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolve(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? osPreference() : choice;
}

// Apply the resolved theme to <html>. We DON'T toggle a class —
// the tokens.css + tailwind config both key off the `data-theme`
// attribute. Setting the attribute is one DOM write, no className
// reshuffling.
//
// `theme-transition` is added briefly around a manual change so
// the page fades rather than flashes. The class auto-removes via
// the keyframe end. Skipped on the initial paint (no transition
// when the page is loading).
function applyToDOM(resolved: ResolvedTheme, animate: boolean) {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  if (animate) {
    html.classList.add("theme-transition");
    // Force a reflow so the class lands before the attribute swap.
    void html.offsetHeight;
  }
  html.setAttribute(ATTR, resolved);
  if (animate) {
    window.setTimeout(() => {
      html.classList.remove("theme-transition");
    }, 220);
  }
}

// ── Initialization ─────────────────────────────────────────────
// Runs once at module load. We DON'T defer this to React's effect
// system — that runs AFTER the first paint, and the user would
// see a flash of the wrong theme. By touching the DOM here,
// before React mounts, the very first paint is already themed.
if (typeof window !== "undefined") {
  const initial = readChoice();
  applyToDOM(resolve(initial), /* animate */ false);

  // Listen for OS preference changes — only meaningful when the
  // user is on "system" mode, but cheap enough to leave registered
  // always. If they're on an explicit choice, the resolved value
  // doesn't depend on the OS so notify is a no-op visually.
  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (readChoice() === "system") {
        applyToDOM(osPreference(), /* animate */ true);
        notify();
      }
    };
    // Modern browsers; the addListener fallback is dropped — Tauri
    // ships a modern WebView, so addEventListener is universally
    // present.
    mql.addEventListener("change", onChange);
  }
}

// ── Public API ─────────────────────────────────────────────────

/** Read the user's stored preference (the THREE-state choice). */
export function getThemeChoice(): ThemeChoice {
  return readChoice();
}

/** Read the currently-applied theme (the TWO-state resolved value).
 *  When the choice is `"system"` this returns whatever the OS is
 *  currently set to; when the choice is explicit it returns that. */
export function getResolvedTheme(): ResolvedTheme {
  return resolve(readChoice());
}

/** Set the user's theme preference. `"system"` clears any explicit
 *  override and falls back to `prefers-color-scheme`. The DOM is
 *  updated synchronously so the next paint is already themed. */
export function setThemeChoice(next: ThemeChoice): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Even if persistence fails, apply the choice in-memory.
  }
  applyToDOM(resolve(next), /* animate */ true);
  notify();
}

/** React hook returning a stable tuple of the current choice +
 *  resolved theme + a setter. Re-renders when either value changes
 *  (because the user picked a different option, because the OS
 *  preference flipped while in system mode, or because another
 *  component called setThemeChoice). */
export function useTheme(): {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (next: ThemeChoice) => void;
} {
  const subscribe = (onStoreChange: () => void) => {
    subscribers.add(onStoreChange);
    return () => {
      subscribers.delete(onStoreChange);
    };
  };
  // Two getSnapshot calls — one per field. We collapse via a stable
  // serialization so React's "same reference?" check doesn't
  // re-render every tick.
  const choice = useSyncExternalStore(
    subscribe,
    () => readChoice(),
    () => "system" as ThemeChoice,
  );
  const resolved = useSyncExternalStore(
    subscribe,
    () => resolve(readChoice()),
    () => "dark" as ResolvedTheme,
  );
  return { choice, resolved, setChoice: setThemeChoice };
}
