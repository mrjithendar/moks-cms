import { PGlite } from "@electric-sql/pglite";
import { afterAll } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import { setDbForTests, schema, type Db } from "@/db";
import { migrateDb } from "@/db/migrate";

/**
 * One migrated database per test file (worker), cloned for every test: replaying all migrations into a new
 * PGlite for each test took ~5× longer and timed out in CI, where tests share the CPU with the production build.
 */
let template: Promise<PGlite> | undefined;

function migratedTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const pg = new PGlite();
    await migrateDb(drizzle(pg, { schema }) as unknown as Db);
    return pg;
  })().catch((err) => {
    template = undefined;
    throw err;
  });
  return template;
}

/**
 * The clone handed out by the previous freshDb() call. Each clone is a whole WASM Postgres (its own linear memory,
 * outside the JS heap and never garbage-collected while open), so leaving them open grew a worker to ~4 GB RSS in
 * files with many tests and the CI runner killed `npm test` (exit 143). Tests use one database at a time, so the
 * previous clone is closed when the next is made, and the last one when the file ends.
 */
let current: PGlite | undefined;

async function closeCurrent() {
  const pg = current;
  current = undefined;
  await pg?.close().catch(() => {});
}

afterAll(closeCurrent);

/** Fresh in-memory Postgres (PGlite) with all migrations applied, installed as the app database. */
export async function freshDb(): Promise<Db> {
  await closeCurrent();
  const pg = (await (await migratedTemplate()).clone()) as PGlite;
  current = pg;
  const db = drizzle(pg, { schema }) as unknown as Db;
  // Still runs the migrator: a no-op on the clone, it keeps the start-up path (advisory lock, ledger) exercised.
  await migrateDb(db);
  setDbForTests(db);
  return db;
}
