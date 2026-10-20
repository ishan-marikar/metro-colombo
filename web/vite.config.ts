import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { lingui } from "@lingui/vite-plugin";

// The API server (repository root, `npm start`) serves `/api/*`. Set API_TARGET
// to use another one, e.g. https://metro.manasa.ai, without running a backend.
const target = process.env.API_TARGET ?? "http://127.0.0.1:8789";
const api = { "/api": { target, changeOrigin: true } };

export default defineConfig({
  plugins: [
    TanStackRouterVite(),
    react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
    // Compiles the `.po` catalogs on import. The build fails if a Sinhala or
    // Tamil translation is missing or invalid.
    lingui({ failOnMissing: "catalog", failOnCompileError: true }),
    tailwindcss(),
  ],
  server: { port: 5173, strictPort: true, proxy: api },
  preview: { port: 5173, strictPort: true, proxy: api },
  test: { include: ["tests/**/*.test.{ts,tsx}"] },
});
