import { fmt, signedPct } from "./format";
import type { Chart, Finding, Kpi, SiteReport, TableBlock } from "./types";

/**
 * A report as HTML (one renderer for the downloadable file and the in-app viewer), CSV and JSON (D-102).
 *
 * Safety: every value is escaped here (titles, error text, the analyst's words are data, never markup); the only markup
 * is this file's. No script, no external resource: charts are inline SVG built from numbers. The standalone file also
 * carries a Content-Security-Policy that allows nothing but its own inline styles, so even an escaping bug could not
 * load or run anything. Sections are <details>, so they collapse without JavaScript.
 */
const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]!);
const n = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
const SERIES = ["#3b82f6", "#14b8a6", "#f59e0b", "#ef4444", "#8b5cf6", "#64748b"];
const SEV_LABEL: Record<string, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const STATUS_LABEL: Record<string, string> = { confirmed: "Confirmed", probable: "Probable cause", investigate: "Needs investigation" };
const SOURCE_LABEL: Record<string, string> = { ok: "Available", empty: "No data in range", unavailable: "Not available", error: "Failed", not_selected: "Not selected" };

function delta(k: Kpi): string {
  if (k.change === null || k.change === undefined) return k.previous === null || k.previous === undefined ? "" : `<span class="mr-delta">previous ${esc(fmt(k.previous, k.format))}</span>`;
  const good = k.better ? (k.change > 0) === (k.better === "up") : null;
  const cls = Math.abs(k.change) < 1e-9 || good === null ? "mr-flat" : good ? "mr-good" : "mr-bad";
  return `<span class="mr-delta ${cls}">${k.change > 0 ? "▲" : k.change < 0 ? "▼" : "→"} ${esc(signedPct(k.change))}</span>`;
}

function kpis(list: Kpi[]): string {
  if (!list.length) return "";
  return `<div class="mr-kpis">${list.map((k) => `<div class="mr-kpi" id="${esc(k.id)}"><div class="mr-kpi-label">${esc(k.label)}</div><div class="mr-kpi-value">${esc(fmt(k.value, k.format))}</div>${delta(k)}${k.note ? `<div class="mr-note">${esc(k.note)}</div>` : ""}</div>`).join("")}</div>`;
}

