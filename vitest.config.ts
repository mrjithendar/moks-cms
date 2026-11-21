import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Migrates one PGlite database per run; freshDb() (tests/db-helpers.ts) loads a copy of it for each test.
    globalSetup: ["tests/db-template.setup.ts"],
    // freshDb() collects the memory of the database it closes (tests/db-helpers.ts).
    execArgv: ["--expose-gc"],
    // Database tests start an in-process Postgres (PGlite); in CI they share the CPU with the
    // parallel production build, so allow more than the 5 s default. Assertions are unchanged.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Each worker holds its own PGlite instance. With the default worker count the 4-vCPU arm runner stalls and the
    // runner is killed mid-test ("The operation was canceled", no later steps run), so cap it in CI only.
    maxWorkers: process.env.CI ? 2 : undefined,
    env: {
      CONTENT_DIR: path.resolve(import.meta.dirname, "tests/fixtures/content"),
      SITE_URL: "https://jithendar.com",
    },
  },
});
