import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, inject } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import { setDbForTests, schema, type Db } from "@/db";
import { migrateDb } from "@/db/migrate";

/**
 * The migrated data directory that tests/db-template.setup.ts saved for this run, read once per test file (worker).
 * Every test loads a new database from it: replaying all migrations into a new PGlite for each test took ~5× longer and
 * timed out in CI, and doing it once per file (a live template database to clone) still took 8–30 s per file on the
 * mk4 runners and ~300 MB per worker.
 */
let template: Promise<File> | undefined;

function migratedTemplate(): Promise<File> {
  template ??= readFile(inject("pgTemplate"))
    .then((bytes) => new File([bytes], "pgdata.tar", { type: "application/x-tar" }))
    .catch((err) => {
      template = undefined;
      throw err;
    });
  return template;
}

/**
 * The database handed out by the previous freshDb() call. Each one is a whole WASM Postgres (its own linear memory,
 * outside the JS heap and never garbage-collected while open), so leaving them open grew a worker to ~4 GB RSS in
 * files with many tests and the CI runner killed `npm test` (exit 143). Tests use one database at a time, so the
 * previous one is closed when the next is made, and the last one when the file ends.
 */
let current: PGlite | undefined;

/**
 * A closed PGlite still holds its WASM memory until V8 collects it, and a worker rarely allocates enough JS to trigger
 * that, so closed databases piled up to 1.3–1.8 GB per worker. Collecting after each close keeps a worker at ~1 GB, with
 * no measurable cost in run time. `gc` exists because vitest.config.ts starts the workers with --expose-gc.
 */
const collectGarbage = (globalThis as { gc?: () => void }).gc;

async function closeCurrent() {
  const pg = current;
  current = undefined;
  await pg?.close().catch(() => {});
  if (pg) collectGarbage?.();
}

afterAll(closeCurrent);

/** Fresh in-memory Postgres (PGlite) with all migrations applied, installed as the app database. */
export async function freshDb(): Promise<Db> {
  await closeCurrent();
  const pg = new PGlite({ loadDataDir: await migratedTemplate() });
  current = pg;
  const db = drizzle(pg, { schema }) as unknown as Db;
  // Still runs the migrator: a no-op on the loaded copy, it keeps the start-up path (advisory lock, ledger) exercised.
  await migrateDb(db);
  setDbForTests(db);
  return db;
}
