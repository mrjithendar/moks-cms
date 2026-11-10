import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { rowsOf } from "@/db/rows";
import { createItem } from "../seo-intel/calendar";
import { clusterQueries } from "../seo-intel/keywords";
import { safeQueries } from "../seo-intel/llm";

/**
 * "Asked on site": Ask-the-Blog questions the site could not answer (seo_ask_gaps), clustered weekly with the same
 * token-set clustering as Search Console queries (keywords.ts), shown in Keyword opportunities › Content gaps under
 * their own source label, never mixed into GSC numbers.
 */
export type AskGapCluster = { clusterId: number; label: string; asked: number; questions: { id: number; question: string; asked: number }[]; lastSeen: string; status: string; calendarId: string | null };

/** Weekly (drafts_weekly handler): (re)cluster open gaps; the label is the most-asked question's normalised form. */
export async function clusterAskGaps(threshold = 0.5): Promise<number> {
  const db = await getDb();
  const rows = rowsOf<{ id: number; normalized: string; asked: number }>(await db.execute(sql`select id, normalized, asked from seo_ask_gaps where status = 'open'`));
  if (!rows.length) return 0;
  const clusters = clusterQueries(rows.map((r) => ({ query: r.normalized, impressions: Number(r.asked) })), threshold);
  for (const r of rows) {
    const c = clusters.get(r.normalized)!;
    await db.execute(sql`update seo_ask_gaps set cluster_id = ${c.id}, cluster_label = ${c.parent.slice(0, 200)} where id = ${r.id}`);
  }
  return rows.length;
}

export async function askGapClusters(limit = 30): Promise<AskGapCluster[]> {
  const db = await getDb();
  const rows = rowsOf<{ id: number; sample_question: string; normalized: string; asked: number; last_seen: string; status: string; calendar_id: string | null; cluster_id: number | null; cluster_label: string | null }>(
    await db.execute(sql`select id, sample_question, normalized, asked, last_seen::text, status, calendar_id, cluster_id, cluster_label from seo_ask_gaps where status in ('open', 'sent') order by asked desc, last_seen desc limit 500`),
  );
  const safe = new Set(safeQueries(rows.map((r) => r.sample_question)));
  const by = new Map<string, AskGapCluster>();
  for (const r of rows) {
    if (!safe.has(r.sample_question)) continue; // never surface a question that looks like it contains personal data
    const key = r.cluster_id === null ? `q:${r.id}` : `c:${r.cluster_id}`;
    const c = by.get(key) ?? { clusterId: r.cluster_id ?? -r.id, label: r.cluster_label ?? r.normalized, asked: 0, questions: [], lastSeen: r.last_seen, status: r.status, calendarId: r.calendar_id };
    c.asked += Number(r.asked);
    c.questions.push({ id: Number(r.id), question: r.sample_question, asked: Number(r.asked) });
    if (r.last_seen > c.lastSeen) c.lastSeen = r.last_seen;
    if (r.status === "sent") c.status = "sent";
    c.calendarId ??= r.calendar_id;
    by.set(key, c);
  }
  return [...by.values()].sort((a, b) => b.asked - a.asked).slice(0, limit);
}

/** Send a cluster (by any member id) to the editorial calendar as an idea; marks every member "sent". */
export async function sendGapToCalendar(gapId: number): Promise<{ calendarId: string }> {
  const db = await getDb();
  const [g] = rowsOf<{ cluster_id: number | null; cluster_label: string | null; sample_question: string; calendar_id: string | null }>(await db.execute(sql`select cluster_id, cluster_label, sample_question, calendar_id from seo_ask_gaps where id = ${gapId}`));
  if (!g) throw Object.assign(new Error("Question not found."), { status: 404 });
  if (g.calendar_id) return { calendarId: g.calendar_id };
  const members = rowsOf<{ id: number; sample_question: string; asked: number }>(
    await db.execute(g.cluster_id === null ? sql`select id, sample_question, asked from seo_ask_gaps where id = ${gapId}` : sql`select id, sample_question, asked from seo_ask_gaps where cluster_id = ${g.cluster_id} and status = 'open'`),
  );
  const asked = members.reduce((s, m) => s + Number(m.asked), 0);
  const title = g.sample_question.replace(/\?+$/, "").slice(0, 180);
  const calendarId = await createItem({ title: title.length >= 5 ? title : `Reader question: ${title}`, notes: `Asked on site (Ask the Blog) ${asked} time(s), no article answered it.\n\n${members.slice(0, 10).map((m) => `- ${m.sample_question} (${m.asked}×)`).join("\n")}`.slice(0, 2000) });
  await db.execute(sql`update seo_ask_gaps set status = 'sent', calendar_id = ${calendarId} where id = any(${`{${members.map((m) => m.id).join(",")}}`}::bigint[])`);
  return { calendarId };
}

export async function ignoreGap(gapId: number): Promise<void> {
  const db = await getDb();
  await db.execute(sql`update seo_ask_gaps set status = 'ignored' where id = ${gapId} or (cluster_id is not null and cluster_id = (select cluster_id from seo_ask_gaps where id = ${gapId}) and status = 'open')`);
}
