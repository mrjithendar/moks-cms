import { diffWords } from "diff";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { rowsOf } from "@/db/rows";
import { log } from "../log";
import type { Actor } from "../posts";
import { blocksOf, linksIn, rewriteLink, validateChangeSet, type Change } from "./changeset";
import { publicFetcher, type PageFetcher } from "./crawler";
import { DraftError, loadBase, openDraft, renumber, reserveDraft, validationContext } from "./drafts";
import { approveDraft } from "./publish";
import type { SeoSettings } from "./settings";
import { siteOrigin } from "./urls";

/**
 * Broken-link checker (Link Whisper-style; owner decision 2026-11-10).
 *
 * Weekly (Settings `links.check`) every link in published posts and site pages is checked once per distinct URL:
 * - internal links against the site itself: a published post, a page, an app route, or a redirect (→ "redirect");
 * - external links with the guarded public fetcher (private addresses refused on every hop), GET, small byte cap.
 * 404/410 and missing site paths are "broken"; 401/403/429 are "blocked" (sites refusing checkers, not broken);
 * timeouts/5xx/DNS are "error" and count as broken after two failed runs in a row.
 * Fixes are one click on SEO › Internal linking: "Replace URL" or "Unlink", as a link_fix draft change that the
 * clicking admin approves at once (approveDraft: same verify-and-rollback path as any draft).
 */
export type LinkStatus = "ok" | "redirect" | "broken" | "blocked" | "error" | "skipped";
export type Occurrence = { kind: "post" | "page"; id: string; title: string; path: string };

/** App routes that exist without a post or page row. */
const APP_ROUTES = [/^\/$/, /^\/(blog|news|projects)(\/page\/\d+)?$/, /^\/(authors|category|tag)\/[^/]+(\/page\/\d+)?$/, /^\/(search|feed\.xml|sitemap\.xml|news-sitemap\.xml|robots\.txt|contact|python-practice)(\/.*)?$/];
const ASSET = /^\/(media|images|_next)\//;

