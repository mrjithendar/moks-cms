import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@/db";
import { rowsOf } from "@/db/rows";
import type { Actor } from "@/lib/posts";
import { freshDb } from "./db-helpers";
import { settingsInput } from "./seo-fixtures";
import { ARTICLE_BODY, fakeAnthropic, output, seedArticle, seedRecommendation } from "./seo-v2-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const drafts = await import("@/lib/seo-intel/drafts");
const pub = await import("@/lib/seo-intel/publish");
const { saveSeoSettings } = await import("@/lib/seo-intel/settings");
const { saveAutosave } = await import("@/lib/revisions");
const { updatePost } = await import("@/lib/posts");

const admin: Actor = { id: "admin", role: "admin", label: "admin@example.com" };
const BODY = ARTICLE_BODY.replace("![](/media/diagram.png)\n\n", ""); // the CMS requires uploaded media for images
const TITLE = "Ingress and TLS on Kubernetes: a worked example";

let db: Db;
let articleId: string;
const env = { ...process.env };

beforeEach(async () => {
  db = await freshDb();
  await db.insert(schema.user).values([{ id: "admin", name: "Admin", email: "admin@example.com", role: "admin" }, { id: "author", name: "Author", email: "author@example.com", role: "author" }]);
  await db.insert(schema.authorProfile).values({ userId: "admin", slug: "admin", displayName: "Admin" });
  await saveSeoSettings(settingsInput(), "admin");
  articleId = (await seedArticle(db, { body: BODY })).id;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-not-real";
});
afterEach(() => {
  process.env = { ...env };
});

/** A ready draft with: c1 title, c2 paragraph edit (body), c3 meta. */
async function readyDraft(extra: Record<string, unknown>[] = []) {
  await seedRecommendation(db, articleId, "low_ctr");
  await seedRecommendation(db, articleId, "striking_distance");
  const api = fakeAnthropic({
    answers: [
      output([
        { type: "title", before: TITLE, after: "Kubernetes ingress TLS with cert-manager" },
        { type: "paragraph_edit", block_id: "b2", before: "Install it with Helm.", after: "Install the controller with Helm." },
        { type: "meta_description", before: "How to terminate TLS at a Kubernetes ingress controller with cert-manager, with a worked example and the failure modes to check first.", after: "Terminate TLS at a Kubernetes ingress controller with cert-manager: a worked Helm setup, renewal, and the DNS and HTTP-01 failures to check first." },
        ...extra,
      ]),
    ],
  });
  const r = await drafts.generateDraft(articleId, { fetchImpl: api.fetchImpl });
  expect(r.status).toBe("ready_for_review");
  return r.draftId!;
}

const post = async () => (await db.select().from(schema.post))[0]!;
const jobs = async (kind: string) => rowsOf<{ payload: Record<string, unknown>; run_at: string }>(await db.execute(sql`select payload, run_at::text from job where kind = ${kind} order by created_at`));
const okPage = (title: string, url = "https://jithendar.com/blog/ingress-tls") => ({ url, finalUrl: url, status: 200, headers: {}, redirects: [], truncated: false, body: `<html><head><title>${title}</title><link rel="canonical" href="${url}"><script type="application/ld+json">[{"@context":"https://schema.org","@type":"TechArticle","headline":"x"}]</script></head><body></body></html>` });

