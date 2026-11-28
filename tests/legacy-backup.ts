import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { rowsOf } from "@/db/rows";

/**
 * Format-1 backups (content only, 2026-11-14 → 2026-11-28) as the site made them, for the tests of restoring them: the
 * site no longer makes these (D-108), but the archives already in buckets are still downloaded and restored.
 */
const TABLES = ["post", "page", "category", "author_profile", "comment", "comment_like", "comment_report", "contact_message", "media", "redirect", "site_config", "user"];

export async function legacyBackup(opts: { plain?: boolean; at?: Date } = {}): Promise<{ filename: string; data: Buffer; encrypted: boolean }> {
  const { readBackupConfig, serverBackupPassword, zipBackup } = await import("@/lib/backups");
  const c = await readBackupConfig();
  const db = await getDb();
  const tables: Record<string, unknown[]> = {};
  for (const t of TABLES) tables[t] = rowsOf(await db.execute(sql.raw(`select * from "${t}"`)));
  const [site] = await db.select().from(schema.setting).where(eq(schema.setting.key, "site"));
  const createdAt = (opts.at ?? new Date()).toISOString();
  const payload = { format: "jithendar-backup", version: 1, createdAt, appVersion: "dev", note: "test", settings: site?.value ?? null, tables };
  const password = c.encrypt && !opts.plain ? serverBackupPassword() : undefined;
  const data = await zipBackup(JSON.stringify(payload), createdAt, password);
  const stamp = createdAt.replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return { filename: `jithendar-backup-${stamp}.zip`, data, encrypted: Boolean(password) };
}
