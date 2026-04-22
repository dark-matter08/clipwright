/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Base surfaces
        bg: "rgb(6 8 15)",
        "bg-raised": "rgb(10 15 28)",
        panel: "rgb(14 21 38)",
        "panel-2": "rgb(18 26 46)",
        border: "rgb(29 41 66)",
        "border-strong": "rgb(41 58 92)",
        // Foreground
        fg: "rgb(230 240 250)",
        "fg-dim": "rgb(179 197 219)",
        muted: "rgb(102 119 147)",
        "muted-dim": "rgb(58 76 105)",
        // Accents
        accent: "rgb(0 245 229)",
        "accent-dim": "rgb(10 168 156)",
        accent2: "rgb(232 121 249)",
        accent3: "rgb(251 191 36)",
        // Semantic
        ok: "rgb(74 222 128)",
        danger: "rgb(255 77 109)",
      },
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "SF Mono",
          "ui-monospace",
          "Menlo",
          "monospace",
        ],
        sans: [
          "Inter",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
      boxShadow: {
        "glow-teal":
          "0 0 0 1px rgba(0,245,229,.25), 0 0 24px rgba(0,245,229,.15)",
        "glow-teal-strong":
          "0 0 0 1px rgba(0,245,229,.55), 0 0 40px rgba(0,245,229,.35)",
        "glow-mag":
          "0 0 0 1px rgba(232,121,249,.35), 0 0 28px rgba(232,121,249,.22)",
        lift: "0 1px 0 rgba(255,255,255,.02) inset, 0 8px 30px rgba(0,0,0,.5)",
      },
      keyframes: {
        "soft-pulse": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.45" },
        },
        "glow-pulse": {
          "0%, 100%": {
            boxShadow: "0 0 0 0 rgba(0,245,229,.55)",
            opacity: "1",
          },
          "50%": {
            boxShadow: "0 0 0 4px rgba(0,245,229,0)",
            opacity: "0.55",
          },
        },
      },
      animation: {
        "soft-pulse": "soft-pulse 2s ease-in-out infinite",
        "glow-pulse": "glow-pulse 2s ease-in-out infinite",
        "spin-slow": "spin 1.2s linear infinite",
      },
    },
  },
  plugins: [],
};
