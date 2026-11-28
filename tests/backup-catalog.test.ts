import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDbForTests, type Db } from "@/db";
import { POLICIES, parentsFirst, policyOf, readCatalog, selfReferences } from "@/lib/backup/catalog";
import { freshDb } from "./db-helpers";

/**
 * Which tables a site backup holds (lib/backup/catalog.ts, D-108), checked against the schema every migration builds.
 * Format 1 named 12 tables and missed everything added after it; now every table is in unless a policy says otherwise,
 * so the guard is the other way round: a table that holds credentials must have a policy, and the restore order must
 * exist.
 */
let db: Db;
beforeEach(async () => {
  db = await freshDb();
});
afterEach(() => setDbForTests(undefined));

const CREDENTIAL = /(^|_)(password|token|secret|hash|code_hash|token_hash|api_key|access_key|private_key)($|_)/;
/** Looked at and kept in backups on purpose (D-108). */
const REVIEWED: Record<string, string> = {
  "invoice.token": "the client's invoice link (/invoice/<token>): a restore must keep the links already emailed working",
  "seo_ask_log.feedback_token": "lets an anonymous reader rate one Ask the Blog answer; grants nothing else",
  "seo_reports.request_hash": "a hash of a report request, to find duplicates: not a secret",
};

describe("the backup catalogue", () => {
  it("covers every table of the schema; a column that looks like a credential needs a policy", async () => {
    const tables = await readCatalog(db);
    expect(tables.length).toBeGreaterThan(100);
    const unreviewed: string[] = [];
    for (const t of tables) {
      const p = policyOf(t.name);
      const risky = t.columns.filter((c) => CREDENTIAL.test(c.name) && !c.name.endsWith("_at") && !REVIEWED[`${t.name}.${c.name}`] && !/^(content_hash|input_hash|url_hash|seed_hash|base_hash|ip_hash|idempotency_key|rule_key|check_key|dedupe_key|storage_key|pdf_key|temp_key|writing_profile_key|image_profile_key)$/.test(c.name));
      if (!risky.length) continue;
      const covered = p.mode === "exclude" || (p.mode === "merge" && risky.every((c) => p.omit?.includes(c.name)));
      if (!covered) unreviewed.push(`${t.name}.${risky.map((c) => c.name).join(",")}`);
    }
    // A new table with such a column: decide in lib/backup/catalog.ts POLICIES (exclude it, or merge and omit the column).
    expect(unreviewed).toEqual([]);
  });

  it("every policy names a table that exists (or one the SEO agent creates at run time)", async () => {
    const names = new Set((await readCatalog(db)).map((t) => t.name));
    expect(Object.keys(POLICIES).filter((n) => !names.has(n))).toEqual([]);
  });

  it("has a restore order (no foreign-key cycle), and self-references can be filled in afterwards", async () => {
    const kept = (await readCatalog(db)).filter((t) => policyOf(t.name).mode !== "exclude");
    const order = parentsFirst(kept);
    expect(order.indexOf("user")).toBeLessThan(order.indexOf("post"));
    expect(order.indexOf("post")).toBeLessThan(order.indexOf("comment"));
    for (const t of kept) for (const f of selfReferences(t)) expect(f.columns.some((c) => t.columns.find((x) => x.name === c)?.nullable), `${t.name}.${f.name}`).toBe(true);
  });

  it("finds a cycle instead of guessing an order", () => {
    const t = (name: string, ref: string) => ({ name, columns: [], primaryKey: [], foreignKeys: [{ name: `${name}_fk`, columns: ["x"], refTable: ref, refColumns: ["id"], onDelete: "a" as const }] });
    expect(() => parentsFirst([t("a", "b"), t("b", "a")])).toThrow(/cycle/);
  });
});
