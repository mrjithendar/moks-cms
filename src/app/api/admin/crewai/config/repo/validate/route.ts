import { z } from "zod";
import { fromFiles, type Files } from "@/lib/crewai/bundle/files";
import { repoFiles, repoSummary } from "@/lib/crewai/bundle/repo";
import { json, parse, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const body = z.object({ path: z.string().regex(/^(?!.*\.\.)(?!\/)[A-Za-z0-9_.\/-]{1,300}$/), text: z.string().max(256 * 1024).nullable(), more: z.record(z.string(), z.string().nullable()).optional() }).strict();

/**
 * POST {path, text, more?} — check a file as the editor has it: its own schema and, when the repository is set up, the
 * references of the whole folder with this change (an agent file of a crew that does not list it, a flow's crew…).
 * The SEO agent's own checks run when the configuration is imported.
 */
export const POST = seoRoute("crewai-config-repo-validate", { mutating: true, rate: { max: 120, windowSeconds: 600 }, maxBody: 2 * 1024 * 1024 }, async (_req, ctx) => {
  const b = parse(body, ctx.body ?? {});
  let files: Files = {};
  let context = false;
  if ((await repoSummary()).configured) {
    try {
      files = (await repoFiles()).files;
      context = true;
    } catch {
      /* the file alone */
    }
  }
  const next: Files = { ...files, ...(b.more ?? {}) } as Files;
  for (const [p, t] of Object.entries(b.more ?? {})) if (t === null) delete next[p];
  if (b.text === null) delete next[b.path];
  else next[b.path] = b.text;
  const parsed = fromFiles(context ? next : { [b.path]: b.text ?? "" });
  const { checkStructure } = await import("@/lib/crewai/bundle/check");
  const issues = [...parsed.issues, ...(context ? checkStructure(parsed.config, parsed.paths) : [])];
  return json({ context, issues: issues.filter((i) => context || i.path === b.path), errors: issues.filter((i) => i.severity === "error").length });
});