describe("review → approve → publish → verify → submit → rollback", () => {
  it("publishes only accepted changes (one edited, one rejected) through the CMS update path", async () => {
    const id = await readyDraft();
    const before = await post();
    await drafts.decideChange(id, "c1", "accepted", "Kubernetes ingress TLS, step by step");
    await drafts.decideChange(id, "c2", "accepted");
    await drafts.decideChange(id, "c3", "rejected");
    const r = await pub.approveDraft(id, admin, { now: new Date("2026-11-10T10:00:00Z") });
    expect(r).toMatchObject({ status: "published", substantive: true });
    const after = await post();
    expect(after.version).toBe(before.version + 1);
    expect(after.seoTitle).toBe("Kubernetes ingress TLS, step by step"); // my edit, not Claude's
    expect(after.body).toContain("Install the controller with Helm.");
    expect(after.seoDescription).toBe(before.seoDescription); // rejected change left out
    expect(after.slug).toBe(before.slug);
    expect(after.updatedAt?.toISOString()).toBe("2026-11-10T10:00:00.000Z"); // body changed → lastmod moves
    const [rev] = rowsOf<{ reason: string; version: number }>(await db.execute(sql`select reason, version from revision where entity_id = ${articleId} order by created_at desc limit 1`));
    expect(rev).toMatchObject({ reason: "seo-draft", version: after.version });
    const d = (await drafts.getDraft(id))!;
    expect(d.status).toBe("published");
    expect(d.baseline_metrics).toMatchObject({ source: "gsc" });
    const recs = rowsOf<{ implementation_status: string }>(await db.execute(sql`select implementation_status from seo_recommendations`));
    expect(recs.every((x) => x.implementation_status === "implemented")).toBe(true);
    expect((await jobs("seo_verify"))[0]!.payload).toMatchObject({ draftId: id, attempt: 1, reason: "publish" });
    const audits = rowsOf<{ action: string }>(await db.execute(sql`select action from audit_log where action like 'seo.draft.%' or action = 'post.update'`)).map((a) => a.action);
    expect(audits).toEqual(expect.arrayContaining(["post.update", "seo.draft.publish"]));
  });

  it("metadata-only drafts keep updatedAt (sitemap lastmod) unchanged", async () => {
    const id = await readyDraft();
    const before = await post();
    await drafts.decideChange(id, "c1", "accepted");
    await drafts.decideChange(id, "c2", "rejected");
    const r = await pub.approveDraft(id, admin);
    expect(r).toMatchObject({ status: "published", substantive: false });
    expect((await post()).updatedAt).toEqual(before.updatedAt);
  });

  it("refuses unsafe approvals: nothing accepted, blocking flags, stale base, unsaved editor copy, non-admin", async () => {
    const id = await readyDraft();
    await expect(pub.approveDraft(id, admin)).rejects.toThrow(/Accept at least one/);
    await drafts.decideChange(id, "c1", "accepted");
    await expect(pub.approveDraft(id, { ...admin, role: "author" })).rejects.toThrow(/Only admins/);
    await saveAutosave(admin, "post", articleId, 1, { title: "wip" });
    await expect(pub.approveDraft(id, admin)).rejects.toThrow(/unsaved editor changes/);
    await db.execute(sql`delete from autosave`);
    await updatePost(admin, articleId, { description: "Edited by a person in the meantime, which is long enough to be valid for the schema checks here." });
    await expect(pub.approveDraft(id, admin)).rejects.toThrow(/edited after this draft/);
  });

  it("a duplicate search title blocks approval of that change until edited or rejected", async () => {
    await seedArticle(db, { slug: "other", title: "Other", seoTitle: "Kubernetes ingress TLS with cert-manager" });
    const id = await readyDraft();
    await drafts.decideChange(id, "c1", "accepted");
    await expect(pub.approveDraft(id, admin)).rejects.toThrow(/Fix or reject c1/);
    await drafts.decideChange(id, "c1", "accepted", "Ingress TLS on Kubernetes with cert-manager");
    await expect(pub.approveDraft(id, admin)).resolves.toMatchObject({ status: "published" });
  });

  it("publish later: scheduled, then published by the tick as the approving admin", async () => {
    const id = await readyDraft();
    await drafts.decideChange(id, "c2", "accepted");
    const r = await pub.approveDraft(id, admin, { publishAt: "2026-11-12T08:00:00+05:30", now: new Date("2026-11-10T00:00:00Z") });
    expect(r.status).toBe("scheduled");
    expect(await pub.publishDueDrafts(new Date("2026-11-11T00:00:00Z"))).toBe(0);
    expect(await pub.publishDueDrafts(new Date("2026-11-12T03:00:00Z"))).toBe(1);
    expect((await post()).body).toContain("Install the controller with Helm.");
    expect((await drafts.getDraft(id))!.status).toBe("published");
  });

  it("a scheduled draft whose approver lost the admin role is not published", async () => {
    const id = await readyDraft();
    await drafts.decideChange(id, "c2", "accepted");
    await pub.approveDraft(id, admin, { publishAt: "2030-01-01T00:00:00Z" });
    await db.execute(sql`update "user" set role = 'author' where id = 'admin'`);
    expect(await pub.publishDueDrafts(new Date("2030-01-02T00:00:00Z"))).toBe(0);
    expect((await drafts.getDraft(id))!.status).toBe("ready_for_review");
  });

  it("verification passes → submission runs; fails 3× → no submission, alert, rollback offered", async () => {
    const id = await readyDraft();
    await drafts.decideChange(id, "c1", "accepted");
    await pub.approveDraft(id, admin);
    const submit = vi.fn(async () => {});
    const good = await pub.verifyDraft(id, 1, "publish", { fetcher: async () => okPage("Kubernetes ingress TLS with cert-manager | Jithendar"), submit });
    expect(good.state).toBe("passed");
    expect(submit).toHaveBeenCalledTimes(1);

    const submit2 = vi.fn(async () => {});
    const bad = async () => ({ ...okPage("Old title"), status: 200 });
    expect((await pub.verifyDraft(id, 1, "publish", { fetcher: bad, submit: submit2 })).state).toBe("retrying");
    expect((await jobs("seo_verify")).map((j) => j.payload.attempt)).toEqual([1, 2]);
    expect((await pub.verifyDraft(id, 3, "publish", { fetcher: bad, submit: submit2 })).state).toBe("failed");
    expect(submit2).not.toHaveBeenCalled();
    const d = (await drafts.getDraft(id))!;
    expect((d.verification as { checks: { key: string; ok: boolean }[] }).checks.find((c) => c.key === "title")!.ok).toBe(false);
    expect(rowsOf(await db.execute(sql`select 1 from audit_log where action = 'seo.draft.verification_failed'`))).toHaveLength(1);
  });

  it("verifyHtml checks status, self-canonical, noindex (production only), title and JSON-LD", () => {
    const url = "https://jithendar.com/blog/x";
    const ok = pub.verifyHtml(okPage("T", url).body, 200, {}, { url, title: "T" }, true);
    expect(ok.every((c) => c.ok)).toBe(true);
    const bad = pub.verifyHtml('<title>T</title><link rel="canonical" href="https://jithendar.com/other"><meta name="robots" content="noindex"><script type="application/ld+json">{bad</script>', 404, {}, { url, title: "T" }, true);
    expect(bad.filter((c) => !c.ok).map((c) => c.key)).toEqual(["status", "canonical", "indexable", "json_ld"]);
    expect(pub.verifyHtml(okPage("T", url).body, 200, { "x-robots-tag": "noindex" }, { url, title: "T" }, false).find((c) => c.key === "indexable")!.ok).toBe(true);
  });

  it("rollback restores the previous revision as a new revision and re-verifies", async () => {
    const id = await readyDraft();
    const original = await post();
    await drafts.decideChange(id, "c1", "accepted");
    await drafts.decideChange(id, "c2", "accepted");
    await pub.approveDraft(id, admin);
    const r = await pub.rollbackDraft(id, admin);
    expect(r.status).toBe("rolled_back");
    const now = await post();
    expect(now.body).toBe(original.body);
    expect(now.seoTitle).toBe(original.seoTitle);
    expect(now.updatedAt).toEqual(original.updatedAt);
    expect(now.version).toBe(original.version + 2); // history is never rewritten
    expect((await jobs("seo_verify")).map((j) => j.payload.reason)).toEqual(["publish", "rollback"]);
    expect(rowsOf<{ implementation_status: string }>(await db.execute(sql`select implementation_status from seo_recommendations`)).every((x) => x.implementation_status === "not_started")).toBe(true);
    await expect(pub.rollbackDraft(id, admin)).rejects.toThrow(/Only published/);
  });

  it("rollback is refused if the article was edited after publishing", async () => {
    const id = await readyDraft();
    await drafts.decideChange(id, "c1", "accepted");
    await pub.approveDraft(id, admin);
    await updatePost(admin, articleId, { description: "Edited by a person after the SEO change went live; long enough for the schema." });
    await expect(pub.rollbackDraft(id, admin)).rejects.toThrow(/revision history/);
  });

  it("reject stores the reason; the queue lists open drafts with counts and breakdown; news tab filters", async () => {
    const id = await readyDraft();
    const q = await drafts.reviewQueue({ collection: "blog" });
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ id, changeCount: 3, breakdown: "1 edit · 1 title · 1 meta", band: "high" });
    expect(await drafts.reviewQueue({ collection: "news" })).toHaveLength(0);
    expect(await drafts.reviewQueue({ type: "internal_link" })).toHaveLength(0);
    await drafts.rejectDraft(id, admin, "Titles should not start with the year");
    const [d] = rowsOf<{ status: string; reject_reason: string }>(await db.execute(sql`select status, reject_reason from seo_drafts where id = ${id}`));
    expect(d).toMatchObject({ status: "rejected", reject_reason: "Titles should not start with the year" });
    expect(await drafts.reviewQueue({})).toHaveLength(0);
  });

  it("captures before/after outcomes at +28 and +56 days", async () => {
    const id = await readyDraft();
    await drafts.decideChange(id, "c1", "accepted");
    await pub.approveDraft(id, admin);
    await db.execute(sql`update seo_drafts set decided_at = '2026-09-01T00:00:00Z' where id = ${id}`);
    expect(await pub.captureDraftOutcomes(new Date("2026-10-05T00:00:00Z"))).toBe(1);
    expect(await pub.captureDraftOutcomes(new Date("2026-11-01T00:00:00Z"))).toBe(1);
    const [d] = rowsOf<{ metrics_28d: unknown; metrics_56d: unknown }>(await db.execute(sql`select metrics_28d, metrics_56d from seo_drafts where id = ${id}`));
    expect(d!.metrics_28d).toMatchObject({ start: "2026-09-02", end: "2026-09-29" });
    expect(d!.metrics_56d).toMatchObject({ end: "2026-10-27" });
  });
});