function lineChart(c: Chart): string {
  const series = c.series.filter((s) => s.points.length);
  const labels = series[0]?.points.map((p) => p[0]) ?? [];
  if (labels.length < 2) return "";
  const W = 720, H = 220, L = 48, R = 12, T = 28, B = 28;
  const money = c.unit === "usd";
  const peak = Math.max(...series.flatMap((s) => s.points.map((p) => p[1])), 0);
  // Ticks at round values: whole numbers for small counts (never "1, 1, 0"), else a 1-2-5 step.
  const raw = money ? Math.max(peak, 0.01) / 4 : Math.max(1, Math.ceil(Math.max(peak, 1) / 4));
  const mag = 10 ** Math.floor(Math.log10(raw));
  const tick = [1, 2, 5, 10].map((m) => m * mag).find((t) => t >= raw)!;
  const max = Math.max(tick, Math.ceil((peak || tick) / tick) * tick);
  const ticks = Array.from({ length: Math.round(max / tick) + 1 }, (_, i) => i * tick);
  const x = (i: number) => L + (i * (W - L - R)) / (labels.length - 1);
  const y = (v: number) => H - B - (v / max) * (H - T - B);
  const step = Math.max(1, Math.ceil(labels.length / 8));
  // The last label always shows; a step label too close to it would overlap ("11-231-24"), so it is skipped.
  const showLabel = (i: number) => i === labels.length - 1 || (i % step === 0 && labels.length - 1 - i >= Math.ceil(step / 2));
  return `<figure class="mr-chart" id="${esc(c.id)}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.title)}"><text x="${L}" y="16" class="mr-svg-title">${esc(c.title)}</text>${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${n(y(t))}" y2="${n(y(t))}" class="mr-grid"/><text x="${L - 6}" y="${n(y(t)) + 4}" text-anchor="end" class="mr-axis">${esc(money ? `$${t.toFixed(tick < 1 ? 2 : 0)}` : t.toLocaleString("en-US"))}</text>`).join("")}${labels.map((l, i) => (showLabel(i) ? `<text x="${n(x(i))}" y="${H - 8}" text-anchor="middle" class="mr-axis">${esc(l.length === 10 && l[4] === "-" ? l.slice(5) : l.slice(0, 8))}</text>` : "")).join("")}${series.map((s, si) => `<polyline fill="none" stroke="${SERIES[si % SERIES.length]}" stroke-width="${si ? 1.6 : 2.4}" points="${s.points.map((p, i) => `${n(x(i))},${n(y(p[1]))}`).join(" ")}"/>`).join("")}</svg>${series.length > 1 ? `<figcaption class="mr-legend">${series.map((s, si) => `<span><i style="background:${SERIES[si % SERIES.length]}"></i>${esc(s.name)}</span>`).join("")}</figcaption>` : ""}</figure>`;
}

function barChart(c: Chart): string {
  const pts = (c.series[0]?.points ?? []).filter((p) => p[1] > 0).slice(0, 10);
  if (!pts.length) return "";
  const max = Math.max(...pts.map((p) => p[1]));
  const money = c.unit === "usd";
  return `<figure class="mr-chart" id="${esc(c.id)}"><div class="mr-svg-title">${esc(c.title)}</div><div class="mr-bars">${pts.map((p) => `<div class="mr-bar-row"><span class="mr-bar-label">${esc(p[0])}</span><span class="mr-bar-track"><span class="mr-bar" style="width:${n((p[1] / max) * 100)}%"></span></span><span class="mr-bar-value">${esc(money ? fmt(p[1], "usd") : fmt(p[1], "int"))}</span></div>`).join("")}</div></figure>`;
}

const chart = (c: Chart) => (c.type === "bar" ? barChart(c) : lineChart(c));

function table(t: TableBlock): string {
  if (!t.rows.length) return "";
  const numeric = (f?: string) => !!f && f !== "text";
  return `<div class="mr-table-wrap" id="${esc(t.id)}"><table class="mr-table"><caption>${esc(t.title)} <span class="mr-id">${esc(t.id)}</span></caption><thead><tr>${t.columns.map((c) => `<th scope="col"${numeric(c.format) ? ' class="mr-num"' : ""}>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${t.rows.map((r) => `<tr>${t.columns.map((c) => `<td${numeric(c.format) ? ' class="mr-num"' : ""}>${esc(fmt(r[c.key] ?? null, c.format))}</td>`).join("")}</tr>`).join("")}</tbody></table>${t.note ? `<p class="mr-note">${esc(t.note)}</p>` : ""}</div>`;
}

const ev = (ids: string[] | undefined) => (ids?.length ? `<span class="mr-ev">Evidence: ${ids.map((i) => `<a href="#${esc(i)}">${esc(i)}</a>`).join(", ")}</span>` : "");
const badge = (cls: string, text: string) => `<span class="mr-badge mr-${esc(cls)}">${esc(text)}</span>`;
const section = (id: string, title: string, body: string, open = true) => (body ? `<details class="mr-section" id="${esc(id)}"${open ? " open" : ""}><summary><h2>${esc(title)}</h2></summary>${body}</details>` : "");

function finding(f: Finding): string {
  return `<article class="mr-card mr-sev-${esc(f.severity)}" id="${esc(f.id)}"><header>${badge(f.severity, SEV_LABEL[f.severity] ?? f.severity)} <strong>${esc(f.title)}</strong>${f.confirmed ? ` <span class="mr-muted">· confirmed in the data</span>` : ""}</header><p>${esc(f.detail)}</p>${f.impact ? `<p class="mr-muted"><b>Impact:</b> ${esc(f.impact)}</p>` : ""}<footer class="mr-muted">${esc(f.id)} · ${esc(f.category)} ${ev(f.evidence)}${f.owner ? ` · Owner: ${esc(f.owner)}` : ""}</footer></article>`;
}

/** The report body (the viewer puts it in the page; the file wraps it in a document). */
export function renderHtmlBody(r: SiteReport): string {
  const a = r.analysis ?? null;
  const check = r.analysisCheck ?? null;
  const unavailable = r.sources.filter((s) => s.status === "unavailable" || s.status === "error");
  const toc = [
    ["summary", "Executive summary"],
    ["wrong", "What is going wrong"],
    ...(a?.root_causes?.length ? [["causes", "Root cause analysis"]] : []),
    ...(a?.fixes?.length ? [["fixes", "What can be fixed"]] : []),
    ...(a?.recommendations?.length ? [["recommendations", "AI improvement recommendations"]] : []),
    ...(a?.action_plan?.length ? [["plan", "Action plan"]] : []),
    ...r.categories.map((c) => [`cat-${c.key}`, c.label]),
    ["sources", "Data sources"],
  ];
  const head = `<header class="mr-cover"><p class="mr-brand">MOKS · ${esc(r.site.name)}</p><h1>${esc(r.title)}</h1><p class="mr-range">${esc(r.range.start)} – ${esc(r.range.end)} (${esc(r.range.days)} days, ${esc(r.range.timezone)}) · compared with ${esc(r.range.previousStart)} – ${esc(r.range.previousEnd)}</p><p class="mr-muted">Generated ${esc(r.generatedAt.slice(0, 16).replace("T", " "))} UTC · ${esc(r.site.origin)}</p><p>${unavailable.length ? badge("warn", `${unavailable.length} data source(s) not available: see Data sources`) : badge("ok", "Every selected data source answered")} ${a ? badge(check?.removed?.length ? "warn" : "ok", `AI analysis: every number and evidence id checked${check?.removed?.length ? `; ${check.removed.length} item(s) left out` : ""}`) : badge("warn", `No AI analysis: ${r.aiUnavailable ?? "not available yet"}`)}</p><nav class="mr-toc" aria-label="Contents"><ol>${toc.map(([id, t]) => `<li><a href="#${esc(id)}">${esc(t)}</a></li>`).join("")}</ol></nav></header>`;

  const points = (title: string, items: { text: string; evidence: string[] }[] | undefined, cls: string) => (items?.length ? `<h3>${esc(title)}</h3><ul class="mr-points mr-${cls}">${items.map((i) => `<li>${esc(i.text)} ${ev(i.evidence)}</li>`).join("")}</ul>` : "");
  const summary = section("summary", "Executive summary", `${kpis(r.summary.headline)}${a?.executive_summary ? `<div class="mr-callout"><p>${esc(a.executive_summary).replace(/\n\n/g, "</p><p>")}</p><p class="mr-muted">Written by the Report crew from the figures in this report; every number was checked against them.</p></div>` : ""}${points("Achievements", a?.achievements, "good")}${points("Risks", a?.risks, "bad")}`);
  const wrong = section("wrong", "What is going wrong", r.findings.length ? r.findings.map(finding).join("") : `<p>No problem was found in the selected data for this period.</p>`);
  const causes = section("causes", "Root cause analysis", (a?.root_causes ?? []).map((c) => `<article class="mr-card"><header>${badge(c.status === "confirmed" ? "ok" : c.status === "probable" ? "warn" : "low", STATUS_LABEL[c.status] ?? c.status)}${c.downgraded ? ` <span class="mr-muted">(shown as probable: its evidence is not direct)</span>` : ""} <strong>${esc(c.issue)}</strong></header><p>${esc(c.cause)}</p>${c.next_check ? `<p class="mr-muted"><b>Next check:</b> ${esc(c.next_check)}</p>` : ""}<footer>${ev(c.evidence)}</footer></article>`).join(""));
  const fixes = section("fixes", "What can be fixed", (a?.fixes ?? []).map((f) => `<article class="mr-card mr-sev-${esc(f.severity)}"><header>${badge(f.severity, SEV_LABEL[f.severity] ?? f.severity)} <strong>${esc(f.issue)}</strong></header><p><b>Impact:</b> ${esc(f.impact)}</p><p><b>Fix:</b> ${esc(f.fix)}</p>${f.steps?.length ? `<ol>${f.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>` : ""}<footer class="mr-muted">${f.expected_outcome ? `Expected outcome: ${esc(f.expected_outcome)} · ` : ""}${f.effort ? `Estimated effort: ${esc(f.effort)} · ` : ""}${ev(f.evidence)}</footer></article>`).join(""));
  const byArea = new Map<string, { text: string; evidence: string[] }[]>();
  for (const rec of a?.recommendations ?? []) byArea.set(rec.area, [...(byArea.get(rec.area) ?? []), rec]);
  const recs = section("recommendations", "AI improvement recommendations", [...byArea.entries()].map(([area, items]) => points(area.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), items, "plain")).join(""));
  const plan = section("plan", "Action plan", a?.action_plan?.length ? `<p class="mr-muted">Critical: act now · High: next · Medium: planned · Low: optional.</p>${table({ id: "plan-table", title: "Prioritised actions", columns: [{ key: "priority", label: "Priority" }, { key: "action", label: "Action" }, { key: "owner", label: "Owner" }, { key: "evidence", label: "Evidence" }], rows: a.action_plan.map((x) => ({ priority: SEV_LABEL[x.priority] ?? x.priority, action: x.action, owner: x.owner || "–", evidence: x.evidence.join(", ") })) })}` : "");
  const cats = r.categories
    .map((c) => section(`cat-${c.key}`, c.label, `${c.status !== "ok" || c.note ? `<p class="mr-callout mr-warn-box">${esc(c.note ?? (c.status === "unavailable" ? "No source of this category is available." : "Some sources are not available."))}</p>` : ""}${kpis(c.kpis)}${c.charts.map(chart).join("")}${c.tables.map(table).join("")}`, c.status !== "unavailable"))
    .join("");
  const sources = section("sources", "Data sources", `<p class="mr-muted">Every source this report read, with what it returned. A source that is not available is reported here, never left out silently or filled in.</p>${table({ id: "sources-table", title: "Sources", columns: [{ key: "label", label: "Source" }, { key: "category", label: "Category" }, { key: "status", label: "Status" }, { key: "rows", label: "Rows", format: "int" }, { key: "detail", label: "Detail" }], rows: r.sources.filter((s) => s.status !== "not_selected").map((s) => ({ label: s.label, category: s.category, status: SOURCE_LABEL[s.status] ?? s.status, rows: s.rows, detail: s.detail })) })}${r.untrusted.length ? `<h3>Recorded errors and log lines quoted as evidence</h3><ul class="mr-points mr-plain">${r.untrusted.map((u) => `<li id="${esc(u.id)}"><span class="mr-id">${esc(u.id)}</span> <code>${esc(u.text)}</code></li>`).join("")}</ul>` : ""}${check?.removed?.length ? `<h3>Left out of the AI analysis</h3>${table({ id: "removed-table", title: "Items that did not pass the check", columns: [{ key: "section", label: "Section" }, { key: "reason", label: "Why" }, { key: "text", label: "Text" }], rows: check.removed.map((x) => ({ section: x.section.replace(/_/g, " "), reason: x.reason, text: x.text })) })}` : ""}`);
  return `<div class="mr-report">${head}${summary}${wrong}${causes}${fixes}${recs}${plan}${cats}${sources}<footer class="mr-foot">MOKS report ${esc(r.id)} · ${esc(r.site.id)} · Figures computed from the site's own records · Confidential</footer></div>`;
}

/** Styles for .mr-report: the site's theme tokens when shown in the admin, the fallbacks in the standalone file. */
export const REPORT_CSS = `
.mr-report{--mr-fg:var(--fg,#0f172a);--mr-muted:var(--fg-muted,#475569);--mr-subtle:var(--fg-subtle,#64748b);--mr-line:var(--line,#e2e8f0);--mr-surface:var(--surface,#fff);--mr-soft:var(--surface-muted,#f8fafc);--mr-accent:var(--accent,#1e40af);color:var(--mr-fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:960px;margin:0 auto}
.mr-report h1{font-size:1.9rem;line-height:1.2;margin:.2rem 0}.mr-report h2{display:inline;font-size:1.25rem;color:var(--mr-accent)}.mr-report h3{font-size:1rem;margin:1rem 0 .4rem}
.mr-cover{border-bottom:3px solid #14b8a6;padding-bottom:1rem;margin-bottom:1rem}.mr-brand{font-weight:700;letter-spacing:.02em;color:var(--mr-accent);margin:0}.mr-range{margin:.2rem 0}
.mr-muted,.mr-note{color:var(--mr-subtle);font-size:.85rem}.mr-id{color:var(--mr-subtle);font-size:.75rem;font-weight:400}
.mr-toc ol{columns:2;padding-left:1.2rem;margin:.6rem 0 0}.mr-toc a,.mr-ev a{color:var(--mr-accent)}
.mr-section{border-top:1px solid var(--mr-line);padding:.8rem 0}.mr-section>summary{cursor:pointer;list-style-position:outside}.mr-section>summary::marker{color:var(--mr-subtle)}
.mr-kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:.6rem;margin:.8rem 0}.mr-kpi{background:var(--mr-soft);border:1px solid var(--mr-line);border-left:3px solid #3b82f6;border-radius:6px;padding:.55rem .7rem}
.mr-kpi-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.03em;color:var(--mr-subtle)}.mr-kpi-value{font-size:1.35rem;font-weight:700;font-variant-numeric:tabular-nums}
.mr-delta{font-size:.8rem;font-weight:600}.mr-good{color:#15803d}.mr-bad{color:#b91c1c}.mr-flat{color:var(--mr-subtle)}
.mr-callout{background:var(--mr-surface);border:1px solid var(--mr-line);border-left:3px solid #14b8a6;border-radius:6px;padding:.4rem .9rem;margin:.6rem 0}.mr-warn-box{border-left-color:#f59e0b}
.mr-card{border:1px solid var(--mr-line);border-left:4px solid #64748b;border-radius:6px;padding:.5rem .9rem;margin:.5rem 0;background:var(--mr-surface)}.mr-card p{margin:.3rem 0}
.mr-sev-critical{border-left-color:#991b1b}.mr-sev-high{border-left-color:#c2410c}.mr-sev-medium{border-left-color:#d97706}.mr-sev-low{border-left-color:#64748b}
.mr-badge{display:inline-block;font-size:.72rem;font-weight:700;border-radius:4px;padding:.1rem .45rem;vertical-align:middle}
.mr-critical{background:#fee2e2;color:#991b1b}.mr-high{background:#ffedd5;color:#9a3412}.mr-medium,.mr-warn{background:#fef3c7;color:#92400e}.mr-low{background:#f1f5f9;color:#334155}.mr-ok{background:#dcfce7;color:#166534}
.mr-points{padding-left:1.2rem}.mr-points li{margin:.25rem 0}.mr-ev{color:var(--mr-subtle);font-size:.75rem;margin-left:.3rem}
.mr-table-wrap{overflow-x:auto;margin:.7rem 0}.mr-table{border-collapse:collapse;width:100%;font-size:.85rem}.mr-table caption{text-align:left;font-weight:600;padding:.2rem 0}
.mr-table th{background:var(--mr-accent);color:var(--on-accent,#fff);text-align:left;padding:.35rem .5rem;font-weight:600}.mr-table td{border-bottom:1px solid var(--mr-line);padding:.3rem .5rem;overflow-wrap:anywhere}.mr-table tbody tr:nth-child(even){background:var(--mr-soft)}.mr-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.mr-chart{margin:.8rem 0;background:var(--mr-soft);border:1px solid var(--mr-line);border-radius:6px;padding:.5rem}.mr-chart svg{width:100%;height:auto;display:block}
.mr-svg-title{font-weight:700;font-size:13px;fill:var(--mr-fg)}.mr-grid{stroke:var(--mr-line)}.mr-axis{font-size:10px;fill:var(--mr-subtle)}
.mr-legend{display:flex;gap:1rem;font-size:.75rem;color:var(--mr-muted);padding:.2rem .4rem}.mr-legend i{display:inline-block;width:12px;height:3px;margin-right:.3rem;vertical-align:middle}
.mr-bars{display:grid;gap:.25rem;margin-top:.4rem}.mr-bar-row{display:grid;grid-template-columns:minmax(80px,32%) 1fr auto;gap:.5rem;align-items:center;font-size:.8rem}.mr-bar-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mr-bar-track{background:var(--mr-line);border-radius:3px;height:10px}.mr-bar{display:block;height:10px;border-radius:3px;background:#3b82f6}.mr-bar-value{font-variant-numeric:tabular-nums}
.mr-report code{font-size:.8rem;overflow-wrap:anywhere}.mr-foot{color:var(--mr-subtle);font-size:.75rem;border-top:1px solid var(--mr-line);padding-top:.6rem;margin-top:1rem}
@media (max-width:640px){.mr-toc ol{columns:1}.mr-report h1{font-size:1.5rem}}
@media print{.mr-section{break-inside:auto}.mr-card,.mr-kpi,.mr-chart{break-inside:avoid}.mr-table th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

/** The standalone file: the body, the styles and theme tokens for light and dark, and a CSP that allows nothing else. */
export function renderHtmlDocument(r: SiteReport): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><meta name="robots" content="noindex"><title>${esc(r.title)} · ${esc(r.range.start)} – ${esc(r.range.end)}</title><style>:root{--fg:#0f172a;--fg-muted:#475569;--fg-subtle:#64748b;--line:#e2e8f0;--surface:#fff;--surface-muted:#f8fafc;--accent:#1e40af;color-scheme:light dark}@media (prefers-color-scheme:dark){:root{--fg:#e2e8f0;--fg-muted:#cbd5e1;--fg-subtle:#94a3b8;--line:#334155;--surface:#0f172a;--surface-muted:#1e293b;--accent:#93c5fd;--on-accent:#0f172a}}body{margin:0;padding:24px 16px;background:var(--surface)}${REPORT_CSS}</style></head><body>${renderHtmlBody(r)}</body></html>`;
}

