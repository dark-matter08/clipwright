// Theme tokens for the manhwa-recap composition.
//
// Each theme bundles BG color, accent color, chapter-chip styling, and a
// caption band tone. The template's `defaults.theme` or an inputs-level
// `theme` field picks one; the composition reads tokens through this map.
//
// New themes drop in by extending `ManhwaTheme` in schema.ts AND adding
// an entry here — the composition's render code is theme-agnostic.

import type { ManhwaTheme } from "./schema";

export interface ThemeTokens {
  /** Solid backdrop fill behind every segment. */
  background: string;
  /** Accent color — used for chapter chip BG, caption highlights. */
  accent: string;
  /** Foreground color over `accent` (chip text). */
  accentFg: string;
  /** Tone for the chapter-chip border. */
  chipBorder: string;
  /** Caption text color. */
  captionFg: string;
  /** Caption background overlay color (with alpha baked in). */
  captionBg: string;
}

export const THEMES: Record<ManhwaTheme, ThemeTokens> = {
  "dark-fantasy": {
    background: "#0a0506",
    accent: "#b91c1c",         // blood red
    accentFg: "#fef2f2",
    chipBorder: "rgba(220, 38, 38, 0.45)",
    captionFg: "#fef2f2",
    captionBg: "rgba(10, 5, 6, 0.65)",
  },
  cyberpunk: {
    background: "#08081a",
    accent: "#06b6d4",         // neon cyan
    accentFg: "#ecfeff",
    chipBorder: "rgba(34, 211, 238, 0.5)",
    captionFg: "#ecfeff",
    captionBg: "rgba(8, 8, 26, 0.65)",
  },
  "minimal-dark": {
    background: "#0a0a0a",
    accent: "#e5e5e5",
    accentFg: "#0a0a0a",
    chipBorder: "rgba(229, 229, 229, 0.4)",
    captionFg: "#fafafa",
    captionBg: "rgba(10, 10, 10, 0.65)",
  },
  romantic: {
    background: "#1a0a14",
    accent: "#fb7185",         // soft rose
    accentFg: "#1a0a14",
    chipBorder: "rgba(244, 114, 182, 0.45)",
    captionFg: "#fdf2f8",
    captionBg: "rgba(26, 10, 20, 0.6)",
  },
};

export function getTheme(name: ManhwaTheme | undefined): ThemeTokens {
  return THEMES[name ?? "dark-fantasy"];
}
