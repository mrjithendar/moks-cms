"""Weekly / monthly SEO report as a designed PDF (ReportLab, pure Python: no system libraries, CPU-only image).

Layout (A4): branded header band and footer with page numbers on every page; a cover block (report type, period,
generated date, data-completeness badge); KPI cards (clicks, impressions, CTR, average position, GA4 organic sessions)
with coloured period-over-period deltas (for position, lower is better); a line chart of daily clicks against the
previous period; a bar chart of the top articles; the narrative (only when it passed the number check, with a
"numbers verified" badge); then tables for top / growing / declining articles, opportunities, decay alerts,
technical issues, recommendations and next actions, and the data sources.

Every figure comes from the report payload the web app computed (buildReport); this module only formats it.
"""

from __future__ import annotations

import io
from datetime import UTC, date, datetime
from typing import Any
from xml.sax.saxutils import escape

from reportlab.graphics.charts.barcharts import HorizontalBarChart
from reportlab.graphics.charts.legends import Legend
from reportlab.graphics.charts.lineplots import LinePlot
from reportlab.graphics.shapes import Drawing, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate, CondPageBreak, Frame, KeepTogether, PageTemplate, Paragraph, Spacer, Table, TableStyle

INK = colors.HexColor("#0f172a")
MUTED = colors.HexColor("#64748b")
LINE = colors.HexColor("#e2e8f0")
SOFT = colors.HexColor("#f8fafc")
BRAND = colors.HexColor("#1e3a8a")
BRAND_2 = colors.HexColor("#3b82f6")
ACCENT = colors.HexColor("#14b8a6")
GOOD = colors.HexColor("#15803d")
BAD = colors.HexColor("#b91c1c")
GOOD_BG = colors.HexColor("#dcfce7")
BAD_BG = colors.HexColor("#fee2e2")
WARN_BG = colors.HexColor("#fef3c7")
WARN = colors.HexColor("#92400e")

PAGE_W, PAGE_H = A4
MARGIN = 16 * mm
CONTENT_W = PAGE_W - 2 * MARGIN

_S = {
    "h1": ParagraphStyle("h1", fontName="Helvetica-Bold", fontSize=24, leading=28, textColor=INK, spaceAfter=2),
    "sub": ParagraphStyle("sub", fontName="Helvetica", fontSize=11, leading=15, textColor=MUTED),
    "h2": ParagraphStyle("h2", fontName="Helvetica-Bold", fontSize=13.5, leading=17, textColor=BRAND, spaceBefore=12, spaceAfter=6),
    "body": ParagraphStyle("body", fontName="Helvetica", fontSize=10, leading=15, textColor=INK),
    "small": ParagraphStyle("small", fontName="Helvetica", fontSize=8, leading=11, textColor=MUTED),
    "cell": ParagraphStyle("cell", fontName="Helvetica", fontSize=8.6, leading=11, textColor=INK),
    "cellr": ParagraphStyle("cellr", fontName="Helvetica", fontSize=8.6, leading=11, textColor=INK, alignment=TA_RIGHT),
    "kpi_label": ParagraphStyle("kl", fontName="Helvetica", fontSize=8, leading=10, textColor=MUTED),
    "kpi_value": ParagraphStyle("kv", fontName="Helvetica-Bold", fontSize=17, leading=21, textColor=INK),
    "kpi_delta": ParagraphStyle("kd", fontName="Helvetica-Bold", fontSize=8.5, leading=11, alignment=TA_LEFT),
}


def _f(v: Any, digits: int = 0) -> str:
    if v is None:
        return "–"
    try:
        return f"{float(v):,.{digits}f}"
    except (TypeError, ValueError):
        return "–"


def _pct(v: Any, signed: bool = True) -> str:
    if v is None:
        return "–"
    try:
        x = float(v) * 100
    except (TypeError, ValueError):
        return "–"
    return f"{x:+.1f}%" if signed else f"{x:.1f}%"


def _p(text: Any, style: str = "cell") -> Paragraph:
    return Paragraph(escape(str(text if text is not None else "–")), _S[style])


