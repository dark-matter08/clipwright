/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "rgb(8 12 22)",
        panel: "rgb(14 20 32)",
        border: "rgb(30 40 58)",
        accent: "rgb(0 245 229)",
        accent2: "rgb(232 121 249)",
        fg: "rgb(230 240 250)",
        muted: "rgb(120 140 165)",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "SF Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
