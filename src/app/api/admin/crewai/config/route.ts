import { importBundle } from "@/lib/crewai/bundle/import";
import { errorJson, exportFiles, importBody, MAX_IMPORT_BYTES, siteHost } from "@/lib/crewai/bundle/service";
import { zipFiles } from "@/lib/crewai/bundle/zip";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/crewai/config — the complete CrewAI configuration bundle (lib/crewai/bundle, D-101): every crew with its
 * agents and tasks, flow, skill, schedule, content source and category, and the read-only tools, guardrails and
 * providers, discovered from what runs. `?format=zip` downloads the crewconfig/ folder; `?format=json` (the default) the
 * files as JSON with the export report; `?download=1` as an attachment. No secrets. Audit-logged.
 */
export const GET = seoRoute("crewai-config-export", { rate: { max: 30, windowSeconds: 600 } }, async (_req, ctx) => {
  const { files, manifest, report } = await exportFiles();
  const host = siteHost();
  await ctx.audit("crewai.config.export", host, { counts: report.counts, complete: report.complete, redacted: report.redacted.length, format: ctx.query.get("format") ?? "json" });
  const name = `crewconfig-${host.replace(/[^a-z0-9.-]/gi, "")}-${manifest.exported_at!.slice(0, 10)}`;
  if (ctx.query.get("format") === "zip") {
    const zip = await zipFiles(files);
    return new Response(Buffer.from(zip), { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${name}.zip"`, "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" } });
  }
  const body = { kind: manifest.kind, format: manifest.format, files, report };
  return json(body, 200, ctx.query.get("download") ? { "Content-Disposition": `attachment; filename="${name}.json"` } : {});
});

/**
 * POST /api/admin/crewai/config {bundle, dryRun, policy, prune, kinds, only, activate, allowPartial} — import a bundle
 * ({files} or a moks-crewai-config file). A dry run returns the plan; otherwise the plan is made again and applied in one
 * transaction, verified and recorded (lib/crewai/bundle/import.ts). Admins default to overwriting conflicts: they saw
 * the plan. Nothing is removed unless `prune`.
 */
export const POST = seoRoute("crewai-config-import", { mutating: true, rate: { max: 30, windowSeconds: 600 }, maxBody: MAX_IMPORT_BYTES }, async (_req, ctx) => {
  const b = parse(importBody, ctx.body ?? {});
  try {
    const { bundle, dryRun, revision, ref, url, ...opts } = b;
    const out = await importBundle(bundle, { ...opts, policy: opts.policy ?? "overwrite", dryRun }, ctx.actor, { source: "admin", revision: revision ?? null, ref: ref ?? null, url: url ?? null, label: "a file" });
    return json(out);
  } catch (e) {
    return errorJson(e);
  }
});
