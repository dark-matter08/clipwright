import type { Config } from "tailwindcss";

// Design system — see src/styles/tokens.css for the underlying
// CSS variables (one set per theme). This file maps each token to a
// Tailwind color name using the `hsl(var(--name) / <alpha-value>)`
// pattern so the alpha modifiers we already use everywhere
// (`bg-accent/15`, `border-warn/40`) keep working under both themes.
//
// Tone: calm + technical. Closer to Linear / Raycast than Premiere.
// One strong accent (cyan) for the playhead + Render CTA — everything
// else stays in a tight neutral ramp. Per-lane timeline tints get
// their own token family so the editor reads as three distinct
// concurrent layers (Video / Audio / Captions) without leaning on
// hardcoded hex anywhere in component code.
//
// Dark mode is class-toggled via `[data-theme="dark"]` on <html>. The
// theme provider in src/lib/theme.ts sets that attribute and
// persists the choice to localStorage; the OS preference is the
// fallback when no explicit choice has been made.
const hsl = (varName: string) => `hsl(var(${varName}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // ── Surfaces ──────────────────────────────────────────
        // `bg.*` keeps its existing API so the ~30 components
        // using `bg-bg`, `bg-bg-subtle`, `bg-bg-raised`, `bg-bg-inset`
        // need NO migration — the CSS variables behind them now
        // change with the theme.
        bg: {
          DEFAULT:  hsl("--surface-base"),
          subtle:   hsl("--surface-subtle"),
          raised:   hsl("--surface-raised"),
          inset:    hsl("--surface-inset"),
        },
        // New surface levels for things that need explicit "card" /
        // "modal overlay" semantics. Optional to migrate to.
        surface: {
          DEFAULT:  hsl("--surface"),
          overlay:  hsl("--surface-overlay"),
        },

        // ── Borders ───────────────────────────────────────────
        border: {
          DEFAULT:  hsl("--border"),
          subtle:   hsl("--border-subtle"),
          strong:   hsl("--border-strong"),
        },

        // ── Foreground (text + icons) ────────────────────────
        fg: {
          DEFAULT:   hsl("--fg"),
          subtle:    hsl("--fg-subtle"),
          muted:     hsl("--fg-muted"),
          disabled:  hsl("--fg-disabled"),
          "on-accent": hsl("--fg-on-accent"),
        },

        // ── Accent (cyan family) ─────────────────────────────
        // `accent.press` is preserved as an alias for `accent.active`
        // because some existing code still uses it.
        accent: {
          DEFAULT:  hsl("--accent"),
          hover:    hsl("--accent-hover"),
          active:   hsl("--accent-active"),
          press:    hsl("--accent-active"),
          soft:     hsl("--accent-soft"),
          "soft-fg":hsl("--accent-soft-fg"),
          fg:       hsl("--fg-on-accent"),
        },

        // ── Render CTA (a deliberately expressive moment) ────
        // Same hue as accent but exposed as its own token in case
        // we want to differentiate later. Today it's accent-equivalent.
        render: {
          DEFAULT:  hsl("--render"),
          hover:    hsl("--render-hover"),
          fg:       hsl("--render-fg"),
        },

        // ── Status ────────────────────────────────────────────
        info: {
          DEFAULT:  hsl("--info"),
          soft:     hsl("--info-soft"),
          "soft-fg":hsl("--info-soft-fg"),
        },
        ok: {
          DEFAULT:  hsl("--success"),
          soft:     hsl("--success-soft"),
          "soft-fg":hsl("--success-soft-fg"),
        },
        warn: {
          DEFAULT:  hsl("--warn"),
          soft:     hsl("--warn-soft"),
          "soft-fg":hsl("--warn-soft-fg"),
        },
        danger: {
          DEFAULT:  hsl("--danger"),
          soft:     hsl("--danger-soft"),
          "soft-fg":hsl("--danger-soft-fg"),
        },

        // ── Lanes (timeline tracks) ──────────────────────────
        // Each lane has bg / border / fg / accent (the stripe color).
        // The accent value is the "vivid" color used for icons,
        // strokes, and stripe; bg/border/fg power the segment blocks.
        // Timeline.tsx migrates its LANE_TINTS and TRACK_TINTS to
        // these instead of the previous hardcoded hex literals.
        lane: {
          "video":          hsl("--lane-video"),
          "video-bg":       hsl("--lane-video-bg"),
          "video-border":   hsl("--lane-video-border"),
          "video-fg":       hsl("--lane-video-fg"),
          "audio":          hsl("--lane-audio"),
          "audio-bg":       hsl("--lane-audio-bg"),
          "audio-border":   hsl("--lane-audio-border"),
          "audio-fg":       hsl("--lane-audio-fg"),
          "captions":       hsl("--lane-captions"),
          "captions-bg":    hsl("--lane-captions-bg"),
          "captions-border":hsl("--lane-captions-border"),
          "captions-fg":    hsl("--lane-captions-fg"),
        },

        // ── Special (playhead, focus ring, selection) ────────
        playhead: {
          DEFAULT:  hsl("--playhead"),
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "monospace",
        ],
      },
      fontSize: {
        // Tight scale — nothing larger than the title bar; UI is dense.
        xs:   ["11px", "14px"],
        sm:   ["12px", "16px"],
        base: ["13px", "18px"],
        md:   ["14px", "20px"],
        lg:   ["16px", "22px"],
      },
      borderRadius: {
        sm:      "4px",
        DEFAULT: "6px",
        lg:      "8px",
      },
      transitionDuration: {
        fast:    "120ms",
        DEFAULT: "150ms",
        slow:    "180ms",
      },
      keyframes: {
        // Step-wizard transitions: a small upward slide + fade for the
        // content area when the user advances/retreats. Kept short so
        // the dialog feels responsive, not theatrical.
        stepFade: {
          "0%":   { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // Pill indicator (active step) gets a subtle pulse on arrival
        // so the eye locks onto the new position without us blowing
        // the whole header up.
        pillPulse: {
          "0%":   { transform: "scale(0.85)", opacity: "0.6" },
          "60%":  { transform: "scale(1.08)", opacity: "1" },
          "100%": { transform: "scale(1)",    opacity: "1" },
        },
        // Theme-toggle hand-off — fade the whole page through ~80ms
        // so the surface/text swap doesn't feel like a flash. Applied
        // by adding `.theme-transition` to <html> for the ~200ms
        // window around a theme change.
        themeFade: {
          "0%":   { opacity: "0.85" },
          "100%": { opacity: "1" },
        },
      },
      animation: {
        stepFade:   "stepFade 200ms ease-out both",
        pillPulse:  "pillPulse 240ms ease-out both",
        themeFade:  "themeFade 200ms ease-out both",
      },
    },
  },
} satisfies Config;