/** Every figure in long form: one row per KPI, chart point, table cell, finding and source (spreadsheet-safe cells). */
export function renderCsv(r: SiteReport): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: unknown[][] = [["section", "category", "id", "item", "field", "value", "previous", "change", "format"]];
  for (const c of r.categories) {
    for (const k of c.kpis) rows.push(["kpi", c.key, k.id, k.label, "value", k.value, k.previous ?? "", k.change ?? "", k.format]);
    for (const ch of c.charts) for (const s of ch.series) for (const [label, v] of s.points) rows.push(["chart", c.key, ch.id, ch.title, `${s.name} · ${label}`, v, "", "", ch.unit ?? ""]);
    for (const t of c.tables) t.rows.forEach((row, i) => t.columns.forEach((col) => rows.push(["table", c.key, `${t.id}.r${i + 1}`, t.title, col.label, row[col.key] ?? "", "", "", col.format ?? "text"])));
  }
  for (const f of r.findings) rows.push(["finding", f.category, f.id, f.title, f.severity, f.detail, "", "", f.confirmed ? "confirmed" : ""]);
  for (const s of r.sources) rows.push(["source", s.category, s.key, s.label, s.status, s.rows ?? "", "", "", s.detail]);
  return rows.map((row) => row.map(cell).join(",")).join("\r\n");
}

export const renderJson = (r: SiteReport) => JSON.stringify(r, null, 2);
