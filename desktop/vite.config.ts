import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Tauri uses fixed port 1420 in dev so the Rust shell knows where to attach.
// HMR is exposed over a separate port so the iframe can reload cleanly.
export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: { protocol: "ws", host: "localhost", port: 1421 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
