import { z } from "zod";
import { repoFileAt, saveRepoFiles } from "@/lib/crewai/bundle/repo";
import { authorOf, errorJson } from "@/lib/crewai/bundle/service";
import { json, parse, SeoApiError, seoRoute } from "@/lib/seo-intel/http";

export const dynamic = "force-dynamic";

const PATH = z.string().regex(/^(?!.*\.\.)(?!\/)[A-Za-z0-9_.\/-]{1,300}$/, "a path inside the folder");
const SHA = z.string().regex(/^[0-9a-f]{40}$/);

/** GET ?path=&ref= — one file's text and blob at a commit or branch (the head by default). */
export const GET = seoRoute("crewai-config-repo-file", {}, async (_req, ctx) => {
  const path = parse(PATH, ctx.query.get("path") ?? "");
  try {
    const { repoSettings } = await import("@/lib/crewai/bundle/repo");
    const ref = ctx.query.get("ref") || (await repoSettings()).branch;
    const f = await repoFileAt(path, ref);
    if (!f) throw new SeoApiError("No such file there.", 404, "not_found");
    return json({ path, ref, ...f });
  } catch (e) {
    if (e instanceof SeoApiError) throw e;
    return errorJson(e);
  }
});

const save = z
  .object({
    path: PATH,
    /** null deletes the file. */
    text: z.string().max(256 * 1024).nullable(),
    base: SHA,
    /** The file's blob when the editor read it; null: a new file. */
    expected: SHA.nullable(),
    message: z.string().trim().max(500).optional(),
    /** Further files saved in the same commit (a new crew's agents and tasks). */
    more: z.record(PATH, z.string().max(256 * 1024).nullable()).optional(),
  })
  .strict();

/** PUT {path, text, base, expected, message, more} — save (or delete, text null) a file as one commit or pull request. */
export const PUT = seoRoute("crewai-config-repo-save-file", { mutating: true, rate: { max: 60, windowSeconds: 600 }, maxBody: 2 * 1024 * 1024 }, async (_req, ctx) => {
  const b = parse(save, ctx.body ?? {});
  const changes = { ...(b.more ?? {}), [b.path]: b.text };
  const expected: Record<string, string | null> = { [b.path]: b.expected };
  const verb = b.text === null ? "remove" : b.expected ? "update" : "add";
  try {
    return json(await saveRepoFiles({ changes, base: b.base, expected, message: b.message || `crewconfig: ${verb} ${b.path}`, author: authorOf(ctx.user) }, ctx.actor));
  } catch (e) {
    return errorJson(e);
  }
});
