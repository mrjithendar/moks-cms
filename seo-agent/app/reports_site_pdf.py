"""A CrewAI console report as a designed PDF (D-102; ReportLab, the same styles as the weekly briefing in reports_pdf.py).

Layout (A4): a MOKS header band and a footer with the site, the generation time and "Page n of m" on every page; a cover
(title, site, date range and the period compared with, generation time, scope, and badges for what was checked); a
table of contents; the executive summary (the headline figures, then the analyst's summary when it passed the checks);
what is going wrong (the web app's findings: severity, evidence, impact); root causes (confirmed / probable / to
investigate); what can be fixed (fix cards); recommendations; the prioritised action plan; one section per category
with its figures, charts and tables; the data sources with their status; and what the check left out.

Every figure comes from the report the web app computed; this module only formats it. Text from the data (titles,
error messages) and from the analyst is escaped before ReportLab parses it, so it can never add markup or links.
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
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import BaseDocTemplate, CondPageBreak, Frame, KeepTogether, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle
from reportlab.platypus.tableofcontents import TableOfContents

from .reports_pdf import (
    _S,
    ACCENT,
    BAD,
    BRAND,
    BRAND_2,
    CONTENT_W,
    GOOD,
    GOOD_BG,
    INK,
    LINE,
    MARGIN,
    MUTED,
    PAGE_H,
    PAGE_W,
    SOFT,
    WARN,
    WARN_BG,
    _badge,
    _kpi_cards,
)

SEVERITY = {
    "critical": (colors.HexColor("#991b1b"), colors.HexColor("#fee2e2")),
    "high": (colors.HexColor("#9a3412"), colors.HexColor("#ffedd5")),
    "medium": (WARN, WARN_BG),
    "low": (colors.HexColor("#334155"), colors.HexColor("#f1f5f9")),
}
STATUS = {
    "confirmed": ("Confirmed", GOOD, GOOD_BG),
    "probable": ("Probable cause", WARN, WARN_BG),
    "investigate": ("Needs investigation", colors.HexColor("#334155"), colors.HexColor("#f1f5f9")),
}
SOURCE_STATUS = {"ok": "Available", "empty": "No data in range", "unavailable": "Not available", "error": "Failed"}
SERIES = [BRAND_2, ACCENT, colors.HexColor("#f59e0b"), colors.HexColor("#ef4444"), colors.HexColor("#8b5cf6"), MUTED]

_X = {
    "toc0": ParagraphStyle("toc0", fontName="Helvetica", fontSize=10, leading=15, leftIndent=0, textColor=INK),
    "h3": ParagraphStyle("h3", fontName="Helvetica-Bold", fontSize=10.5, leading=14, textColor=INK, spaceBefore=6, spaceAfter=3),
    "label": ParagraphStyle("label", fontName="Helvetica-Bold", fontSize=7.5, leading=10, textColor=MUTED),
}


def _t(v: Any, limit: int = 600) -> str:
    """Escaped text for a Paragraph (untrusted: titles, error messages, the analyst's words)."""
    s = "" if v is None else str(v)
    return escape(s if len(s) <= limit else s[: limit - 1] + "…")


def fmt(v: Any, kind: str | None) -> str:
    """A value as the web app labelled it: int, float, pct (a ratio), usd, ms, s, tokens, bytes; '–' when unknown."""
    if v is None or v == "":
        return "–"
    if isinstance(v, str) and kind not in ("int", "float", "pct", "usd", "ms", "s", "tokens", "bytes"):
        return v
    try:
        x = float(v)
    except (TypeError, ValueError):
        return str(v)
    if kind == "pct":
        return f"{x * 100:.1f}%"
    if kind == "usd":
        return f"${x:,.4f}" if 0 < abs(x) < 0.01 else f"${x:,.2f}"
    if kind == "ms":
        return f"{x / 1000:,.1f} s" if x >= 10_000 else f"{x:,.0f} ms"
    if kind == "s":
        return f"{x:,.1f} s"
    if kind == "bytes":
        return f"{x / 1_048_576:,.1f} MB" if x >= 1_048_576 else f"{x / 1024:,.0f} KB"
    if kind == "float":
        return f"{x:,.2f}"
    return f"{x:,.0f}"


def _delta(change: Any, better: str | None) -> str:
    if change is None:
        return '<font color="#64748b">no previous data</font>'
    try:
        c = float(change)
    except (TypeError, ValueError):
        return ""
    if abs(c) < 1e-9:
        return '<font color="#64748b">→ 0.0%</font>'
    good = None if better not in ("up", "down") else (c > 0) == (better == "up")
    col = "#64748b" if good is None else "#15803d" if good else "#b91c1c"
    return f'<font color="{col}">{"▲" if c > 0 else "▼"} {c * 100:+.1f}%</font>'


def _nice(d: str) -> str:
    try:
        return date.fromisoformat(d).strftime("%d %b %Y")
    except ValueError:
        return d


class _SiteDoc(BaseDocTemplate):
    """Two-pass build (multiBuild) so the contents and "Page n of m" are filled in."""

    def __init__(self, buf: io.BytesIO, meta: dict[str, str]):
        super().__init__(buf, pagesize=A4, leftMargin=MARGIN, rightMargin=MARGIN, topMargin=MARGIN + 12 * mm, bottomMargin=MARGIN + 6 * mm, title=meta["title"], author="MOKS", subject=meta["subject"], creator="MOKS seo-agent report_flow")
        self.meta = meta
        self.pages = 0
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="main", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        self.addPageTemplates([PageTemplate(id="page", frames=[frame], onPage=self._decorate)])

    def afterFlowable(self, flowable: Any) -> None:
        if isinstance(flowable, Paragraph) and flowable.style.name == "h2":
            text = flowable.getPlainText()
            key = f"s{abs(hash(text)) % 10**8}-{self.page}"
            self.canv.bookmarkPage(key)
            self.canv.addOutlineEntry(text, key, level=0)
            self.notify("TOCEntry", (0, text, self.page, key))

    def afterPage(self) -> None:
        self._seen = max(getattr(self, "_seen", 0), self.page)

    def beforeDocument(self) -> None:
        # Each multiBuild pass starts here: the page count of the pass before is what "of m" says.
        self.pages = getattr(self, "_seen", 0)
        self._seen = 0

    def _decorate(self, c: Any, doc: Any) -> None:
        c.saveState()
        c.setFillColor(BRAND)
        c.rect(0, PAGE_H - 14 * mm, PAGE_W, 14 * mm, stroke=0, fill=1)
        c.setFillColor(ACCENT)
        c.rect(0, PAGE_H - 14 * mm - 1.2 * mm, PAGE_W, 1.2 * mm, stroke=0, fill=1)
        c.setFillColor(colors.white)
        c.setFont("Helvetica-Bold", 10.5)
        c.drawString(MARGIN, PAGE_H - 9 * mm, "MOKS")
        c.setFont("Helvetica", 9)
        c.drawString(MARGIN + 13 * mm, PAGE_H - 9 * mm, self.meta["site"][:60])
        c.drawRightString(PAGE_W - MARGIN, PAGE_H - 9 * mm, self.meta["header"][:90])
        c.setStrokeColor(LINE)
        c.setLineWidth(0.6)
        c.line(MARGIN, MARGIN + 2 * mm, PAGE_W - MARGIN, MARGIN + 2 * mm)
        c.setFillColor(MUTED)
        c.setFont("Helvetica", 7.5)
        c.drawString(MARGIN, MARGIN - 2 * mm, f"Generated {self.meta['generated']} · Figures computed from the site's own records · Confidential")
        total = getattr(doc, "pages", 0) or 0
        c.drawRightString(PAGE_W - MARGIN, MARGIN - 2 * mm, f"Page {doc.page}" + (f" of {total}" if total else ""))
        c.restoreState()


def _table(columns: list[dict[str, Any]], rows: list[dict[str, Any]], limit: int = 25) -> Table:
    cols = columns[:7] or [{"key": k, "label": k} for k in list((rows or [{}])[0].keys())[:7]]
    numeric = {i for i, c in enumerate(cols) if c.get("format") in ("int", "float", "pct", "usd", "ms", "s", "tokens", "bytes")}
    head = [Paragraph(f'<font color="#ffffff"><b>{_t(c.get("label") or c.get("key"), 40)}</b></font>', _S["cellr" if i in numeric else "cell"]) for i, c in enumerate(cols)]
    data: list[list[Any]] = [head]
    for r in rows[:limit]:
        data.append([Paragraph(_t(fmt(r.get(str(c.get("key"))), c.get("format")), 160), _S["cellr" if i in numeric else "cell"]) for i, c in enumerate(cols)])
    hinted = [float(c["width"]) if isinstance(c.get("width"), (int, float)) else None for c in cols]
    if any(h is not None for h in hinted):  # fractions of the page width; the columns without one share the rest
        left = max(0.0, 1 - sum(h for h in hinted if h is not None))
        n = sum(1 for h in hinted if h is None)
        widths = [CONTENT_W * (h if h is not None else left / max(1, n)) for h in hinted]
    else:
        first = 0.34 if len(cols) > 2 else 0.6
        rest = (1 - first) / max(1, len(cols) - 1)
        widths = [CONTENT_W * (first if i == 0 else rest) for i in range(len(cols))]
    t = Table(data, colWidths=widths, repeatRows=1)
    style: list[tuple[Any, ...]] = [
        ("BACKGROUND", (0, 0), (-1, 0), BRAND),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LINEBELOW", (0, 1), (-1, -1), 0.4, LINE),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]
    style += [("BACKGROUND", (0, i), (-1, i), SOFT) for i in range(2, len(data), 2)]
    t.setStyle(TableStyle(style))
    return t


def _chart(c: dict[str, Any]) -> Drawing | None:
    series = [s for s in (c.get("series") or []) if isinstance(s, dict) and len(s.get("points") or []) >= 1][:6]
    if not series:
        return None
    title = str(c.get("title") or "")[:80]
    if c.get("type") == "bar":
        pts = [(str(p[0])[:40], float(p[1] or 0)) for p in series[0]["points"][:10] if isinstance(p, (list, tuple)) and len(p) == 2]
        if not pts or max(v for _, v in pts) <= 0:
            return None
        h = 14 + 13 * len(pts) + 22
        d = Drawing(CONTENT_W, h)
        bc = HorizontalBarChart()
        bc.x, bc.y, bc.width, bc.height = 190, 10, CONTENT_W - 220, h - 26
        vals = [v for _, v in reversed(pts)]
        bc.data = [vals]
        bc.bars[0].fillColor, bc.bars[0].strokeColor = BRAND_2, None
        bc.barWidth = 7
        bc.valueAxis.valueMin, bc.valueAxis.valueMax = 0, max(vals) * 1.15
        bc.valueAxis.labels.fontSize, bc.valueAxis.labels.fillColor, bc.valueAxis.strokeColor = 7, MUTED, LINE
        bc.valueAxis.visibleGrid, bc.valueAxis.gridStrokeColor = True, LINE
        bc.categoryAxis.categoryNames = [n for n, _ in reversed(pts)]
        bc.categoryAxis.labels.fontName, bc.categoryAxis.labels.fontSize, bc.categoryAxis.labels.boxAnchor = "Helvetica", 7.5, "e"
        bc.categoryAxis.labels.dx, bc.categoryAxis.strokeColor = -4, LINE
        unit = str(c.get("unit") or "")
        bc.barLabelFormat = (lambda v: f"${v:,.2f}") if unit == "usd" else "{:,.0f}".format
        bc.barLabels.fontSize, bc.barLabels.nudge, bc.barLabels.fillColor = 7, 12, INK
        d.add(bc)
        d.add(String(0, h - 10, title, fontName="Helvetica-Bold", fontSize=9, fillColor=INK))
        return d
    labels = [str(p[0]) for p in series[0]["points"]]
    if len(labels) < 2:
        return None
    h = 62 * mm
    d = Drawing(CONTENT_W, h)
    d.add(Rect(0, 0, CONTENT_W, h, fillColor=SOFT, strokeColor=LINE, strokeWidth=0.6))
    lp = LinePlot()
    lp.x, lp.y, lp.width, lp.height = 40, 26, CONTENT_W - 56, h - 46
    data = [[(i + 1, float(p[1] or 0)) for i, p in enumerate(s["points"][: len(labels)])] for s in series]
    lp.data = data
    for i in range(len(data)):
        lp.lines[i].strokeColor, lp.lines[i].strokeWidth = SERIES[i % len(SERIES)], 2.0 if i == 0 else 1.4
    top = max([v for s in data for _, v in s] + [1.0])
    lp.yValueAxis.valueMin, lp.yValueAxis.valueMax = 0, top * 1.15
    lp.yValueAxis.labels.fontName, lp.yValueAxis.labels.fontSize, lp.yValueAxis.labels.fillColor = "Helvetica", 7, MUTED
    lp.yValueAxis.strokeColor, lp.yValueAxis.gridStrokeColor, lp.yValueAxis.visibleGrid = LINE, LINE, True
    lp.yValueAxis.labelTextFormat = (lambda v: f"${v:,.2f}") if c.get("unit") == "usd" else "{:,.0f}".format
    lp.xValueAxis.valueMin, lp.xValueAxis.valueMax = 1, len(labels)
    lp.xValueAxis.labels.fontName, lp.xValueAxis.labels.fontSize, lp.xValueAxis.labels.fillColor = "Helvetica", 7, MUTED
    lp.xValueAxis.strokeColor = LINE
    lp.xValueAxis.valueSteps = list(range(1, len(labels) + 1, max(1, len(labels) // 7)))
    short = [x[5:] if len(x) == 10 and x[4] == "-" else x[:8] for x in labels]
    lp.xValueAxis.labelTextFormat = lambda v: short[int(v) - 1] if 0 < int(v) <= len(short) else ""
    d.add(lp)
    d.add(String(10, h - 14, title, fontName="Helvetica-Bold", fontSize=9, fillColor=INK))
    if len(series) > 1:
        lg = Legend()
        lg.x, lg.y, lg.alignment, lg.columnMaximum = CONTENT_W - 10 - 80 * min(3, len(series)), h - 10, "right", 1
        lg.fontName, lg.fontSize, lg.dx, lg.dy, lg.deltax = "Helvetica", 7.5, 10, 2, 80
        lg.colorNamePairs = [(SERIES[i % len(SERIES)], str(s.get("name") or "")[:16]) for i, s in enumerate(series[:3])]
        d.add(lg)
    return d


def _box(rows: list[Any], accent: Any = BRAND_2) -> Table:
    t = Table([[r] for r in rows], colWidths=[CONTENT_W])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.white), ("BOX", (0, 0), (-1, -1), 0.6, LINE), ("LINEBEFORE", (0, 0), (0, -1), 3, accent), ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9), ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]))
    return t