def _delta_markup(change: Any, *, lower_is_better: bool = False) -> str:
    if change is None:
        return '<font color="#64748b">no previous data</font>'
    try:
        c = float(change)
    except (TypeError, ValueError):
        return ""
    good = (c < 0) if lower_is_better else (c > 0)
    if abs(c) < 1e-9:
        return '<font color="#64748b">→ 0.0%</font>'
    arrow = "▲" if c > 0 else "▼"
    col = "#15803d" if good else "#b91c1c"
    return f'<font color="{col}">{arrow} {c * 100:+.1f}%</font>'


class _Doc(BaseDocTemplate):
    def __init__(self, buf: io.BytesIO, meta: dict[str, str]):
        super().__init__(buf, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN + 12 * mm, bottomMargin=MARGIN + 6 * mm, title=meta["title"], author="jithendar.com", subject=meta["subject"], creator="seo-agent report_flow")
        self.meta = meta
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="main", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        self.addPageTemplates([PageTemplate(id="page", frames=[frame], onPage=self._decorate)])

    def _decorate(self, c: Any, doc: Any) -> None:
        c.saveState()
        # Header band
        c.setFillColor(BRAND)
        c.rect(0, PAGE_H - 14 * mm, PAGE_W, 14 * mm, stroke=0, fill=1)
        c.setFillColor(ACCENT)
        c.rect(0, PAGE_H - 14 * mm - 1.2 * mm, PAGE_W, 1.2 * mm, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 10.5)
        c.drawString(MARGIN, PAGE_H - 9 * mm, "jithendar.com")
        c.setFont("Helvetica", 9)
        c.drawRightString(PAGE_W - MARGIN, PAGE_H - 9 * mm, self.meta["header"])
        # Footer
        c.setStrokeColor(LINE)
        c.setLineWidth(0.6)
        c.line(MARGIN, MARGIN + 2 * mm, PAGE_W - MARGIN, MARGIN + 2 * mm)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 7.5)
        c.drawString(MARGIN, MARGIN - 2 * mm, f"Generated {self.meta['generated']} · Sources: Google Search Console (web) and Google Analytics 4 · Confidential")
        c.drawRightString(PAGE_W - MARGIN, MARGIN - 2 * mm, f"Page {doc.page}")
        c.restoreState()


def _kpi_cards(cards: list[tuple[str, str, str]]) -> Table:
    cells = []
    for label, value, delta in cards:
        inner = Table([[Paragraph(escape(label.upper()), _S["kpi_label"])], [Paragraph(escape(value), _S["kpi_value"])], [Paragraph(delta, _S["kpi_delta"])]], colWidths=[None])
        inner.setStyle(TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1)]))
        cells.append(inner)
    gap = 3 * mm
    w = (CONTENT_W - gap * (len(cards) - 1)) / len(cards)
    row: list[Any] = []
    widths: list[float] = []
    for i, cell in enumerate(cells):
        if i:
            row.append("")
            widths.append(gap)
        row.append(cell)
        widths.append(w)
    t = Table([row], colWidths=widths)
    style: list[tuple[Any, ...]] = [("VALIGN", (0, 0), (-1, -1), "TOP")]
    for i in range(0, len(row), 2):
        style += [("BACKGROUND", (i, 0), (i, 0), SOFT), ("BOX", (i, 0), (i, 0), 0.6, LINE), ("LINEBEFORE", (i, 0), (i, 0), 3, BRAND_2), ("LEFTPADDING", (i, 0), (i, 0), 8), ("TOPPADDING", (i, 0), (i, 0), 7), ("BOTTOMPADDING", (i, 0), (i, 0), 7)]
    t.setStyle(TableStyle(style))
    return t


def _badge(text: str, fg: Any, bg: Any) -> Table:
    t = Table([[Paragraph(f'<font color="{fg.hexval().replace("0x", "#")}"><b>{escape(text)}</b></font>', _S["small"])]])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), bg), ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    t.hAlign = "LEFT"
    return t


