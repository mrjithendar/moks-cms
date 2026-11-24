import "server-only";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { siteUrl } from "@/config/site";
import { getDb } from "@/db";
import { migrationFiles } from "@/db/migrate";
import { rowsOf } from "@/db/rows";
import { json } from "@/lib/seo-intel/http";
import type { SessionUser } from "@/lib/session";
import { toFiles, type Files, type Manifest } from "./files";
import { ImportError, importRequestOptions } from "./import";
import { RepoError, type Author } from "./repo";
import { exportRuntime, type ExportReport } from "./runtime";
import { hasSyncTable, syncStatus } from "./sync";

/** What the routes share: the export as files, request bodies, errors as JSON, the commit author, readiness. */

export const siteHost = () => new URL(siteUrl()).host;

export async function exportFiles(): Promise<{ files: Files; manifest: Manifest; report: ExportReport }> {
  const rt = await exportRuntime();
  const files = toFiles(rt.config, { source: siteHost(), exportedAt: new Date().toISOString(), cmsVersion: process.env.GIT_SHA ?? "dev", agentVersion: rt.report.agent.version, unsupported: rt.report.unsupported });
  return { files, manifest: JSON.parse(files["manifest.json"]!) as Manifest, report: rt.report };
}

/** An import request: the bundle (files, or a format 1 file), and the options. */
export const importBody = importRequestOptions.extend({
  bundle: z.unknown(),
  dryRun: z.boolean().default(true),
  revision: z.string().regex(/^[0-9a-f]{7,64}$/).nullish(),
  ref: z.string().max(200).nullish(),
  url: z.string().max(500).nullish(),
});

/** 12 MB: a bundle has at most 8 MB of files (files.ts LIMITS), plus JSON escaping. */
export const MAX_IMPORT_BYTES = 12 * 1024 * 1024;

export function errorJson(e: unknown): Response {
  if (e instanceof ImportError) return json({ error: e.message, issues: e.issues, ...(e.plan ? { plan: e.plan } : {}), ...(e.recordId ? { record: e.recordId } : {}) }, e.status);
  if (e instanceof RepoError) return json({ error: e.message, issues: e.issues }, e.status);
  throw e;
}

export const authorOf = (u: SessionUser): Author => ({ name: u.name || u.email, email: u.email });

/** The deployment's readiness check: the database answers, every migration is applied, the agent answers. */
export async function readiness() {
  const d = await getDb();
  const applied = new Set(rowsOf<{ name: string }>(await d.execute(sql`select name from schema_migrations`)).map((r) => r.name));
  const files = migrationFiles();
  const pending = files.filter((f) => !applied.has(f));
  const status = await syncStatus({ fresh: true });
  return {
    database: "ok" as const,
    migrations: { latest: [...applied].sort().at(-1) ?? null, pending, ok: pending.length === 0 && (await hasSyncTable(d)) },
    agent: status.report.agent,
    configuration: { version: status.version, counts: status.counts, complete: status.complete, drift: status.drift, lastImport: status.lastImport, baseline: status.baseline },
  };
}