/** Normalise a link: own-site absolute URLs become paths; fragments dropped; null for things we don't check. */
export function normalizeLink(raw: string, origin = siteOrigin().origin): { key: string; internal: boolean } | null {
  const u = raw.trim();
  if (!u || u.startsWith("#") || /^(mailto|tel|data|javascript):/i.test(u)) return null;
  if (u.startsWith("/") && !u.startsWith("//")) return { key: u.split("#")[0]!.replace(/(.)\/+$/, "$1") || "/", internal: true };
  let url: URL;
  try {
    url = new URL(u.startsWith("//") ? `https:${u}` : u);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const own = new URL(origin).hostname.replace(/^www\./, "");
  if (url.hostname.replace(/^www\./, "") === own) return { key: (url.pathname.replace(/(.)\/+$/, "$1") || "/") + url.search, internal: true };
  url.hash = "";
  return { key: url.toString(), internal: false };
}

/** Every checkable link in published content → where it appears (raw spellings kept for fixes). */
export async function collectLinks(db: Db, origin?: string): Promise<Map<string, { internal: boolean; raw: Set<string>; where: Occurrence[] }>> {
  const docs = rowsOf<{ kind: "post" | "page"; id: string; title: string; path: string; body: string }>(
    await db.execute(sql`
      select 'post' as kind, id::text, title, '/' || collection || '/' || slug as path, body from post where deleted_at is null and status = 'published'
      union all select 'page', slug, title, '/' || slug, body from page where deleted_at is null`),
  );
  const out = new Map<string, { internal: boolean; raw: Set<string>; where: Occurrence[] }>();
  for (const d of docs) {
    for (const raw of new Set(linksIn(d.body ?? ""))) {
      const n = normalizeLink(raw, origin);
      if (!n) continue;
      const e = out.get(n.key) ?? { internal: n.internal, raw: new Set<string>(), where: [] };
      e.raw.add(raw);
      if (!e.where.some((w) => w.kind === d.kind && w.id === d.id)) e.where.push({ kind: d.kind, id: d.id, title: d.title, path: d.path });
      out.set(n.key, e);
    }
  }
  return out;
}

async function checkInternal(db: Db, key: string): Promise<{ status: LinkStatus; finalUrl?: string; httpStatus?: number }> {
  const path = key.split("?")[0]!;
  if (ASSET.test(path)) return { status: "skipped" };
  if (APP_ROUTES.some((r) => r.test(path))) return { status: "ok" };
  const [hit] = rowsOf<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from (
        select '/' || collection || '/' || slug as p from post where deleted_at is null and status = 'published'
        union all select '/' || slug from page where deleted_at is null
      ) x where p = ${path}`),
  );
  if (Number(hit?.n)) return { status: "ok" };
  const [r] = rowsOf<{ to_path: string }>(await db.execute(sql`select to_path from redirect where from_path = ${path}`));
  if (r) return { status: "redirect", finalUrl: r.to_path, httpStatus: 308 };
  return { status: "broken", httpStatus: 404 };
}

async function checkExternal(url: string, fetcher: PageFetcher): Promise<{ status: LinkStatus; httpStatus?: number; finalUrl?: string; error?: string }> {
  const r = await fetcher(url).catch((e: Error) => ({ status: 0, finalUrl: url, error: e.message }) as { status: number; finalUrl: string; error?: string });
  if (r.error && !r.status) return { status: "error", error: r.error.slice(0, 300) };
  if (r.status >= 200 && r.status < 300) return r.finalUrl && r.finalUrl !== url ? { status: "redirect", httpStatus: r.status, finalUrl: r.finalUrl } : { status: "ok", httpStatus: r.status };
  if (r.status === 404 || r.status === 410) return { status: "broken", httpStatus: r.status };
  if ([401, 403, 429, 999].includes(r.status)) return { status: "blocked", httpStatus: r.status };
  return { status: "error", httpStatus: r.status, error: r.error?.slice(0, 300) ?? `HTTP ${r.status}` };
}

export type CheckResult = { checked: number; internal: number; external: number; broken: number; deferred: number };

export async function runLinkCheck(db: Db, s: SeoSettings, now = new Date(), fetcher?: PageFetcher): Promise<CheckResult> {
  const out: CheckResult = { checked: 0, internal: 0, external: 0, broken: 0, deferred: 0 };
  if (!s.links.check.enabled) return out;
  const links = await collectLinks(db);
  const prev = new Map(rowsOf<{ url: string; status: string; failures: number; checked_at: string }>(await db.execute(sql`select url, status, failures, checked_at from seo_link_checks`)).map((r) => [r.url, r]));
  const fetch = fetcher ?? publicFetcher({ timeoutMs: 10_000, maxBytes: 64 * 1024, maxRedirects: 5 });
  const fresh = (u: string) => {
    const p = prev.get(u);
    return p && ["ok", "redirect", "blocked"].includes(p.status) && now.getTime() - new Date(p.checked_at).getTime() < s.links.check.recheckDays * 86_400_000;
  };
  const externalDue = [...links.entries()].filter(([u, e]) => !e.internal && !fresh(u)).sort(([a], [b]) => Number(prev.has(a)) - Number(prev.has(b)));
  out.deferred = Math.max(0, externalDue.length - s.links.check.maxExternalPerRun);
  const due = new Set(externalDue.slice(0, s.links.check.maxExternalPerRun).map(([u]) => u));
  for (const [url, e] of links) {
    if (!e.internal && !due.has(url)) continue;
    const r = e.internal ? await checkInternal(db, url) : await checkExternal(url, fetch);
    const failures = r.status === "error" ? (prev.get(url)?.failures ?? 0) + 1 : 0;
    await db.execute(sql`
      insert into seo_link_checks (url, internal, status, http_status, final_url, error, failures, checked_at)
      values (${url}, ${e.internal}, ${r.status}, ${r.httpStatus ?? null}, ${r.finalUrl ?? null}, ${"error" in r ? (r.error ?? null) : null}, ${failures}, ${now.toISOString()})
      on conflict (url) do update set internal = excluded.internal, status = excluded.status, http_status = excluded.http_status, final_url = excluded.final_url,
        error = excluded.error, failures = excluded.failures, checked_at = excluded.checked_at`);
    out.checked++;
    if (e.internal) out.internal++;
    else out.external++;
    if (r.status === "broken" || (r.status === "error" && failures >= 2)) out.broken++;
  }
  // Links no longer in any published content are forgotten.
  const keep = [...links.keys()];
  await db.execute(sql`delete from seo_link_checks where not (url = any(${`{${keep.map((u) => `"${u.replace(/(["\\])/g, "\\$1")}"`).join(",")}}`}::text[]))`);
  log.info("seo link check", { operation: "seo_link_check", outcome: "succeeded", checked: out.checked, broken: out.broken });
  return out;
}

export type LinkProblem = { url: string; internal: boolean; status: LinkStatus; httpStatus: number | null; finalUrl: string | null; error: string | null; failures: number; checkedAt: string; where: Occurrence[] };

