import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  root: "web",
  // Runtime/operator .env files are never frontend inputs. This application
  // receives public settings through its API, so it needs no VITE_* values.
  envDir: false,
  envPrefix: [],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/media": "http://127.0.0.1:8787",
    },
  },
});
