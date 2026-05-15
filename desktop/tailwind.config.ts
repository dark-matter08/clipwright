import type { Config } from "tailwindcss";

// Visual language hints — SRS §8.7.
// Tone: calm + technical. Closer to Linear / Raycast than Premiere.
// Dark mode is the default; light mode follows the system.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // Neutral monochrome ramp + one strong accent (cyan-500) for the
        // playhead / Render CTA per SRS §8.7.
        bg: {
          DEFAULT: "#0b0d10",
          subtle: "#13161a",
          raised: "#191d22",
          inset: "#0f1216",
        },
        border: {
          DEFAULT: "#262b32",
          subtle: "#1d2127",
        },
        fg: {
          DEFAULT: "#e6e8eb",
          subtle: "#a5acb5",
          muted: "#6b7380",
        },
        accent: {
          DEFAULT: "#22d3ee",
          hover: "#06b6d4",
          press: "#0891b2",
        },
        danger: { DEFAULT: "#f87171" },
        warn:   { DEFAULT: "#fbbf24" },
        ok:     { DEFAULT: "#34d399" },
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
        // tight scale: nothing larger than the title bar; UI is dense
        xs: ["11px", "14px"],
        sm: ["12px", "16px"],
        base: ["13px", "18px"],
        md: ["14px", "20px"],
        lg: ["16px", "22px"],
      },
      borderRadius: {
        sm: "4px",
        DEFAULT: "6px",
        lg: "8px",
      },
      transitionDuration: {
        fast: "120ms",
        DEFAULT: "150ms",
        slow: "180ms",
      },
      keyframes: {
        // Step-wizard transitions: a small upward slide + fade for the
        // content area when the user advances/retreats. Kept short so
        // the dialog feels responsive, not theatrical.
        stepFade: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // Pill indicator (active step) gets a subtle pulse on arrival
        // so the eye locks onto the new position without us blowing
        // the whole header up.
        pillPulse: {
          "0%": { transform: "scale(0.85)", opacity: "0.6" },
          "60%": { transform: "scale(1.08)", opacity: "1" },
          "100%": { transform: "scale(1)", opacity: "1" },
        },
      },
      animation: {
        stepFade: "stepFade 200ms ease-out both",
        pillPulse: "pillPulse 240ms ease-out both",
      },
    },
  },
} satisfies Config;
