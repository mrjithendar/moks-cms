import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    /** An uncompressed PGlite data directory (tar) with every migration applied; tests/db-helpers.ts loads it. */
    pgTemplate: string;
  }
}

/**
 * Vitest global setup: migrate one PGlite database once per run and save its data directory, so a test file loads a
 * migrated database instead of starting Postgres from scratch (initdb) and replaying every migration. That took 8–17 s
 * per file on the mk4 runners, and over 30 s while the node was out of memory (the first beforeEach of
 * tests/crewai-console.test.ts timed out on 2026-11-21). It runs in a process of its own because a closed PGlite keeps
 * its WASM memory (~600 MB) until a garbage collection, which the vitest main process would hold for the whole run.
 */
export default async function setup(project: TestProject) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "moks-cms-pg-template-"));
  const file = path.join(dir, "pgdata.tar");
  const root = project.config.root;
  await promisify(execFile)(process.execPath, ["--import", "tsx", path.join(root, "tests/db-template.build.ts"), file], { cwd: root });
  project.provide("pgTemplate", file);
  return () => rm(dir, { recursive: true, force: true });
}
