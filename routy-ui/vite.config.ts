import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // Live routy-core gateway: management API + SSE log stream.
      "/api": {
        target: "http://127.0.0.1:8010",
        changeOrigin: false,
      },
      // Proxy surface — used only for GET /v1/models (routable name suggestions).
      "/v1": {
        target: "http://127.0.0.1:8010",
        changeOrigin: false,
      },
    },
  },
});