def _sev(level: str) -> Table:
    fg, bg = SEVERITY.get(level, SEVERITY["low"])
    return _badge(level.upper(), fg, bg)


def _ev(ids: list[Any]) -> str:
    return "Evidence: " + ", ".join(_t(i, 12) for i in ids[:8]) if ids else ""


def _kpis(kpis: list[dict[str, Any]], per_row: int = 4) -> list[Any]:
    """KPI cards, four to a row at a fixed width (a single figure is one card wide, not the whole page)."""
    out: list[Any] = []
    def delta(k: dict[str, Any]) -> str:
        if k.get("change") is not None:
            return _delta(k.get("change"), k.get("better"))
        # A previous value of 0 has no relative change, but it is known: say what it was.
        return f'<font color="#64748b">previous {escape(fmt(k.get("previous"), k.get("format")))}</font>' if k.get("previous") is not None else ""

    cards = [(str(k.get("label") or "")[:34], fmt(k.get("value"), k.get("format")), delta(k)) for k in kpis if isinstance(k, dict)]
    for i in range(0, len(cards), per_row):
        chunk = cards[i : i + per_row]
        row = _kpi_cards(chunk)
        if len(chunk) < per_row:
            # _kpi_cards spreads its cards over the page width: scale its columns down to this many slots.
            slot = (CONTENT_W - 3 * mm * (per_row - 1)) / per_row
            scale = (slot * len(chunk) + 3 * mm * (len(chunk) - 1)) / CONTENT_W
            row._argW = [w * scale for w in row._argW]
            row.hAlign = "LEFT"
        out += [row, Spacer(1, 2.5 * mm)]
    return out