/** Broken links (and moved ones) with the content they appear in, for SEO › Internal linking. */
export async function linkProblems(db: Db): Promise<{ broken: LinkProblem[]; redirected: LinkProblem[]; lastRun: string | null; totals: Record<string, number> }> {
  const rows = rowsOf<{ url: string; internal: boolean; status: LinkStatus; http_status: number | null; final_url: string | null; error: string | null; failures: number; checked_at: string }>(
    await db.execute(sql`select * from seo_link_checks order by checked_at desc`),
  );
  const links = await collectLinks(db);
  const shape = (r: (typeof rows)[number]): LinkProblem => ({ url: r.url, internal: r.internal, status: r.status, httpStatus: r.http_status, finalUrl: r.final_url, error: r.error, failures: Number(r.failures), checkedAt: new Date(r.checked_at).toISOString(), where: links.get(r.url)?.where ?? [] });
  const totals: Record<string, number> = {};
  for (const r of rows) totals[r.status] = (totals[r.status] ?? 0) + 1;
  return {
    broken: rows.filter((r) => r.status === "broken" || (r.status === "error" && Number(r.failures) >= 2)).map(shape).filter((p) => p.where.length),
    redirected: rows.filter((r) => r.status === "redirect").map(shape).filter((p) => p.where.length),
    lastRun: rows[0] ? new Date(rows[0].checked_at).toISOString() : null,
    totals,
  };
}

/**
 * One-click fix in one published post: re-point (`replacement`) or unlink (null) every link to `url`, as a link_fix
 * draft that `actor` (the admin who clicked) approves at once. Refused while the post has another open SEO draft.
 */
export async function fixBrokenLink(db: Db, s: SeoSettings, actor: Actor, postId: string, url: string, replacement: string | null) {
  if (replacement !== null && !/^(\/(?!\/)\S*|https:\/\/\S+)$/.test(replacement)) throw new DraftError("Use a site path like /blog/post or an https:// URL.", 400);
  if (await openDraft(db, postId)) throw new DraftError("This article has an open SEO draft. Finish or reject it first, or fix the link in the editor.", 409);
  const base = await loadBase(db, postId);
  if (base.status !== "published") throw new DraftError("Only published articles can be fixed here.", 409);
  const raws = new Set(linksIn(base.body).filter((r) => normalizeLink(r)?.key === url));
  if (!raws.size) throw new DraftError("That link is no longer in the article.", 409);
  const changes: Change[] = [];
  for (const b of blocksOf(base.body)) {
    // The spelling of the broken link used in this block (one per change: the validator re-derives "after" from it).
    const raw = [...raws].find((r) => rewriteLink(b.source, r, replacement) !== b.source);
    if (!raw) continue;
    const linkRe = new RegExp(`(?<!!)\\[[^\\]]*\\]\\(\\s*<?${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>?(\\s+"[^"]*")?\\s*\\)`, "g");
    const hits = b.source.match(linkRe) ?? [];
    // Fix the smallest unique piece: the link itself when it occurs once in the block, else the whole block.
    const before = hits.length === 1 && b.source.split(hits[0]!).length === 2 ? hits[0]! : b.source;
    changes.push({ id: "c0", type: "link_fix", location: { blockId: b.id, headingPath: b.headingPath || null, field: null }, before, after: rewriteLink(before, raw, replacement), rationale: replacement ? `Broken link ${raw} → ${replacement}.` : `Broken link ${raw} unlinked (text kept).`, evidenceRef: [`link_check:${url}`], sourceUrls: [replacement ?? ""], origin: "rules", decision: "accepted", edited: null, flags: [], target: raw });
  }
  if (!changes.length) throw new DraftError("Only markdown links can be fixed here; edit this one in the editor.", 409);
  const all = renumber(changes);
  const ctx = { ...(await validationContext(db, s, postId, ["internal_links"])), externalAllow: new Set<string>() };
  const v = validateChangeSet(base, all, ctx, diffWords);
  if (v.errors.length) throw new DraftError(`This fix can't be applied automatically (${v.errors[0]}). Edit the link in the editor.`, 409);
  const draft = await reserveDraft(db, postId, base, "link_fix");
  await db.execute(sql`
    update seo_drafts set status = 'ready_for_review', changes = ${JSON.stringify(all)}::jsonb, flags = '[]'::jsonb, categories = '{internal_links}'::text[],
      summary = ${replacement ? `Fix broken link: ${url} → ${replacement}` : `Unlink broken link: ${url}`}, failure_reason = null, generated_at = now(), updated_at = now()
    where id = ${draft.id}`);
  try {
    return { draftId: draft.id, changes: all.length, ...(await approveDraft(draft.id, actor)) };
  } catch (e) {
    await db.execute(sql`update seo_drafts set status = 'superseded', failure_reason = ${`Link fix not published: ${(e as Error).message}`.slice(0, 1000)}, updated_at = now() where id = ${draft.id}`);
    throw e;
  }
}