def _table(header: list[str], rows: list[list[Any]], widths: list[float], numeric_cols: set[int], delta_col: int | None = None) -> Table:
    data: list[list[Any]] = [[Paragraph(f'<font color="#ffffff"><b>{escape(h)}</b></font>', _S["cellr" if i in numeric_cols else "cell"]) for i, h in enumerate(header)]]
    for r in rows:
        line = []
        for i, v in enumerate(r):
            if i == delta_col and isinstance(v, (int, float)):
                col = "#15803d" if v > 0 else "#b91c1c" if v < 0 else "#64748b"
                line.append(Paragraph(f'<font color="{col}"><b>{v:+,.0f}</b></font>', _S["cellr"]))
            else:
                line.append(_p(v, "cellr" if i in numeric_cols else "cell"))
        data.append(line)
    t = Table(data, colWidths=widths, repeatRows=1)
    style: list[tuple[Any, ...]] = [
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, LINE),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]
    for i in range(1, len(data)):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), SOFT))
    t.setStyle(TableStyle(style))
    return t


def _daily_chart(daily: list[dict[str, Any]], prev: list[dict[str, Any]]) -> Drawing | None:
    cur = [float(d.get("clicks") or 0) for d in daily]
    if len(cur) < 2:
        return None
    pv = [float(d.get("clicks") or 0) for d in prev][: len(cur)]
    h = 62 * mm
    d = Drawing(CONTENT_W, h)
    d.add(Rect(0, 0, CONTENT_W, h, fillColor=SOFT, strokeColor=LINE, strokeWidth=0.6))
    lp = LinePlot()
    lp.x, lp.y, lp.width, lp.height = 34, 26, CONTENT_W - 50, h - 46
    series = [list(enumerate(cur, start=1))]
    if len(pv) >= 2:
        series.append(list(enumerate(pv, start=1)))
    lp.data = series
    lp.lines[0].strokeColor, lp.lines[0].strokeWidth = BRAND_2, 2.2
    if len(series) > 1:
        lp.lines[1].strokeColor, lp.lines[1].strokeWidth, lp.lines[1].strokeDashArray = MUTED, 1.2, (3, 2)
    top = max([*cur, *pv, 1.0])
    lp.yValueAxis.valueMin, lp.yValueAxis.valueMax = 0, top * 1.15
    lp.yValueAxis.labels.fontName, lp.yValueAxis.labels.fontSize, lp.yValueAxis.labels.fillColor = "Helvetica", 7, MUTED
    lp.yValueAxis.strokeColor, lp.yValueAxis.gridStrokeColor, lp.yValueAxis.visibleGrid = LINE, LINE, True
    lp.yValueAxis.labelTextFormat = "{:,.0f}".format
    lp.xValueAxis.valueMin, lp.xValueAxis.valueMax = 1, len(cur)
    lp.xValueAxis.labels.fontName, lp.xValueAxis.labels.fontSize, lp.xValueAxis.labels.fillColor = "Helvetica", 7, MUTED
    lp.xValueAxis.strokeColor = LINE
    step = max(1, len(cur) // 7)
    lp.xValueAxis.valueSteps = list(range(1, len(cur) + 1, step))
    dates = [str(x.get("date", ""))[5:] for x in daily]
    lp.xValueAxis.labelTextFormat = lambda v: dates[int(v) - 1] if 0 < int(v) <= len(dates) else ""
    d.add(lp)
    d.add(String(10, h - 14, "Daily clicks", fontName="Helvetica-Bold", fontSize=9, fillColor=INK))
    lg = Legend()
    lg.x, lg.y, lg.alignment, lg.columnMaximum = CONTENT_W - 190, h - 10, "right", 1
    lg.fontName, lg.fontSize, lg.dx, lg.dy, lg.deltax = "Helvetica", 7.5, 10, 2, 90
    lg.colorNamePairs = [(BRAND_2, "This period"), *([(MUTED, "Previous period")] if len(series) > 1 else [])]
    d.add(lg)
    return d


def _top_chart(rows: list[dict[str, Any]]) -> Drawing | None:
    rows = [r for r in rows if float(r.get("clicks") or 0) > 0][:8]
    if not rows:
        return None
    h = 14 + 13 * len(rows) + 22
    d = Drawing(CONTENT_W, h)
    bc = HorizontalBarChart()
    bc.x, bc.y, bc.width, bc.height = 200, 10, CONTENT_W - 230, h - 26
    vals = [float(r.get("clicks") or 0) for r in reversed(rows)]
    bc.data = [vals]
    bc.bars[0].fillColor, bc.bars[0].strokeColor = BRAND_2, None
    bc.barWidth = 7
    bc.valueAxis.valueMin, bc.valueAxis.valueMax = 0, max(vals) * 1.15
    bc.valueAxis.labels.fontSize, bc.valueAxis.labels.fillColor, bc.valueAxis.strokeColor = 7, MUTED, LINE
    bc.valueAxis.visibleGrid, bc.valueAxis.gridStrokeColor = True, LINE
    bc.categoryAxis.categoryNames = [(str(r.get("title") or r.get("page") or ""))[:42] for r in reversed(rows)]
    bc.categoryAxis.labels.fontName, bc.categoryAxis.labels.fontSize, bc.categoryAxis.labels.boxAnchor = "Helvetica", 7.5, "e"
    bc.categoryAxis.labels.dx, bc.categoryAxis.strokeColor = -4, LINE
    bc.barLabelFormat, bc.barLabels.fontSize, bc.barLabels.nudge, bc.barLabels.fillColor = "{:,.0f}".format, 7, 10, INK
    d.add(bc)
    d.add(String(0, h - 10, "Top articles by clicks", fontName="Helvetica-Bold", fontSize=9, fillColor=INK))
    return d


def render(report: dict[str, Any], *, narrative: str = "", verified: bool = False, generated: datetime | None = None) -> bytes:
    kind = str(report.get("type") or "weekly")
    p = report.get("period") or {}
    start, end = str(p.get("start") or ""), str(p.get("end") or "")

    def nice(d: str) -> str:
        try:
            return date.fromisoformat(d).strftime("%d %b %Y")
        except ValueError:
            return d

    gen = (generated or datetime.now(UTC)).strftime("%d %b %Y %H:%M UTC")
    title = f"{kind.capitalize()} SEO report"
    buf = io.BytesIO()
    doc = _Doc(buf, {"title": f"{title} {start} – {end}", "subject": "Search performance report", "header": f"{title} · {nice(start)} – {nice(end)}", "generated": gen})
    story: list[Any] = []

    g = ((report.get("organic") or {}).get("gsc")) or {}
    cur, ch = g.get("current") or {}, g.get("change") or {}
    ga = ((report.get("organic") or {}).get("ga4")) or {}
    complete = bool((report.get("organic") or {}).get("dataComplete"))

    story += [Paragraph(escape(title), _S["h1"]), Paragraph(f"{escape(nice(start))} – {escape(nice(end))} &nbsp;·&nbsp; compared with {escape(nice(str(p.get('prevStart') or '')))} – {escape(nice(str(p.get('prevEnd') or '')))}", _S["sub"]), Spacer(1, 4 * mm)]
    story.append(_badge("Data complete for the period" if complete else "Data incomplete for this period: figures may still change", GOOD if complete else WARN, GOOD_BG if complete else WARN_BG))
    story.append(Spacer(1, 5 * mm))
    story.append(
        _kpi_cards(
            [
                ("Clicks", _f(cur.get("clicks")), _delta_markup(ch.get("clicks"))),
                ("Impressions", _f(cur.get("impressions")), _delta_markup(ch.get("impressions"))),
                ("Click-through rate", _pct(cur.get("ctr"), signed=False), _delta_markup(ch.get("ctr"))),
                ("Average position", _f(cur.get("position"), 1), _delta_markup(ch.get("position"), lower_is_better=True)),
                ("Organic sessions", _f((ga.get("current") or {}).get("organicSessions")), _delta_markup((ga.get("change") or {}).get("organicSessions"))),
            ]
        )
    )
    story.append(Spacer(1, 1.5 * mm))
    story.append(Paragraph("Changes compare with the previous period of equal length. For average position, lower is better, so a fall is shown in green.", _S["small"]))
    story.append(Spacer(1, 4 * mm))
    chart = _daily_chart(report.get("daily") or [], report.get("dailyPrevious") or [])
    if chart is not None:
        story += [chart, Spacer(1, 4 * mm)]

    if narrative and verified:
        box = Table([[Paragraph("<b>Summary</b>", _S["body"])], [Paragraph(escape(narrative).replace("\n\n", "<br/><br/>").replace("\n", " "), _S["body"])], [_badge("✓ Every number in this summary was checked against the source data", GOOD, GOOD_BG)]], colWidths=[CONTENT_W])
        box.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.white), ("BOX", (0, 0), (-1, -1), 0.6, LINE), ("LINEBEFORE", (0, 0), (0, -1), 3, ACCENT), ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
        story += [KeepTogether([box]), Spacer(1, 3 * mm)]

    bars = _top_chart(report.get("bestArticles") or [])
    if bars is not None:
        story += [CondPageBreak(70 * mm), Paragraph("Best articles", _S["h2"]), bars, Spacer(1, 2 * mm)]

    def article_rows(rows: list[dict[str, Any]], with_delta: bool) -> list[list[Any]]:
        return [[r.get("title") or r.get("page"), r.get("page"), _f(r.get("clicks")), _f(r.get("previous")), *([float(r.get("delta") or 0)] if with_delta else [])] for r in rows[:10]]

    w4 = [CONTENT_W * 0.38, CONTENT_W * 0.34, CONTENT_W * 0.14, CONTENT_W * 0.14]
    w5 = [CONTENT_W * 0.33, CONTENT_W * 0.3, CONTENT_W * 0.12, CONTENT_W * 0.12, CONTENT_W * 0.13]
    if report.get("bestArticles"):
        story += [_table(["Article", "URL", "Clicks", "Previous"], article_rows(report["bestArticles"], False), w4, {2, 3})]
    for key, label in (("growing", "Growing"), ("declining", "Declining")):
        if report.get(key):
            story += [CondPageBreak(40 * mm), Paragraph(label, _S["h2"]), _table(["Article", "URL", "Clicks", "Previous", "Change"], article_rows(report[key], True), w5, {2, 3, 4}, delta_col=4)]

    def rec_rows(rows: list[dict[str, Any]]) -> list[list[Any]]:
        return [[str(r.get("category", "")).replace("_", " "), r.get("band"), r.get("problem"), r.get("action")] for r in rows[:10]]

    wr = [CONTENT_W * 0.16, CONTENT_W * 0.1, CONTENT_W * 0.37, CONTENT_W * 0.37]
    for key, label in (("newOpportunities", "New opportunities"), ("decayAlerts", "Content decay alerts"), ("nextActions", "Next actions")):
        if report.get(key):
            story += [CondPageBreak(40 * mm), Paragraph(label, _S["h2"]), _table(["Type", "Priority", "Problem", "Proposed action"], rec_rows(report[key]), wr, set())]

    r = report.get("recommendations") or {}
    if r:
        story += [CondPageBreak(42 * mm), Paragraph("Recommendations", _S["h2"]), _kpi_cards([("Pending", _f(r.get("pending")), ""), ("Approved", _f(r.get("approved")), ""), ("Implemented in period", _f(r.get("implementedInPeriod")), ""), ("Edits accepted in period", _f(r.get("proposalsAcceptedInPeriod")), "")])]

    t = report.get("technical")
    if t:
        story += [CondPageBreak(40 * mm), Paragraph("Technical health", _S["h2"]), Paragraph(f"Last scan {escape(str(t.get('scannedAt', ''))[:10])} · {_f(t.get('pagesCrawled'))} pages crawled", _S["small"]), Spacer(1, 2 * mm)]
        if t.get("top"):
            story.append(_table(["Check", "Severity", "Pages"], [[i.get("check"), i.get("severity"), _f(i.get("count"))] for i in t["top"]], [CONTENT_W * 0.6, CONTENT_W * 0.2, CONTENT_W * 0.2], {2}))

    src = report.get("sources") or {}
    story += [Spacer(1, 6 * mm), Paragraph("Sources: " + escape(" · ".join(str(v) for v in src.values())) + ". Search Console clicks and GA4 sessions are different measures and are not added together.", _S["small"])]
    doc.build(story)
    return buf.getvalue()