def render_site(report: dict[str, Any], analysis: dict[str, Any] | None = None, check: dict[str, Any] | None = None, *, generated: datetime | None = None) -> bytes:
    analysis = analysis or {}
    check = check or {}
    rng = report.get("range") or {}
    site = report.get("site") or {}
    start, end = str(rng.get("start") or ""), str(rng.get("end") or "")
    title = str(report.get("title") or "Site report")[:120]
    gen = (generated or datetime.now(UTC)).strftime("%d %b %Y %H:%M UTC")
    meta = {"title": f"{title} {start} – {end}", "subject": "MOKS site report", "site": str(site.get("name") or site.get("id") or ""), "header": f"{title} · {_nice(start)} – {_nice(end)}", "generated": gen}
    buf = io.BytesIO()
    doc = _SiteDoc(buf, meta)
    story: list[Any] = []
    cats = [c for c in report.get("categories") or [] if isinstance(c, dict)]
    findings = [f for f in report.get("findings") or [] if isinstance(f, dict)]
    sources = [s for s in report.get("sources") or [] if isinstance(s, dict)]
    has_ai = bool(analysis.get("executive_summary") or any(analysis.get(k) for k in ("root_causes", "fixes", "recommendations", "action_plan")))

    # Cover
    story += [Spacer(1, 8 * mm), Paragraph(_t(title, 120), _S["h1"]), Paragraph(_t(meta["site"], 80) + (f" · {_t(site.get('origin'), 80)}" if site.get("origin") else ""), _S["sub"]), Spacer(1, 3 * mm)]
    story.append(Paragraph(f"{_t(_nice(start))} – {_t(_nice(end))} ({_t(rng.get('days'))} days, {_t(rng.get('timezone') or 'Asia/Kolkata')}) &nbsp;·&nbsp; compared with {_t(_nice(str(rng.get('previousStart') or '')))} – {_t(_nice(str(rng.get('previousEnd') or '')))}", _S["body"]))
    story.append(Paragraph(f"Generated {_t(gen)} · Categories: {_t(', '.join(str(c.get('label')) for c in cats), 400)}", _S["small"]))
    scope = report.get("scope") or {}
    for key, label in (("crews", "Crews"), ("flows", "Flows"), ("sources", "Sources")):
        v = scope.get(key)
        if v and v != "all":
            story.append(Paragraph(f"{label}: {_t(', '.join(map(str, v)), 300)}", _S["small"]))
    story.append(Spacer(1, 4 * mm))
    unavailable = [s for s in sources if s.get("status") in ("unavailable", "error")]
    story.append(_badge(f"{len(unavailable)} data source(s) not available: see Data sources" if unavailable else "Every selected data source answered", WARN if unavailable else GOOD, WARN_BG if unavailable else GOOD_BG))
    story.append(Spacer(1, 1.5 * mm))
    if has_ai:
        removed = len(check.get("removed") or [])
        story.append(_badge("AI analysis: every number and evidence id checked" + (f"; {removed} item(s) left out" if removed else ""), GOOD if not removed else WARN, GOOD_BG if not removed else WARN_BG))
    else:
        story.append(_badge(f"No AI analysis: {str(report.get('aiUnavailable') or check.get('reason') or 'not available')[:120]}", WARN, WARN_BG))
    toc = TableOfContents()
    toc.levelStyles = [_X["toc0"]]
    story += [Spacer(1, 7 * mm), Paragraph("Contents", _X["h3"]), toc, PageBreak()]

    # Executive summary
    story.append(Paragraph("Executive summary", _S["h2"]))
    headline = [k for k in (report.get("summary") or {}).get("headline") or [] if isinstance(k, dict)]
    story += _kpis(headline[:8])
    if analysis.get("executive_summary"):
        story.append(KeepTogether([_box([Paragraph(_t(analysis["executive_summary"], 3000).replace("\n\n", "<br/><br/>").replace("\n", " "), _S["body"]), Paragraph("Written by the Report crew from the figures in this report; every number was checked against them.", _S["small"])], ACCENT)]))
    for key, label, accent in (("achievements", "Achievements", GOOD), ("risks", "Risks", BAD)):
        items = analysis.get(key) or []
        if items:
            story += [Paragraph(label, _X["h3"]), _box([Paragraph(f"• {_t(i.get('text'))} <font color='#64748b' size='7'>{_ev(i.get('evidence') or [])}</font>", _S["body"]) for i in items], accent)]

    # What is going wrong
    story += [CondPageBreak(50 * mm), Paragraph("What is going wrong", _S["h2"])]
    if findings:
        for f in findings[:40]:
            head = Table([[_sev(str(f.get("severity") or "low")), Paragraph(f"<b>{_t(f.get('title'), 200)}</b> <font color='#64748b'>· {_t(f.get('category'), 40)}{' · confirmed in the data' if f.get('confirmed') else ''}</font>", _S["body"])]], colWidths=[22 * mm, CONTENT_W - 22 * mm])
            head.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("LEFTPADDING", (0, 0), (-1, -1), 0)]))
            rows: list[Any] = [head, Paragraph(_t(f.get("detail"), 900), _S["body"])]
            if f.get("impact"):
                rows.append(Paragraph(f"<b>Impact:</b> {_t(f.get('impact'), 500)}", _S["small"]))
            rows.append(Paragraph(f"{_t(f.get('id'))} · {_ev(f.get('evidence') or [])}" + (f" · Owner: {_t(f.get('owner'), 80)}" if f.get("owner") else ""), _S["small"]))
            story += [KeepTogether([_box(rows, SEVERITY.get(str(f.get("severity")), SEVERITY["low"])[0])]), Spacer(1, 2 * mm)]
    else:
        story.append(Paragraph("No problem was found in the selected data for this period.", _S["body"]))

    # Root causes
    if analysis.get("root_causes"):
        story += [CondPageBreak(50 * mm), Paragraph("Root cause analysis", _S["h2"]), Paragraph("Confirmed: the evidence shows it directly. Probable: the most likely explanation from the evidence. Needs investigation: the data is not enough; the next check is named.", _S["small"]), Spacer(1, 2 * mm)]
        for rc in analysis["root_causes"]:
            label, fg, bg = STATUS.get(str(rc.get("status")), STATUS["investigate"])
            rows = [_badge(label + (" (shown as probable: its evidence is not direct)" if rc.get("downgraded") else ""), fg, bg), Paragraph(f"<b>{_t(rc.get('issue'), 300)}</b>", _S["body"]), Paragraph(_t(rc.get("cause"), 900), _S["body"])]
            if rc.get("next_check"):
                rows.append(Paragraph(f"<b>Next check:</b> {_t(rc.get('next_check'), 400)}", _S["small"]))
            rows.append(Paragraph(_ev(rc.get("evidence") or []), _S["small"]))
            story += [KeepTogether([_box(rows, fg)]), Spacer(1, 2 * mm)]

    # Fixes
    if analysis.get("fixes"):
        story += [CondPageBreak(50 * mm), Paragraph("What can be fixed", _S["h2"])]
        for fx in analysis["fixes"]:
            rows = [Table([[_sev(str(fx.get("severity") or "low")), Paragraph(f"<b>{_t(fx.get('issue'), 300)}</b>", _S["body"])]], colWidths=[22 * mm, CONTENT_W - 40 * mm])]
            rows += [Paragraph(f"<b>Impact:</b> {_t(fx.get('impact'))}", _S["body"]), Paragraph(f"<b>Fix:</b> {_t(fx.get('fix'), 900)}", _S["body"])]
            for i, step in enumerate(fx.get("steps") or [], start=1):
                rows.append(Paragraph(f"{i}. {_t(step, 300)}", _S["body"]))
            extra = " · ".join(x for x in (f"Expected outcome: {_t(fx.get('expected_outcome'), 300)}" if fx.get("expected_outcome") else "", f"Estimated effort: {_t(fx.get('effort'), 80)}" if fx.get("effort") else "", _ev(fx.get("evidence") or [])) if x)
            rows.append(Paragraph(extra, _S["small"]))
            story += [KeepTogether([_box(rows, SEVERITY.get(str(fx.get("severity")), SEVERITY["low"])[0])]), Spacer(1, 2 * mm)]

    # Recommendations
    if analysis.get("recommendations"):
        story += [CondPageBreak(40 * mm), Paragraph("AI improvement recommendations", _S["h2"])]
        by: dict[str, list[dict[str, Any]]] = {}
        for r in analysis["recommendations"]:
            by.setdefault(str(r.get("area") or "other"), []).append(r)
        for area, items in by.items():
            story += [Paragraph(_t(area.replace("_", " ").capitalize()), _X["h3"]), _box([Paragraph(f"• {_t(r.get('text'), 700)} <font color='#64748b' size='7'>{_ev(r.get('evidence') or [])}</font>", _S["body"]) for r in items])]

    # Action plan
    if analysis.get("action_plan"):
        story += [CondPageBreak(40 * mm), Paragraph("Action plan", _S["h2"]), Paragraph("Critical: act now · High: next · Medium: planned · Low: optional.", _S["small"]), Spacer(1, 2 * mm)]
        rows = [{"priority": a.get("priority"), "action": a.get("action"), "owner": a.get("owner") or "–", "evidence": ", ".join(a.get("evidence") or [])} for a in analysis["action_plan"]]
        story.append(_table([{"key": "priority", "label": "Priority", "width": 0.12}, {"key": "action", "label": "Action", "width": 0.53}, {"key": "owner", "label": "Owner", "width": 0.22}, {"key": "evidence", "label": "Evidence"}], rows, limit=30))

    # Categories
    for c in cats:
        story += [CondPageBreak(60 * mm), Paragraph(_t(c.get("label"), 80), _S["h2"])]
        status = str(c.get("status") or "ok")
        if status != "ok" or c.get("note"):
            story.append(_badge({"partial": "Some sources of this category are not available", "unavailable": "No source of this category is available"}.get(status, "Note") + (f": {str(c.get('note'))[:160]}" if c.get("note") else ""), WARN, WARN_BG))
            story.append(Spacer(1, 2 * mm))
        story += _kpis([k for k in c.get("kpis") or [] if isinstance(k, dict)][:12])
        for ch in c.get("charts") or []:
            d = _chart(ch) if isinstance(ch, dict) else None
            if d is not None:
                story += [d, Spacer(1, 3 * mm)]
        for t in c.get("tables") or []:
            if isinstance(t, dict) and t.get("rows"):
                story += [CondPageBreak(30 * mm), Paragraph(f"{_t(t.get('title'), 100)} <font color='#64748b' size='7'>{_t(t.get('id'))}</font>", _X["h3"]), _table(t.get("columns") or [], t["rows"])]
                if t.get("note"):
                    story.append(Paragraph(_t(t["note"], 300), _S["small"]))
                story.append(Spacer(1, 2 * mm))

    # Data sources
    story += [CondPageBreak(40 * mm), Paragraph("Data sources", _S["h2"]), Paragraph("Every source this report read, with what it returned. A source that is not available is reported here, never left out silently or filled in.", _S["small"]), Spacer(1, 2 * mm)]
    story.append(_table([{"key": "label", "label": "Source", "width": 0.26}, {"key": "category", "label": "Category", "width": 0.17}, {"key": "status", "label": "Status", "width": 0.15}, {"key": "rows", "label": "Rows", "format": "int", "width": 0.1}, {"key": "detail", "label": "Detail"}], [{**s, "status": SOURCE_STATUS.get(str(s.get("status")), s.get("status"))} for s in sources], limit=80))
    if check.get("removed"):
        story += [Spacer(1, 4 * mm), Paragraph("Left out of the AI analysis", _X["h3"]), Paragraph("Items the Report crew wrote that did not pass the check (a number not in the report's figures, or no evidence from this report):", _S["small"])]
        story.append(_table([{"key": "section", "label": "Section", "width": 0.17}, {"key": "reason", "label": "Why", "width": 0.33}, {"key": "text", "label": "Text"}], [{**r, "section": str(r.get("section") or "").replace("_", " ")} for r in check["removed"]], limit=40))
    doc.multiBuild(story)
    return buf.getvalue()
