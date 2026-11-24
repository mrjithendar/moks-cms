import { z } from "zod";
import { authenticateApiKey } from "@/lib/api-keys";
import { importBundle, ImportError, importRequestOptions } from "@/lib/crewai/bundle/import";
import { MAX_IMPORT_BYTES } from "@/lib/crewai/bundle/service";
import { reportError, routeFields } from "@/lib/http-errors";
import { PostError } from "@/lib/posts";
import { bodyBytes } from "../../../_lib";

export const dynamic = "force-dynamic";

const body = importRequestOptions
  .extend({
    files: z.record(z.string(), z.string()).optional(),
    bundle: z.unknown().optional(),
    dryRun: z.boolean().default(true),
    source: z.enum(["deploy", "api"]).default("api"),
    revision: z.string().regex(/^[0-9a-f]{7,64}$/).nullish(),
    ref: z.string().max(200).nullish(),
    url: z.string().max(500).nullish(),
  })
  .strict();

const NO_STORE = { "Cache-Control": "no-store" };
const reply = (status: number, payload: unknown) => Response.json(payload, { status, headers: NO_STORE });

/**
 * POST /api/v1/crewai/config/import (scope crewai:import) — {files | bundle, dryRun (default true), policy (default skip),
 * prune, kinds, only, allowPartial, source (deploy | api), revision, ref, url}. A dry run answers the plan; otherwise the
 * plan is applied in one transaction, verified, and recorded with the revision (lib/crewai/bundle/import.ts). With the
 * default policy a change made in the admin since the last sync is never overwritten: it is reported as a conflict.
 * A refused or failed import changes nothing and answers 409 / 500 with the reasons and the plan.
 */
export async function POST(request: Request) {
  try {
    const auth = await authenticateApiKey(request.headers.get("authorization"));
    if (!auth.scopes.includes("crewai:import")) throw new PostError("This key lacks the crewai:import scope.", 403);
    if (auth.actor.role !== "admin") throw new PostError("Only an admin's key can import the configuration.", 403);
    let raw: unknown;
    try {
      raw = JSON.parse((await bodyBytes(request, MAX_IMPORT_BYTES)).toString("utf8"));
    } catch (e) {
      if (e instanceof PostError) throw e;
      throw new PostError("The request body must be JSON.", 400);
    }
    const r = body.safeParse(raw);
    if (!r.success) throw new PostError("The request is not valid.", 400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).slice(0, 20));
    const { files, bundle, dryRun, source, revision, ref, url, ...opts } = r.data;
    if (!files && bundle === undefined) throw new PostError("Send files ({path: text}) or a bundle.", 400);
    const out = await importBundle(files ? { files } : bundle, { ...opts, dryRun }, auth.actor, { source, revision: revision ?? null, ref: ref ?? null, url: url ?? null });
    return reply(200, { data: out });
  } catch (e) {
    if (e instanceof ImportError) return reply(e.status, { error: { message: e.message, issues: e.issues, record: e.recordId ?? null }, plan: e.plan ?? null });
    if (e instanceof PostError) return reply(e.status, { error: { message: e.message, issues: e.issues } });
    const ref = reportError("crewai config import failed", e, routeFields(request));
    return reply(500, { error: { message: "Internal error.", code: "internal", reference: ref.reference } });
  }
}
