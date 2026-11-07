import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": { target: process.env.AGENT_URL ?? "http://localhost:8787", changeOrigin: true },
      "/events": { target: process.env.AGENT_URL ?? "http://localhost:8787", changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
