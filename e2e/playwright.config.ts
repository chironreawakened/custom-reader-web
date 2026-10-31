import { defineConfig } from "@playwright/test";

// E2E runs in CI only (never on the VPS — 4 GB RAM). The CI job brings up
// e2e/docker-compose.e2e.yml (postgres + minio), runs migrations, starts the
// locally built API with MAILER=console, then points us at it.
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts$/,
  timeout: 60_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
  },
});
