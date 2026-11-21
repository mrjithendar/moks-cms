// Run by tests/db-template.setup.ts in a process of its own (tsx): migrates a new PGlite database and writes its data
// directory, uncompressed, to the path given as the only argument.
import { writeFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { schema, type Db } from "@/db";
import { migrateDb } from "@/db/migrate";

const out = process.argv[2];
if (!out) throw new Error("usage: tsx tests/db-template.build.ts <output .tar>");
const pg = new PGlite();
await migrateDb(drizzle(pg, { schema }) as unknown as Db);
const dump = await pg.dumpDataDir("none");
await writeFile(out, Buffer.from(await dump.arrayBuffer()));
await pg.close();
