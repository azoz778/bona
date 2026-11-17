#!/usr/bin/env python3
"""Bona intake — the listing brochure, rebuilt from scratch in the TK brochure design system.

Run through uv so nothing has to be installed on the box:

    uv run --with weasyprint --with segno --with pillow --with pymupdf python -I \\
        services/intake/brochure_pdf.py <listing.json> <files-dir> <site.json> <out.pdf> \\
        [--max-mb 25] [--work <dir>]

  <listing.json>  the final site listing (src/data/LISTING-SCHEMA.md). `_intake` and `hidden` are
                  never read, so nothing the intake keeps for itself can reach the page.
  <files-dir>     the listing's folder, staged or published: 01.jpg… photos and plan-NN.jpg floor
                  plans. Any listing path (`/listings/<slug>/02.jpg`) is read as <files-dir>/<basename>.
  <site.json>     src/data/site.json: url, phone, WhatsApp, email, hours, tagline, FAL licence.
  --work          keep the prepared images, logos and QR there (default: a temporary folder under
                  ~/.cache that is removed afterwards).

ONE bilingual A4 PDF, English left and Arabic right on every page, in the TK system (black and
white, Cormorant Garamond / Montserrat / Amiri / Tajawal, 0.4pt hairlines, 20mm margins), branded
Bona. Fixed 210 x 297mm canvases, in this order (spec §5):

  1 flysheet · 2 cover · 3 the project / the property (+ continuation pages) · 4 residences & prices
  · 5 one page per model with a floor plan · 6 photo pages · 7 amenities & terms · 8 location &
  enquiries.

What is printed comes from the listing's own fields, its photos and floor plans, and site.json —
nothing else. The developer is named as text only; there is no developer logo, phone, email,
URL or address anywhere. Every number is a printed figure from the listing (ranges are min–max of
those figures), digits are Western throughout, every string is HTML-escaped.

Layout never relies on guesswork. Before the brochure is drawn, the text blocks that can grow
(narrative paragraphs, table rows, amenity rows) are measured with WeasyPrint at their real
column widths, and the pages are cut from those heights; the finished render is then checked box
by box (no text block may run into the ledger, the footer, the enquiry block or off the page) and
re-cut tighter if it does. A layout that still does not fit fails the run rather than printing
overlapping text.

Images are downsampled to ~300dpi of their printed box (cover 2400px long side, hero 2100, half
1400, plan 1800; JPEG q86). Over --max-mb the brochure is re-rendered with images at 0.75 and
then 0.55 of that; still over, the output is deleted and the result is too-large.

Result (ONE JSON line on stdout; exit 1 on failure, never a bare traceback):

    {"ok": true, "out": "…/brochure.pdf", "bytes": 2345678, "pages": 13, "maxBytes": 26214400,
     "steps": ["measure", "render", "write"], "kinds": ["flysheet", "cover", "narrative", …],
     "id": "BONA-W023"}
    {"ok": false, "reason": "too-large" | "error", "error": "…"}
"""
from __future__ import annotations

import argparse
import html
import json
import math
import os
import pathlib
import re
import shutil
import sys
import tempfile
import traceback

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
FONT_DIR = HERE / "assets" / "fonts"
LOGO_SVG = REPO / "public" / "logo.svg"

DEFAULT_MAX_MB = 25.0
MB = 1024 * 1024
SCALES = (1.0, 0.75, 0.55)                       # image scale per size pass
ROLE_PX = {"cover": 2400, "hero": 2100, "half": 1400, "plan": 1800}   # long side at scale 1
JPEG_Q = 86
PX_MM = 25.4 / 96.0                              # CSS px -> mm
SAFE_BOTTOM = 289.0                              # no text block may run below this (mm from the top)
CHECK_GAP = 3.0                                  # render check: clearance between a text block and what is under it
TEXT_GAP = 7.0                                   # pagination: clearance kept above the ledger / footer / note
MAX_TABLE_ROWS = 10
COL_W = 79.5                                     # a .cols column: (170mm text width - 11mm gap) / 2
MAX_SENTENCE_UNITS = 16                          # a longer paragraph is cut in this many pieces at most

FONT_FACES = [
    ("Cormorant Garamond", "CormorantGaramond-300.ttf", 300),
    ("Cormorant Garamond", "CormorantGaramond-400.ttf", 400),
    ("Cormorant Garamond", "CormorantGaramond-500.ttf", 500),
    ("Montserrat", "Montserrat-300.ttf", 300),
    ("Montserrat", "Montserrat-400.ttf", 400),
    ("Montserrat", "Montserrat-500.ttf", 500),
    ("Montserrat", "Montserrat-600.ttf", 600),
    ("Amiri", "Amiri-Regular.ttf", 400),
    ("Tajawal", "Tajawal-Light.ttf", 300),
    ("Tajawal", "Tajawal-Regular.ttf", 400),
    ("Tajawal", "Tajawal-Medium.ttf", 500),
]

# ---- TK brochure CSS, verbatim from tk-property-brochure/scripts/build_brochure.py ---------------
CSS = """
@page { size: A4; margin: 0; }
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#fff; color:#000; }
.page { width:210mm; height:297mm; position:relative; overflow:hidden;
        page-break-after:always; background:#fff; }
.page:last-child { page-break-after:auto; }
.pad { padding:0 20mm; }

.eyebrow { font-family:'Montserrat'; font-weight:500; font-size:6.6pt;
           letter-spacing:.32em; text-transform:uppercase; }
.eyebrow.muted { color:#767676; }
.ar-lab { font-family:'Tajawal'; font-weight:400; font-size:7.4pt;
          direction:rtl; color:#767676; }
.display { font-family:'Cormorant Garamond'; font-weight:300; line-height:1.03;
           letter-spacing:-.005em; }
.ar-display { font-family:'Amiri'; font-weight:400; direction:rtl; }
.body-en { font-family:'Montserrat'; font-weight:300; font-size:8.4pt;
           line-height:1.85; color:#1c1c1c; }
.body-ar { font-family:'Tajawal'; font-weight:300; font-size:9pt; line-height:2.0;
           direction:rtl; text-align:right; color:#1c1c1c; }

.runhead { position:absolute; top:14mm; left:20mm; right:20mm;
           display:flex; justify-content:space-between; align-items:baseline; }
.footer { position:absolute; bottom:11mm; left:20mm; right:20mm;
          display:flex; justify-content:space-between; align-items:center;
          font-family:'Montserrat'; font-weight:400; font-size:6pt;
          letter-spacing:.26em; text-transform:uppercase; color:#8a8a8a; }

/* flysheet */
.title-page { background:#000; }
.tp-mark { position:absolute; top:0; left:0; right:0; height:168mm; }
.tp-mark img { position:absolute; bottom:0; left:50%; margin-left:-30.5mm; height:68mm; }
.tp-rule { position:absolute; top:180mm; left:50%; margin-left:-18mm; width:36mm;
           height:.4pt; background:#5a5a5a; }
.tp-line { position:absolute; top:189mm; left:0; right:0; text-align:center;
           font-family:'Montserrat'; font-weight:400; font-size:6.4pt;
           letter-spacing:.42em; text-indent:.42em; text-transform:uppercase; color:#c9c9c9; }
.tp-ar { position:absolute; top:197mm; left:0; right:0; text-align:center;
         font-family:'Tajawal'; font-weight:300; font-size:8pt; direction:rtl; color:#8a8a8a; }
.tp-foot { position:absolute; bottom:16mm; left:0; right:0; text-align:center;
           font-family:'Montserrat'; font-weight:400; font-size:5.8pt;
           letter-spacing:.3em; text-indent:.3em; text-transform:uppercase; color:#6a6a6a; }

/* cover */
.cover-img { position:absolute; top:0; left:0; width:210mm; height:178mm;
             background-size:cover; background-position:center 58%; }
.cover-body { position:absolute; top:200mm; left:20mm; right:20mm; }
.cover-title { font-family:'Cormorant Garamond'; font-weight:300; font-size:41pt;
               line-height:1.02; margin-top:7mm; }
.cover-title-ar { font-family:'Amiri'; direction:rtl; font-size:23pt; margin-top:4mm;
                  line-height:1.5; }
.cover-meta { margin-top:9mm; padding-top:4.5mm; border-top:.4pt solid #000;
              display:flex; justify-content:space-between; align-items:baseline; }

/* overview */
.lead { position:absolute; top:42mm; left:20mm; right:20mm; }
.lead h1 { font-family:'Cormorant Garamond'; font-weight:300; font-size:34pt; line-height:1.04; }
.lead .ar-h { font-family:'Amiri'; direction:rtl; font-size:19pt; margin-top:4mm; }
.cols { display:flex; gap:11mm; margin-top:11mm; }
.cols > div { flex:1; }

/* specification ledger */
.ledger { position:absolute; left:20mm; right:20mm; bottom:32mm; }
.ledger-head { display:flex; justify-content:space-between; align-items:baseline;
               padding-bottom:3mm; border-bottom:.4pt solid #000; }
.ledger-row { display:flex; border-bottom:.4pt solid #c9c9c9; }
.cell { flex:1; padding:6.5mm 0 5.5mm 0; border-right:.4pt solid #c9c9c9; text-align:center; }
.cell:last-child { border-right:none; }
.cell .fig { font-family:'Cormorant Garamond'; font-weight:300; font-size:34pt; line-height:1;
             font-variant-numeric:lining-nums; font-feature-settings:'lnum' 1,'onum' 0; }
.cell .fig sup { font-family:'Montserrat'; font-weight:400; font-size:8pt;
                 letter-spacing:.1em; vertical-align:super; }
.cell .lab { font-family:'Montserrat'; font-weight:500; font-size:5.8pt;
             letter-spacing:.26em; text-transform:uppercase; margin-top:4mm; }
.cell .lab-ar { font-family:'Tajawal'; font-weight:400; font-size:7pt;
                direction:rtl; color:#8a8a8a; margin-top:1.4mm; }

/* plates */
.plate { background-size:cover; }
.grid2 { display:flex; gap:6mm; }
.grid2 > div { flex:1; }
.cap { display:flex; justify-content:space-between; align-items:baseline;
       margin-top:3mm; padding-top:2.6mm; border-top:.4pt solid #c9c9c9; }
.cap .en { font-family:'Montserrat'; font-weight:500; font-size:6.2pt;
           letter-spacing:.26em; text-transform:uppercase; }
.cap .ar { font-family:'Tajawal'; font-weight:400; font-size:7.4pt;
           direction:rtl; color:#767676; }

/* inclusions */
.spec-item { display:flex; justify-content:space-between; align-items:baseline;
             padding:3.1mm 0; border-bottom:.4pt solid #dcdcdc; }
.spec-item .en { font-family:'Montserrat'; font-weight:400; font-size:7.8pt; color:#111; }
.spec-item .ar { font-family:'Tajawal'; font-weight:400; font-size:8.4pt;
                 direction:rtl; color:#111; }
.spec-group { display:flex; justify-content:space-between; align-items:baseline;
              padding:0 0 2.2mm; margin-top:7mm; border-bottom:.4pt solid #000; }
.spec-group:first-child { margin-top:0; }
.spec-group .en { font-family:'Montserrat'; font-weight:500; font-size:6.2pt;
                  letter-spacing:.34em; text-transform:uppercase; color:#111; }
.spec-group .ar { font-family:'Tajawal'; font-weight:400; font-size:7.4pt;
                  direction:rtl; color:#767676; }
.terms { display:flex; gap:11mm; margin-top:12mm; }
.terms > div { flex:1; border-top:.4pt solid #000; padding-top:3.5mm; }
.terms .v { font-family:'Cormorant Garamond'; font-weight:300; font-size:17pt; margin-top:2mm;
            font-variant-numeric:lining-nums; font-feature-settings:'lnum' 1,'onum' 0; }
.terms .v-ar { font-family:'Tajawal'; font-weight:400; font-size:7.4pt;
               direction:rtl; color:#767676; margin-top:1.5mm; }

/* location */
.loc { position:absolute; top:42mm; left:20mm; right:20mm; }
.loc h1 { font-family:'Cormorant Garamond'; font-weight:300; font-size:32pt; line-height:1.05; }
.loc .ar-h { font-family:'Amiri'; direction:rtl; font-size:18pt; margin-top:3mm; }
.qr-block { display:flex; gap:12mm; margin-top:14mm; align-items:flex-start; }
.qr-tile { width:48mm; }
.qr-tile img { width:48mm; height:48mm; display:block; border:.4pt solid #000; }
.qr-tile .cta { font-family:'Montserrat'; font-weight:500; font-size:5.8pt;
                letter-spacing:.26em; text-transform:uppercase; margin-top:3.5mm;
                text-align:center; }
.qr-tile .cta-ar { font-family:'Tajawal'; font-weight:400; font-size:7pt; direction:rtl;
                   color:#767676; margin-top:1.5mm; text-align:center; }
.loc-facts { flex:1; padding-top:1mm; }
.loc-fact { border-top:.4pt solid #c9c9c9; padding:3.5mm 0 4.5mm 0; }
.loc-fact:first-child { border-top:.4pt solid #000; }
.loc-fact .k { font-family:'Montserrat'; font-weight:500; font-size:5.8pt;
               letter-spacing:.26em; text-transform:uppercase; color:#767676; }
.loc-fact .k .sep { letter-spacing:0; margin:0 1.4mm 0 .4mm; color:#b8b8b8; }
.loc-fact .k .k-ar { font-family:'Tajawal'; font-weight:400; font-size:7pt;
                     letter-spacing:0; text-transform:none; direction:rtl;
                     unicode-bidi:isolate; }
.loc-fact .v { font-family:'Montserrat'; font-weight:300; font-size:8.4pt; margin-top:1.8mm;
               color:#111; }
.map-btn { display:flex; justify-content:space-between; align-items:center;
           background:#000; color:#fff; text-decoration:none; padding:6.5mm 8mm;
           margin-top:11mm; }
.map-btn .l { font-family:'Montserrat'; font-weight:500; font-size:7.4pt;
              letter-spacing:.26em; text-transform:uppercase; color:#fff; }
.map-btn .r { font-family:'Tajawal'; font-weight:400; font-size:8.4pt;
              direction:rtl; color:#c4c4c4; }

/* enquiry */
.enquiry { position:absolute; left:0; right:0; bottom:0; background:#000; color:#fff;
           padding:13mm 20mm; }
.enquiry .k { font-family:'Montserrat'; font-weight:500; font-size:6pt;
              letter-spacing:.32em; text-transform:uppercase; color:#9a9a9a; }
.enquiry h2 { font-family:'Cormorant Garamond'; font-weight:300; font-size:23pt;
              color:#fff; margin-top:3.5mm; line-height:1.1; }
.enquiry .ar { font-family:'Tajawal'; font-weight:300; font-size:8pt; direction:rtl;
               color:#c4c4c4; margin-top:3mm; max-width:104mm; text-align:left; }
.enquiry .lines { display:flex; gap:7mm; margin-top:9mm; }
.enquiry .lines > div { flex:1; border-top:.4pt solid #4a4a4a; padding-top:3mm; }
.enquiry .lines .k2 { font-family:'Montserrat'; font-weight:500; font-size:5.6pt;
                      letter-spacing:.26em; text-transform:uppercase; color:#8a8a8a;
                      min-height:5.6mm; }
.enquiry .lines .v2 { font-family:'Montserrat'; font-weight:300; font-size:7.6pt;
                      color:#fff; margin-top:2mm; line-height:1.6; }
.enquiry .lines .v2 a { color:#fff; text-decoration:none; }
.enq-logo { position:absolute; top:11mm; right:20mm; height:19mm; }
"""

# ---- the approved Bona sample's extra components (bona-debug-w023/dirs/tk_style.py) --------------
EXTRA = """
.tp-mark img.wide { height:auto; width:112mm; margin-left:-56mm; }
.units { width:100%; border-collapse:collapse; margin-top:12mm; }
.units th { font-family:'Montserrat'; font-weight:500; font-size:5.8pt; letter-spacing:.26em; text-transform:uppercase;
            text-align:right; padding:0 0 1.2mm; vertical-align:bottom; }
.units th span { display:block; font-family:'Tajawal'; font-weight:400; font-size:7pt; letter-spacing:0; color:#8a8a8a; margin-top:1mm; }
.units th:first-child, .units td:first-child { text-align:left; }
.units thead tr { border-bottom:.4pt solid #000; }
.units td { padding:4mm 0 3.6mm; border-bottom:.4pt solid #c9c9c9; text-align:right; font-family:'Montserrat'; font-weight:300; font-size:8.2pt;
            font-variant-numeric:lining-nums tabular-nums; }
.units td .nm { font-family:'Cormorant Garamond'; font-weight:400; font-size:14pt; }
.units td .nm-ar { font-family:'Tajawal'; font-weight:400; font-size:7.6pt; color:#767676; margin-left:2mm; }
.note { font-family:'Montserrat'; font-weight:300; font-size:6.6pt; line-height:1.7; color:#767676; margin-top:6mm; }
.note-ar { font-family:'Tajawal'; font-weight:300; font-size:7.4pt; line-height:1.8; color:#767676; direction:rtl; text-align:right; margin-top:1.5mm; }
.planbox { margin-top:10mm; height:118mm; display:flex; align-items:center; justify-content:center; }
.planbox img { max-width:170mm; max-height:118mm; }
.ledger.small .cell .fig { font-size:26pt; }
.floors { font-family:'Montserrat'; font-weight:300; font-size:7.6pt; color:#111; margin-top:2mm; }
"""

# ---- Bona additions: fixed column widths (so measuring = printing), paragraph rhythm, small fixes --
BONA_CSS = """
.cols > div { flex:0 0 79.5mm; width:79.5mm; min-width:0; }
.cols.cont { margin-top:0; }
.body-en p + p { margin-top:1.85em; }
.body-ar p + p { margin-top:2em; }
.units { table-layout:fixed; }
.units td { vertical-align:baseline; }
.units td.nmc { padding-right:3mm; }
.cap { gap:5mm; }
.cap .ar { text-align:right; }
.spec-item { gap:5mm; }
.spec-item .ar { text-align:right; }
.spec-group { gap:5mm; }
.terms .v.long { font-size:13pt; line-height:1.2; }
.terms .floors-ar { font-family:'Tajawal'; font-weight:400; font-size:7.4pt; direction:rtl; color:#767676; margin-top:1.5mm; }
.loc-fact .v-ar { font-family:'Tajawal'; font-weight:300; font-size:8.4pt; direction:rtl; text-align:left; color:#767676; margin-top:1mm; }
.enquiry { left:-.6mm; right:-.6mm; bottom:-.6mm; padding:13mm 20.6mm 13.6mm; }
.enquiry .lines .v2 .v2-ar { display:block; font-family:'Tajawal'; font-weight:300; font-size:7.6pt;
                             direction:rtl; text-align:left; color:#c4c4c4; margin-top:1mm; }
.cover-img { left:-.6mm; top:-.6mm; width:211.2mm; height:178.6mm; }
.title-page { background:#000; }
"""

# ---- vocabulary ---------------------------------------------------------------------------------
TYPE_LABELS = {  # src/lib/listings.ts typeLabels, plus English plurals for a project of several layouts
    "villa": ("Villa", "Villas"), "apartment": ("Apartment", "Apartments"),
    "penthouse": ("Penthouse", "Penthouses"), "mansion": ("Mansion", "Mansions"),
    "land": ("Land", "Land"), "building": ("Building", "Buildings"), "duplex": ("Duplex", "Duplexes"),
    "townhouse": ("Townhouse", "Townhouses"), "chalet": ("Chalet", "Chalets"),
    "office": ("Office", "Offices"), "residence": ("Residence", "Residences"),
}
CATEGORY_LABELS = {"buy": "For Sale", "rent": "For Rent", "off-plan": "Off-Plan",
                   "international": "International"}
CURRENCY_AR = {"SAR": "ر.س", "AED": "د.إ", "USD": "دولار", "EUR": "يورو", "OMR": "ر.ع",
               "GBP": "جنيه إسترليني"}
EN_NUMBER = {1: "One", 2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six", 7: "Seven",
             8: "Eight", 9: "Nine", 10: "Ten", 11: "Eleven", 12: "Twelve"}
AR_NUMBER = {3: "ثلاثة", 4: "أربعة", 5: "خمسة", 6: "ستة", 7: "سبعة", 8: "ثمانية", 9: "تسعة",
             10: "عشرة"}
PRICE_NOTE = ("Prices as printed in the developer's brochure.",
              "الأسعار كما وردت في كتيب المطوّر.")
SAKANI_NOTE = ("Prices as printed in the developer's brochure. The Sakani price applies to "
               "housing-support beneficiaries.",
               "الأسعار كما وردت في كتيب المطوّر، وسعر مستفيدي الدعم لمستفيدي برنامج سكني.")


class BrochureError(Exception):
    """A listing, site.json or file problem the caller can act on (printed as the error)."""


class TooLarge(Exception):
    pass


# ---- text helpers -------------------------------------------------------------------------------
_WESTERN = {**{0x0660 + i: str(i) for i in range(10)}, **{0x06F0 + i: str(i) for i in range(10)},
            0x066B: ".", 0x066C: ","}


def west(s) -> str:
    """Arabic-Indic and Persian digits (and the Arabic decimal/thousands marks) -> ASCII."""
    return str(s).translate(_WESTERN)


def esc(s) -> str:
    return html.escape(west("" if s is None else s), quote=True)


def text(v) -> str:
    return west(v).strip() if isinstance(v, str) else ""


def loc(obj, lang: str) -> str:
    return text(obj.get(lang)) if isinstance(obj, dict) else ""


def num(v):
    """A finite number from a JSON number (or a plain numeric string); None otherwise."""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v) if math.isfinite(v) else None
    if isinstance(v, str):
        s = west(v).replace(",", "").strip()
        if re.fullmatch(r"\d+(?:\.\d+)?", s):
            return float(s)
    return None


def fmt_money(v) -> str:
    return f"{round(v):,}"


def fmt_area(v) -> str:
    s = f"{v:,.2f}"
    return s[:-3] if s.endswith(".00") else s


def fmt_plain(v) -> str:
    return str(int(v)) if float(v).is_integer() else f"{v:g}"


def fmt_count(v) -> str:
    return f"{int(v):02d}" if float(v).is_integer() and 0 <= v < 10 else fmt_plain(v)


def fmt_range(values) -> str:
    lo, hi = min(values), max(values)
    return fmt_count(lo) if lo == hi else f"{fmt_plain(lo)}–{fmt_plain(hi)}"


def money_en(amount, cur) -> str:
    return f"{cur} {fmt_money(amount)}"


def money_ar(amount, cur) -> str:
    return f"{fmt_money(amount)} {CURRENCY_AR.get(cur, cur)}"


def dedupe(parts):
    out = []
    for p in parts:
        if p and p not in out:
            out.append(p)
    return out


def paragraphs(s: str):
    return [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", s or "") if p.strip()]


def sentences(p: str, lang: str):
    if lang == "ar":
        parts = re.split(r"(?<=[.!?؟])\s+", p)
    else:
        parts = re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"“‘(\[])", p)
    parts = [x for x in (q.strip() for q in parts) if x]
    if len(parts) > MAX_SENTENCE_UNITS:          # bound the measuring work: merge into at most N pieces
        size = math.ceil(len(parts) / MAX_SENTENCE_UNITS)
        parts = [" ".join(parts[i:i + size]) for i in range(0, len(parts), size)]
    return parts


def strip_title(alt: str, title: str) -> str:
    """'Garden — Araco Jeddah Heights Apartments, Jeddah' -> 'Garden'. The intake writes every alt
    as '<room> — <listing title>'; the last segment goes when it is the title (or its start), or when
    it is a title-like run of three or more words (a title edited after the photos were labelled).
    A short qualifier ('Living room — sea view') stays."""
    if not alt:
        return ""
    if title and alt == title:
        return ""
    for sep in (" — ", " – ", " | "):
        if sep in alt:
            head, rest = alt.rsplit(sep, 1)
            rest = rest.strip()
            stem = re.split(r"[,،]", title)[0].strip() if title else ""
            if head.strip() and rest and (
                    (title and (rest == title or title.startswith(rest) or (stem and rest.startswith(stem))))
                    or len(rest.split()) >= 3):
                return head.strip()
    return alt


# ---- the listing, normalised and checked --------------------------------------------------------
class Model:
    def __init__(self, raw: dict, i: int):
        name = raw.get("name")
        self.name_en, self.name_ar = loc(name, "en"), loc(name, "ar")
        if not self.name_en and not self.name_ar:
            raise BrochureError(f"models[{i}].name is missing")
        self.beds, self.baths = num(raw.get("bedrooms")), num(raw.get("bathrooms"))
        self.area = num(raw.get("areaSqm"))
        av = raw.get("availability")
        self.avail_en, self.avail_ar = loc(av, "en"), loc(av, "ar")
        self.price, self.sakani = num(raw.get("price")), num(raw.get("subsidisedPrice"))
        fp = raw.get("floorPlan")
        self.plan = text(fp.get("src")) if isinstance(fp, dict) else ""


class Listing:
    def __init__(self, raw, site):
        if not isinstance(raw, dict):
            raise BrochureError("the listing is not a JSON object")
        if not isinstance(site, dict):
            raise BrochureError("site.json is not a JSON object")
        self.id, self.slug = text(raw.get("id")), text(raw.get("slug"))
        if not self.id:
            raise BrochureError("listing.id is missing")
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", self.slug):
            raise BrochureError("listing.slug is missing or not URL-safe")
        t = raw.get("title")
        self.title_en, self.title_ar = loc(t, "en"), loc(t, "ar")
        if not self.title_en or not self.title_ar:
            raise BrochureError("listing.title needs en and ar")
        lc = raw.get("location") if isinstance(raw.get("location"), dict) else {}
        self.district_en, self.district_ar = loc(lc.get("district"), "en"), loc(lc.get("district"), "ar")
        self.city_en, self.city_ar = loc(lc.get("city"), "en"), loc(lc.get("city"), "ar")
        self.country_en = loc(lc.get("country"), "en")
        if not self.city_en:
            raise BrochureError("listing.location.city.en is missing")
        self.type = text(raw.get("type")).lower()
        self.category = text(raw.get("category")).lower()
        pr = raw.get("price")
        if pr is not None and not isinstance(pr, dict):
            raise BrochureError("listing.price is not an object")
        pr = pr or {}
        self.currency = text(pr.get("currency")) or "SAR"
        self.amount = num(pr.get("amount"))
        self.on_request = bool(pr.get("onRequest")) or self.amount is None
        self.price_from = bool(pr.get("from"))
        self.period = pr.get("period") if pr.get("period") in ("year", "month") else None
        self.sakani = None if self.on_request else num(pr.get("subsidisedAmount"))
        sp = raw.get("specs") if isinstance(raw.get("specs"), dict) else {}
        self.specs = {k: num(sp.get(k)) for k in ("beds", "baths", "areaSqm", "plotSqm", "yearBuilt", "floors")}
        imgs = raw.get("images")
        if not isinstance(imgs, list) or not imgs:
            raise BrochureError("listing.images is empty")
        self.images = []
        for i, im in enumerate(imgs):
            if not isinstance(im, dict) or not text(im.get("src")):
                raise BrochureError(f"listing.images[{i}].src is missing")
            f = im.get("focus") if isinstance(im.get("focus"), dict) else None
            fx, fy = (num(f.get("x")), num(f.get("y"))) if f else (None, None)
            self.images.append({"src": text(im.get("src")), "alt_en": loc(im.get("alt"), "en"),
                                "alt_ar": loc(im.get("alt"), "ar"),
                                "focus": (fx, fy) if fx is not None and fy is not None else None})
        d = raw.get("description")
        self.desc_en, self.desc_ar = paragraphs(loc(d, "en")), paragraphs(loc(d, "ar"))
        pj = raw.get("project") if isinstance(raw.get("project"), dict) else None
        self.project = pj is not None
        self.project_en = loc(pj.get("name"), "en") if pj else ""
        self.project_ar = loc(pj.get("name"), "ar") if pj else ""
        dev = pj.get("developer") if pj else None
        self.dev_en, self.dev_ar = loc(dev, "en"), loc(dev, "ar")
        models = raw.get("models")
        if models is not None and not isinstance(models, list):
            raise BrochureError("listing.models is not a list")
        self.models = [Model(m, i) if isinstance(m, dict) else self._bad_model(i)
                       for i, m in enumerate(models or [])]
        self.amenities = self._pairs(raw.get("amenities"), "amenities")
        self.nearby = self._pairs(raw.get("nearby"), "nearby")
        self.warranties = self._pairs(raw.get("warranties"), "warranties")
        mp = raw.get("map") if isinstance(raw.get("map"), dict) else None
        lat, lng = (num(mp.get("lat")), num(mp.get("lng"))) if mp else (None, None)
        self.exact_pin = (lat, lng) if (lat is not None and lng is not None and
                                         raw.get("mapPrecision") == "exact") else None
        # site.json
        self.site_url = text(site.get("url")).rstrip("/")
        if not re.fullmatch(r"https?://[A-Za-z0-9.-]+(?::\d+)?", self.site_url):
            raise BrochureError("site.json url is missing or not an origin")
        self.site_host = re.sub(r"^https?://", "", self.site_url)
        self.url = f"{self.site_url}/properties/{self.slug}/"
        ph, wa = site.get("phone") or {}, site.get("whatsapp") or {}
        self.phone = text(ph.get("display")) or text(wa.get("display"))
        self.wa = re.sub(r"\D", "", text(wa.get("wa")) or text(wa.get("e164")))
        self.email = text(site.get("email"))
        if not self.phone or not self.wa or not self.email:
            raise BrochureError("site.json needs phone.display, whatsapp.wa and email")
        self.hours_en, self.hours_ar = loc(site.get("hours"), "en"), loc(site.get("hours"), "ar")
        self.tag_en = loc(site.get("tagline"), "en").rstrip(".") or "Exceptional homes, quietly"
        self.tag_ar = loc(site.get("tagline"), "ar").rstrip(".") or "منازل استثنائية، بهدوء"
        self.fal = text((site.get("licences") or {}).get("fal"))
        if not self.country_en:
            self.country_en = text(((site.get("address") or {}).get("en") or {}).get("country"))

    @staticmethod
    def _bad_model(i):
        raise BrochureError(f"models[{i}] is not an object")

    @staticmethod
    def _pairs(v, key):
        if v is None:
            return []
        if not isinstance(v, dict) or not isinstance(v.get("en", []), list) or not isinstance(v.get("ar", []), list):
            raise BrochureError(f"listing.{key} must be {{en: [], ar: []}}")
        en, ar = v.get("en") or [], v.get("ar") or []
        out = []
        for i in range(max(len(en), len(ar))):
            a, b = text(en[i]) if i < len(en) else "", text(ar[i]) if i < len(ar) else ""
            if a or b:
                out.append((a, b))
        return out

    # derived text -------------------------------------------------------------------------------
    def price_en(self) -> str:
        if self.on_request:
            return "Price on request"
        s = ("From " if self.price_from else "") + money_en(self.amount, self.currency)
        return s + (f" / {self.period}" if self.period else "")

    def type_label(self, plural=False) -> str:
        pair = TYPE_LABELS.get(self.type)
        if pair:
            return pair[1] if plural else pair[0]
        return self.type.capitalize()

    def country_line(self) -> str:
        c = self.country_en
        return "Kingdom of Saudi Arabia" if c.lower() in ("saudi arabia", "ksa", "the kingdom of saudi arabia") else c


# ---- images -------------------------------------------------------------------------------------
class Images:
    """Prepares each photo / plan once per role at scale 1, then derives the smaller passes from that
    file (so every source is read exactly once)."""

    def __init__(self, files_dir: pathlib.Path, work: pathlib.Path):
        self.files_dir, self.work = files_dir, work
        self.base = {}

    def source(self, src: str) -> pathlib.Path:
        name = os.path.basename(src.split("?")[0].split("#")[0])
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.(?:jpe?g|png|webp)", name, re.I):
            raise BrochureError(f"unusable image path: {src}")
        p = self.files_dir / name
        if not p.is_file():
            raise BrochureError(f"image not found in files-dir: {name}")
        return p

    def path(self, src: str, role: str, scale: float) -> pathlib.Path:
        from PIL import Image, ImageOps
        key = (src, role)
        if key not in self.base:
            p = self.source(src)
            dst = self.work / f"{re.sub(r'[^A-Za-z0-9]+', '-', p.stem)}-{role}.jpg"
            with Image.open(p) as im:
                try:
                    im.draft(im.mode, (ROLE_PX[role], ROLE_PX[role]))  # JPEG: decode at a reduced scale when far larger
                except (OSError, ValueError):
                    pass
                im = self._flat(ImageOps.exif_transpose(im))
                if role != "plan":                                   # plans are white-ground drawings
                    im = self._trim_white(im)
                im = self._fit(im, ROLE_PX[role])
                im.save(dst, "JPEG", quality=JPEG_Q, optimize=True)
            self.base[key] = dst
        base = self.base[key]
        if scale >= 1.0:
            return base
        dst = base.with_name(f"{base.stem}-{int(scale * 100)}.jpg")
        if not dst.exists():
            with Image.open(base) as im:
                target = round(ROLE_PX[role] * scale)
                if max(im.size) <= target:
                    return base
                self._fit(im.convert("RGB"), target).save(dst, "JPEG", quality=JPEG_Q, optimize=True)
        return dst

    @staticmethod
    def _flat(im):
        from PIL import Image
        if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
            im = im.convert("RGBA")
            bg = Image.new("RGB", im.size, (255, 255, 255))
            bg.paste(im, mask=im.getchannel("A"))
            return bg
        return im.convert("RGB")

    @staticmethod
    def _trim_white(im, limit=0.06):
        """Drop thin pure-white bands that run the full length of an edge (the extraction leaves
        some photos with ~20px white side margins). A side is trimmed only when its band is at most
        `limit` of the image, so a real white wall or sky is never cut."""
        mask = im.convert("L").point(lambda v: 255 if v < 246 else 0)   # LUT, not a per-pixel loop
        box = mask.getbbox()
        if not box:
            return im
        w, h = im.size
        l, t, r, b = box
        l = l if 2 <= l <= limit * w else 0
        t = t if 2 <= t <= limit * h else 0
        r = r if 2 <= w - r <= limit * w else w
        b = b if 2 <= h - b <= limit * h else h
        return im if (l, t, r, b) == (0, 0, w, h) else im.crop((l, t, r, b))

    @staticmethod
    def _fit(im, long_side):
        from PIL import Image
        w, h = im.size
        if max(w, h) > long_side:
            s = long_side / max(w, h)
            im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        return im


def recolour_svg(svg: str, colour: str) -> str:
    """Every fill / stroke / stop-color in the logo -> one colour (pure black or pure white)."""
    def attr(m):
        return f'{m.group(1)}={m.group(2)}{colour}{m.group(2)}'
    svg = re.sub(r'\b(fill|stroke|stop-color)\s*=\s*(["\'])(?!none\2)[^"\']*\2', attr, svg)
    svg = re.sub(r'\b(fill|stroke|stop-color)\s*:\s*(?!none\b)[^;"\'}]+', lambda m: f"{m.group(1)}:{colour}", svg)
    if not re.search(r"<svg\b[^>]*\bfill\s*=", svg):
        svg = re.sub(r"<svg\b", f'<svg fill="{colour}"', svg, count=1)
    return svg


def uri(p: pathlib.Path) -> str:
    return p.resolve().as_uri()


# ---- the brochure -------------------------------------------------------------------------------
class Section:
    def __init__(self, kind: str, fn):
        self.kind, self.fn = kind, fn


class Brochure:
    def __init__(self, L: Listing, files_dir: pathlib.Path, work: pathlib.Path):
        self.L, self.work = L, work
        self.images = Images(files_dir, work)
        self.scale = 1.0
        self.fonts = self._font_css()
        logo = LOGO_SVG.read_text(encoding="utf-8") if LOGO_SVG.is_file() else None
        if not logo:
            raise BrochureError(f"logo not found: {LOGO_SVG}")
        self.logo_black, self.logo_white = work / "logo-black.svg", work / "logo-white.svg"
        self.logo_black.write_text(recolour_svg(logo, "#000000"), encoding="utf-8")
        self.logo_white.write_text(recolour_svg(logo, "#ffffff"), encoding="utf-8")
        import segno
        self.qr = work / "qr.svg"
        segno.make(L.url, error="m").save(str(self.qr), kind="svg", scale=8, border=2, dark="#000000")
        # check every file the brochure needs before any work is done
        for im in L.images:
            self.images.source(im["src"])
        for m in L.models:
            if m.plan:
                self.images.source(m.plan)
        self.illustrative = L.project
        self.tune = {"factor": 1.0, "plan_h": 118.0, "cover": 0, "loc": 0}

    # -- plumbing -------------------------------------------------------------------------------
    @staticmethod
    def _font_css() -> str:
        out = []
        for fam, fn, w in FONT_FACES:
            p = FONT_DIR / fn
            if not p.is_file():
                raise BrochureError(f"font missing: {p}")
            out.append(f"@font-face {{ font-family:'{fam}'; src:url('{uri(p)}'); font-weight:{w}; font-style:normal; }}")
        return "\n".join(out)

    def doc_html(self, body: str, extra_css: str = "") -> str:
        L = self.L
        return ('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
                f'<title>{esc(L.title_en)} — Bona</title><meta name="author" content="Bona">'
                f'<meta name="description" content="{esc(L.id)} · {esc(L.url)}">'
                f'<style>{self.fonts}{CSS}{EXTRA}{BONA_CSS}{extra_css}</style></head><body>{body}</body></html>')

    def render(self, html_text: str):
        import weasyprint
        return weasyprint.HTML(string=html_text, base_url=str(self.work)).render()

    def img(self, src: str, role: str) -> str:
        return uri(self.images.path(src, role, self.scale))

    @staticmethod
    def walk(box):
        """Every laid-out box under `box`, entering absolutely positioned ones (WeasyPrint keeps those
        behind an AbsolutePlaceholder that `descendants()` does not open)."""
        stack = [box]
        while stack:
            b = stack.pop()
            yield b
            inner = getattr(b, "_box", None)
            kids = getattr(inner if inner is not None else b, "children", None) or ()
            stack.extend(reversed(list(kids)))

    @classmethod
    def marks(cls, doc):
        """Per page: {'content': [(top, bottom)], 'floor': [...], keys...} in mm, from the laid-out boxes."""
        out = []
        for page in doc.pages:
            found, seen = {}, set()
            for box in cls.walk(page._page_box):
                el = getattr(box, "element", None)
                if el is None or id(el) in seen:
                    continue
                tag = el.get("data-m") or el.get("data-k")
                if tag is None:
                    continue
                seen.add(id(el))
                top = box.position_y + box.margin_top
                found.setdefault(tag, []).append((top * PX_MM, (top + box.border_height()) * PX_MM))
            out.append(found)
        return out

    def measure_blocks(self, blocks: dict, expect=()) -> dict:
        """{key: (html, width_mm)} -> {key: height_mm}, laid out on one very tall page. Elements
        inside a block that carry their own data-k (table rows) are measured too; `expect` lists them."""
        if not blocks:
            return {}
        body = "".join(f'<div data-k="{esc(k)}" style="width:{w}mm">{h}</div>' for k, (h, w) in blocks.items())
        doc = self.render(self.doc_html(body, "@page { size:400mm 20000mm; margin:0 }"))
        got = {}
        for page in self.marks(doc):
            for k, boxes in page.items():
                got.setdefault(k, boxes[0][1] - boxes[0][0])
        missing = [k for k in list(blocks) + list(expect) if k not in got]
        if missing or len(doc.pages) != 1:
            raise BrochureError(f"measuring failed ({len(missing)} blocks unplaced)")
        return got

    # -- shared pieces -------------------------------------------------------------------------
    @staticmethod
    def runhead(en: str, ar: str) -> str:
        return f'<div class="runhead"><div class="eyebrow">{esc(en)}</div><div class="ar-lab">{esc(ar)}</div></div>'

    def footer(self, n: int) -> str:
        return (f'<div class="footer" data-m="floor"><img src="{uri(self.logo_black)}" style="height:3.2mm">'
                f'<div>{esc(self.L.city_en)} &nbsp;·&nbsp; {n:02d}</div></div>')

    @staticmethod
    def cell(fig: str, en: str, ar: str, unit: str = "") -> str:
        sup = f"<sup>{esc(unit)}</sup>" if unit else ""
        return (f'<div class="cell"><div class="fig">{esc(fig)}{sup}</div><div class="lab">{esc(en)}</div>'
                f'<div class="lab-ar">{esc(ar)}</div></div>')

    def ledger_rows(self, cells) -> str:
        n = len(cells)
        split = {4: [2, 2], 5: [3, 2], 6: [3, 3]}.get(n, [n])
        rows, i = [], 0
        for k in split:
            rows.append(cells[i:i + k])
            i += k
        return "".join('<div class="ledger-row">' + "".join(self.cell(*c) for c in row) + "</div>" for row in rows)

    @staticmethod
    def term(label_en: str, value: str, label_ar: str, long=False) -> str:
        cls = "v long" if long else "v"
        return (f'<div><div class="eyebrow">{esc(label_en)}</div><div class="{cls}">{esc(value)}</div>'
                f'<div class="v-ar">{esc(label_ar)}</div></div>')

    def focus_pos(self, im, default: str) -> str:
        if not im.get("focus"):
            return default
        x, y = (min(1.0, max(0.0, v)) for v in im["focus"])
        return f"{round(x * 100)}% {round(y * 100)}%"

    # -- 1 flysheet ----------------------------------------------------------------------------
    def flysheet(self):
        L = self.L
        foot = " · ".join(dedupe([L.city_en, L.country_line()]))

        def fn(n):
            return (f'<section class="page title-page"><div class="tp-mark"><img class="wide" src="{uri(self.logo_white)}"></div>'
                    f'<div class="tp-rule"></div><div class="tp-line">{esc(L.tag_en)}</div><div class="tp-ar">{esc(L.tag_ar)}</div>'
                    f'<div class="tp-foot">{esc(foot).replace(" · ", " &nbsp;·&nbsp; ")}</div></section>')
        return Section("flysheet", fn)

    # -- 2 cover -------------------------------------------------------------------------------
    def cover(self):
        L = self.L
        hero = L.images[0]
        several = len(L.models) > 1
        eyebrow = " · ".join(dedupe([L.type_label(plural=several), CATEGORY_LABELS.get(L.category, "")]))
        meta_en = " · ".join(dedupe([L.district_en, L.city_en, L.price_en()]))
        meta_ar = " — ".join(dedupe([L.district_ar, L.city_ar]))
        n = len(L.title_en)
        tier = (0 if n <= 38 else 1 if n <= 64 else 2) + self.tune["cover"]
        size_en = (41, 34, 28, 24)[min(tier, 3)]
        size_ar = 23 if len(L.title_ar) <= 40 and tier < 2 else 19

        def fn(n_):
            return (f'<section class="page"><div class="cover-img" style="background-image:url(\'{self.img(hero["src"], "cover")}\');'
                    f'background-position:{self.focus_pos(hero, "center 58%")}"></div>'
                    f'<div class="cover-body" data-m="content"><div class="eyebrow muted">{esc(eyebrow)}</div>'
                    f'<div class="cover-title" style="font-size:{size_en}pt">{esc(L.title_en)}</div>'
                    f'<div class="cover-title-ar" style="font-size:{size_ar}pt">{esc(L.title_ar)}</div>'
                    f'<div class="cover-meta"><div class="eyebrow">{esc(meta_en)}</div><div class="ar-lab">{esc(meta_ar)}</div></div>'
                    f'</div></section>')
        return Section("cover", fn)

    # -- 3 narrative ---------------------------------------------------------------------------
    def narrative_head(self):
        L = self.L
        runhead = ("The Project", "عن المشروع") if L.project else ("The Property", "عن العقار")
        if L.project and L.models:
            n = len(L.models)
            words = EN_NUMBER.get(n, str(n))
            en = f"{words} layout" if n == 1 else f"{words} layouts"
            ar = {1: "نموذج واحد", 2: "نموذجان"}.get(n) or (f"{AR_NUMBER[n]} نماذج" if n in AR_NUMBER else f"{n} نموذجًا")
            areas = sorted({m.area for m in L.models if m.area is not None})
            if len(areas) >= 2:
                h_en = f"{esc(en)},<br>from {fmt_area(areas[0])} to {fmt_area(areas[-1])} sq m."
                h_ar = f"{esc(ar)}، من {fmt_area(areas[0])} إلى {fmt_area(areas[-1])} م²"
            elif areas:
                h_en, h_ar = f"{esc(en)},<br>{fmt_area(areas[0])} sq m.", f"{esc(ar)}، {fmt_area(areas[0])} م²"
            else:
                h_en, h_ar = f"{esc(en)}.", esc(ar)
            eyebrow = L.project_en or L.title_en
        else:
            h_en, h_ar = esc(L.title_en), esc(L.title_ar)
            eyebrow = " · ".join(dedupe([L.district_en, L.city_en]))
        size = 34 if len(re.sub(r"<[^>]+>", "", h_en)) <= 60 else 28
        head = (f'<div class="eyebrow muted">{esc(eyebrow)}</div><h1 style="margin-top:5mm;font-size:{size}pt">{h_en}</h1>'
                f'<div class="ar-h">{h_ar}</div>')
        return runhead, head

    def narrative_ledger(self) -> str:
        L, cells = self.L, []
        if L.project and L.models:
            ms = L.models
            cells.append((fmt_count(len(ms)), "Layouts", "النماذج", ""))
            beds = [m.beds for m in ms if m.beds is not None]
            baths = [m.baths for m in ms if m.baths is not None]
            areas = sorted({m.area for m in ms if m.area is not None})
            if beds:
                cells.append((fmt_range(beds), "Bedrooms", "غرف النوم", ""))
            if baths:
                cells.append((fmt_range(baths), "Bathrooms", "دورات المياه", ""))
            if len(areas) >= 2:
                cells.append((fmt_area(areas[0]), "Smallest", "أصغر مساحة", "SQ M"))
                cells.append((fmt_area(areas[-1]), "Largest", "أكبر مساحة", "SQ M"))
            elif areas:
                cells.append((fmt_area(areas[0]), "Area", "المساحة", "SQ M"))
            best = None
            for en, _ar in L.warranties:
                for m in re.finditer(r"(\d+)\s*-?\s*(?:years?|yrs?)\b", en, re.I):
                    y = int(m.group(1))
                    if 0 < y < 100 and (best is None or y > best[0]):
                        best = (y, en)
            if best:
                structural = "struct" in best[1].lower()
                cells.append((fmt_plain(best[0]), "Structural warranty" if structural else "Warranty",
                              "ضمان الهيكل" if structural else "الضمان", "YRS"))
            head = ("At a glance", "نظرة عامة")
        else:
            s = L.specs
            if s["beds"] is not None:
                cells.append((fmt_count(s["beds"]), "Bedrooms", "غرف النوم", ""))
            if s["baths"] is not None:
                cells.append((fmt_count(s["baths"]), "Bathrooms", "دورات المياه", ""))
            if s["areaSqm"] is not None:
                cells.append((fmt_area(s["areaSqm"]), "Area", "المساحة", "SQ M"))
            if s["plotSqm"] is not None:
                cells.append((fmt_area(s["plotSqm"]), "Plot", "مساحة الأرض", "SQ M"))
            if s["floors"] is not None:
                cells.append((fmt_count(s["floors"]), "Floors", "الأدوار", ""))
            if s["yearBuilt"] is not None:
                cells.append((fmt_plain(s["yearBuilt"]), "Year built", "سنة البناء", ""))
            head = ("Specification", "المواصفات")
        cells = cells[:6]
        if not cells:
            return ""
        small = " small" if any(len(c[0]) > 6 for c in cells) else ""
        return (f'<div class="ledger{small}" data-m="floor"><div class="ledger-head"><div class="eyebrow">{esc(head[0])}</div>'
                f'<div class="ar-lab">{esc(head[1])}</div></div>{self.ledger_rows(cells)}</div>')

    def narrative_section(self, first: bool, en_ps, ar_ps):
        (rh_en, rh_ar), head = self.narrative_head()
        ledger = self.narrative_ledger() if first else ""

        def fn(n):
            ps_en = "".join(f"<p>{esc(p)}</p>" for p in en_ps)
            ps_ar = "".join(f"<p>{esc(p)}</p>" for p in ar_ps)
            cls = "cols" if first else "cols cont"
            return (f'<section class="page">{self.runhead(rh_en, rh_ar)}<div class="lead">{head if first else ""}'
                    f'<div class="{cls}" data-m="content"><div class="body-en">{ps_en}</div><div class="body-ar">{ps_ar}</div></div>'
                    f'</div>{ledger}{self.footer(n)}</section>')
        return Section("narrative", fn)

    # -- 4 residences & prices -----------------------------------------------------------------
    def sakani_col(self) -> bool:
        return any(m.sakani is not None for m in self.L.models)

    def units_table(self, models, keyed=False) -> str:
        cur, sak = self.L.currency, self.sakani_col()
        widths = [34, 8, 8, 14, 18, 18] if sak else [40, 9, 9, 16, 26]
        heads = [("Layout", "النموذج"), ("Bed", "نوم"), ("Bath", "مياه"), ("Area", "المساحة"), ("Price", "السعر")]
        if sak:
            heads.append(("Sakani", "مستفيدي الدعم"))
        colgroup = "<colgroup>" + "".join(f'<col style="width:{w}%">' for w in widths) + "</colgroup>"
        thead = "<thead><tr>" + "".join(f"<th>{esc(e)}<span>{esc(a)}</span></th>" for e, a in heads) + "</tr></thead>"
        dash = "—"
        rows = []
        for i, m in enumerate(models):
            k = f' data-k="row:{i}"' if keyed else ""
            tds = [f'<td class="nmc"><span class="nm">{esc(m.name_en)}</span><span class="nm-ar">{esc(m.name_ar)}</span></td>',
                   f"<td>{fmt_plain(m.beds) if m.beds is not None else dash}</td>",
                   f"<td>{fmt_plain(m.baths) if m.baths is not None else dash}</td>",
                   f"<td>{fmt_area(m.area) + ' m²' if m.area is not None else dash}</td>",
                   f"<td>{esc(money_en(m.price, cur)) if m.price is not None else 'On request'}</td>"]
            if sak:
                tds.append(f"<td>{esc(money_en(m.sakani, cur)) if m.sakani is not None else dash}</td>")
            rows.append(f"<tr{k}>" + "".join(tds) + "</tr>")
        return f'<table class="units">{colgroup}{thead}<tbody>{"".join(rows)}</tbody></table>'

    def residences_head(self):
        priced = any(m.price is not None or m.sakani is not None for m in self.L.models)
        eyebrow = self.L.project_en or self.L.title_en
        h_en, h_ar = ("Every layout, every price.", "كل النماذج وأسعارها") if priced else ("Every layout.", "كل النماذج")
        note = ""
        if priced:
            en, ar = SAKANI_NOTE if self.sakani_col() else PRICE_NOTE
            note = f'<div class="note">{esc(en)}</div><div class="note-ar">{esc(ar)}</div>'
        head = (f'<div class="eyebrow muted">{esc(eyebrow)}</div><h1 style="margin-top:5mm">{esc(h_en)}</h1>'
                f'<div class="ar-h">{esc(h_ar)}</div>')
        return head, note

    def residences_section(self, models, first: bool, last: bool, note_always=False):
        head, note = self.residences_head()

        def fn(n):
            table = self.units_table(models)
            if not first:
                table = table.replace('<table class="units">', '<table class="units" style="margin-top:0">', 1)
            return (f'<section class="page">{self.runhead("Residences & Prices", "النماذج والأسعار")}'
                    f'<div class="lead" data-m="content">{head if first else ""}{table}{note if (last or note_always) else ""}</div>'
                    f'{self.footer(n)}</section>')
        return Section("residences", fn)

    # -- 5 one page per model ------------------------------------------------------------------
    def model_section(self, idx: int, total: int, m: Model):
        cur = self.L.currency
        name_ar = m.name_ar if m.name_ar.startswith("نموذج") else (f"نموذج {m.name_ar}" if m.name_ar else "")
        cells = []
        if m.area is not None:
            cells.append((fmt_area(m.area), "Area", "المساحة", "SQ M"))
        if m.beds is not None:
            cells.append((fmt_count(m.beds), "Bedrooms", "غرف النوم", ""))
        if m.baths is not None:
            cells.append((fmt_count(m.baths), "Bathrooms", "دورات المياه", ""))
        terms = [self.term("Price", money_en(m.price, cur) if m.price is not None else "On request", "السعر")]
        if m.sakani is not None:
            terms.append(self.term("Sakani beneficiaries", money_en(m.sakani, cur), "لمستفيدي الدعم"))
        if m.avail_en or m.avail_ar:
            terms.append(f'<div><div class="eyebrow">Availability</div><div class="floors">{esc(m.avail_en)}</div>'
                         f'<div class="floors-ar">{esc(m.avail_ar)}</div></div>')
        small = " small" if any(len(c[0]) > 6 for c in cells) else ""
        row = ('<div class="ledger-row" style="border-top:.4pt solid #000">' + "".join(self.cell(*c) for c in cells) + "</div>") if cells else ""
        ledger = (f'<div class="ledger{small}" data-m="floor">{row}<div class="terms" style="margin-top:{8 if row else 0}mm">'
                  f'{"".join(terms)}</div></div>')
        name_en = m.name_en or m.name_ar

        def fn(n):
            ph = self.tune["plan_h"]
            plan = self.img(m.plan, "plan")
            return (f'<section class="page">{self.runhead(f"Residence {idx:02d} of {total:02d}", f"النموذج {idx} من {total}")}'
                    f'<div class="lead" data-m="content"><h1>{esc(name_en)}</h1><div class="ar-h">{esc(name_ar)}</div>'
                    f'<div class="planbox" style="height:{ph}mm"><img src="{plan}" style="max-height:{ph}mm"></div></div>'
                    f'{ledger}{self.footer(n)}</section>')
        return Section("model", fn)

    # -- 6 photo pages -------------------------------------------------------------------------
    def caption(self, im):
        L = self.L
        en, ar = strip_title(im["alt_en"], L.title_en), strip_title(im["alt_ar"], L.title_ar)
        if self.illustrative:
            en = f"{en} · Illustrative" if en else "Illustrative"
            ar = f"{ar} · صورة توضيحية" if ar else "صورة توضيحية"
        return en, ar

    def plate(self, im, role: str, height: int) -> str:
        en, ar = self.caption(im)
        return (f'<div><div class="plate" style="height:{height}mm;background-image:url(\'{self.img(im["src"], role)}\');'
                f'background-position:{self.focus_pos(im, "center")}"></div>'
                f'<div class="cap"><div class="en">{esc(en)}</div><div class="ar">{esc(ar)}</div></div></div>')

    def photo_section(self, group):
        def fn(n):
            body = self.plate(group[0], "hero", 100)
            if len(group) == 3:
                body += f'<div class="grid2" style="margin-top:7mm">{self.plate(group[1], "half", 96)}{self.plate(group[2], "half", 96)}</div>'
            elif len(group) == 2:
                body += f'<div style="margin-top:7mm">{self.plate(group[1], "hero", 100)}</div>'
            return (f'<section class="page">{self.runhead("Gallery", "معرض الصور")}'
                    f'<div class="pad" data-m="content" style="position:absolute;top:30mm;left:0;right:0">{body}</div>'
                    f'{self.footer(n)}</section>')
        return Section("photos", fn)

    # -- 7 amenities & terms -------------------------------------------------------------------
    def amenity_groups(self):
        L = self.L
        return [g for g in (("Amenities", "المرافق", L.amenities), ("Nearby", "بالقرب", L.nearby),
                            ("Warranties", "الضمانات", L.warranties)) if g[2]]

    @staticmethod
    def spec_group(en, ar) -> str:
        return f'<div class="spec-group"><div class="en">{esc(en)}</div><div class="ar">{esc(ar)}</div></div>'

    @staticmethod
    def spec_item(en, ar) -> str:
        return f'<div class="spec-item"><div class="en">{esc(en)}</div><div class="ar">{esc(ar)}</div></div>'

    def amenities_head(self) -> str:
        L = self.L
        parts = [(en, ar) for en, ar, on in (("Amenities", "المرافق", L.amenities), ("Surroundings", "المحيط", L.nearby),
                                             ("Warranties", "الضمانات", L.warranties)) if on]
        en = [p[0] for p in parts]
        en = [en[0]] + [w.lower() for w in en[1:]]
        h_en = en[0] if len(en) == 1 else f"{', '.join(en[:-1])} & {en[-1]}"
        h_ar = " و".join(p[1] for p in parts)
        return f'<h1>{esc(h_en)}</h1><div class="ar-h">{esc(h_ar)}</div>'

    def terms_row(self) -> str:
        L, cells = self.L, []
        if L.on_request:
            cells.append(self.term("Price", "On request", "السعر"))
        elif L.price_from:
            cells.append(self.term("From", money_en(L.amount, L.currency), "ابتداءً من"))
        else:
            cells.append(self.term("Price", money_en(L.amount, L.currency) + (f" / {L.period}" if L.period else ""), "السعر"))
        if L.sakani is not None:
            cells.append(self.term("Sakani from" if L.price_from else "Sakani price", money_en(L.sakani, L.currency),
                                   "لمستفيدي الدعم"))
        if L.dev_en or L.dev_ar:
            cells.append(self.term("Developer", L.dev_en or L.dev_ar, L.dev_ar, long=len(L.dev_en) > 16))
        return f'<div class="terms">{"".join(cells)}</div>'

    def amenities_section(self, cols, first: bool, last: bool, reserve_terms=False):
        def fn(n):
            col_html = "".join("<div>" + "".join(e for e in col) + "</div>" for col in (cols + [[], []])[:2])
            style = ' style="margin-top:9mm"' if first else ""
            cls = "cols" if first else "cols cont"
            return (f'<section class="page">{self.runhead("Amenities & Terms", "المرافق والشروط")}'
                    f'<div class="lead" data-m="content">{self.amenities_head() if first else ""}'
                    f'<div class="{cls}"{style}>{col_html}</div>{self.terms_row() if (last or reserve_terms) else ""}</div>'
                    f'{self.footer(n)}</section>')
        return Section("amenities", fn)

    # -- 8 location & enquiries ----------------------------------------------------------------
    def location_section(self, with_developer: bool):
        L = self.L

        def fact(en, ar, v, v_ar=""):
            extra = f'<div class="v-ar">{esc(v_ar)}</div>' if v_ar else ""
            return (f'<div class="loc-fact"><div class="k">{esc(en)}<span class="sep">/</span><span class="k-ar">{esc(ar)}</span></div>'
                    f'<div class="v">{esc(v)}</div>{extra}</div>')

        def fn(n):
            compact = self.tune["loc"]
            d_en = L.district_en if L.district_en and L.district_en != L.city_en else ""
            d_ar = L.district_ar if L.district_ar and L.district_ar != L.city_ar else ""
            h_en = f"{esc(d_en)},<br>{esc(L.city_en)}." if d_en else f"{esc(L.city_en)}."
            h_ar = "، ".join(dedupe([d_ar, L.city_ar]))
            facts = [fact("District", "الحي", ", ".join(dedupe([L.district_en, L.city_en])))]
            if L.nearby and compact < 2:
                facts.append(fact("Nearby", "بالقرب", " · ".join(e for e, _ in L.nearby[:3] if e)))
            if with_developer and (L.dev_en or L.dev_ar):
                facts.append(fact("Developer", "المطوّر", L.dev_en or L.dev_ar, L.dev_ar if L.dev_en else ""))
            facts.append(fact("Reference", "المرجع", f"{L.id} · FAL {L.fal}" if L.fal else L.id))
            if L.exact_pin:
                lat, lng = L.exact_pin
                href = f"https://www.google.com/maps?q={lat:.6f},{lng:.6f}"
                btn = (f'<a class="map-btn" href="{esc(href)}"><span class="l">Open in Google Maps &nbsp;&#8599;</span>'
                       f'<span class="r">افتح الموقع في خرائط قوقل</span></a>')
            else:
                btn = (f'<a class="map-btn" href="{esc(L.url)}"><span class="l">View on {esc(L.site_host)} &nbsp;&#8594;</span>'
                       f'<span class="r">اعرض العقار على الموقع</span></a>')
            hours = ""
            if L.hours_en or L.hours_ar:
                en = esc(L.hours_en).replace(", ", "<br>", 1)
                ar = f'<span class="v2-ar">{esc(L.hours_ar)}</span>' if L.hours_ar and compact < 1 else ""
                hours = f'<div><div class="k2">Hours</div><div class="v2">{en}{ar}</div></div>'
            return (f'<section class="page">{self.runhead("Location & Enquiries", "الموقع والاستفسار")}'
                    f'<div class="loc" data-m="content"><h1>{h_en}</h1><div class="ar-h">{esc(h_ar)}</div>'
                    f'<div class="qr-block"><div class="qr-tile"><a href="{esc(L.url)}"><img src="{uri(self.qr)}"></a>'
                    f'<div class="cta">Scan for the listing</div><div class="cta-ar">امسح لعرض العقار</div></div>'
                    f'<div class="loc-facts">{"".join(facts)}</div></div>{btn}</div>'
                    f'<div class="enquiry" data-m="floor"><img class="enq-logo" src="{uri(self.logo_white)}" style="height:auto;width:34mm">'
                    f'<div class="k">Enquiries</div><h2>Arrange a private viewing</h2><div class="ar">لترتيب زيارة خاصة أو للاستفسار تواصل معنا</div>'
                    f'<div class="lines"><div><div class="k2">Telephone · WhatsApp</div><div class="v2">'
                    f'<a href="https://wa.me/{esc(L.wa)}">{esc(L.phone)}</a></div></div>'
                    f'<div><div class="k2">Email</div><div class="v2"><a href="mailto:{esc(L.email)}">{esc(L.email)}</a></div></div>'
                    f'{hours}</div></div></section>')
        return Section("location", fn)

    # -- measuring & pagination ----------------------------------------------------------------
    def measure(self):
        """Two renders: the page skeletons (how much room each flowing page has) and every block that
        can flow (paragraph pieces, table rows, amenity rows) at its printed width."""
        L = self.L
        skel = [self.narrative_section(True, [], []), self.narrative_section(False, [], [])]
        if L.models:
            skel += [self.residences_section([], True, True), self.residences_section([], False, True)]
        groups = self.amenity_groups()
        if groups:
            skel += [self.amenities_section([], True, True), self.amenities_section([], False, False, reserve_terms=True)]
        doc = self.render(self.doc_html("".join(s.fn(i + 1) for i, s in enumerate(skel))))
        marks = self.marks(doc)
        if len(marks) != len(skel):
            raise BrochureError("measuring failed (skeleton pages)")

        def slack(i):
            m = marks[i]
            floor = min([t for t, _ in m.get("floor", [])] + [SAFE_BOTTOM])
            bottom = max(b for _, b in m["content"])
            return floor - TEXT_GAP - bottom

        cap = {"narr": (slack(0), slack(1))}
        if L.models:
            cap["res"] = (slack(2), slack(3))
        if groups:
            cap["amen"] = (slack(-2), slack(-1))

        blocks, self.units = {}, {}
        for lang, paras in (("en", L.desc_en), ("ar", L.desc_ar)):
            units = [sentences(p, lang) for p in paras]
            self.units[lang] = units
            for pi, ss in enumerate(units):
                for i in range(len(ss)):
                    for j in range(i + 1, len(ss) + 1):
                        blocks[f"{lang}:{pi}:{i}:{j}"] = (f'<div class="body-{lang}"><p>{esc(" ".join(ss[i:j]))}</p></div>', COL_W)
        if L.models:
            blocks["table"] = (self.units_table(L.models, keyed=True), 170)
        for gi, (en, ar, items) in enumerate(groups):
            blocks[f"ghead:{gi}"] = (self.spec_group(en, ar), COL_W)
            for ii, (a, b) in enumerate(items):
                blocks[f"item:{gi}:{ii}"] = (self.spec_item(a, b), COL_W)
        got = self.measure_blocks(blocks, expect=[f"row:{i}" for i in range(len(L.models))])
        self.cap, self.h = cap, got

    def paginate_text(self, lang: str, caps):
        units, H = self.units[lang], self.h
        gap = (8.4 * 1.85 if lang == "en" else 9 * 2.0) * 25.4 / 72      # one line: the p + p margin
        pages, used = [[]], 0.0
        for pi, ss in enumerate(units):
            i = 0
            while i < len(ss):
                c = caps[0] if len(pages) == 1 else caps[1]
                extra = gap if pages[-1] else 0.0
                j = len(ss)
                while j > i and used + extra + H[f"{lang}:{pi}:{i}:{j}"] > c:
                    j -= 1
                if j == i:
                    if pages[-1] or (len(pages) == 1 and caps[1] > caps[0]):
                        pages.append([])
                        used = 0.0
                        continue
                    j = i + 1                       # one sentence taller than an empty page: the render check decides
                pages[-1].append(" ".join(ss[i:j]))
                used += extra + H[f"{lang}:{pi}:{i}:{j}"]
                i = j
                if i < len(ss):                     # the paragraph goes on overleaf
                    pages.append([])
                    used = 0.0
        return pages

    def paginate_rows(self, caps):
        heights = [self.h[f"row:{i}"] for i in range(len(self.L.models))]
        pages, i = [], 0
        while i < len(heights):
            c = caps[0] if not pages else caps[1]
            take, used = 0, 0.0
            while i + take < len(heights) and take < MAX_TABLE_ROWS and used + heights[i + take] <= c:
                used += heights[i + take]
                take += 1
            take = max(take, 1)
            pages.append(self.L.models[i:i + take])
            i += take
        return pages

    def paginate_amenities(self, caps):
        groups, H = self.amenity_groups(), self.h
        head_gap = 7.0

        def build(order, cap_of):
            cols, col, used, cur = [], [], 0.0, None
            for gi, ii in order:
                need_head = cur != gi or not col
                h = H[f"item:{gi}:{ii}"] + ((H[f"ghead:{gi}"] + (head_gap if col else 0.0)) if need_head else 0.0)
                if col and used + h > cap_of(len(cols)):
                    cols.append(col)
                    col, used, cur = [], 0.0, None
                    need_head = True
                    h = H[f"item:{gi}:{ii}"] + H[f"ghead:{gi}"]
                if need_head:
                    col.append(self.spec_group(groups[gi][0], groups[gi][1]))
                    cur = gi
                col.append(self.spec_item(*groups[gi][2][ii]))
                used += h
            if col:
                cols.append(col)
            return cols

        order = [(gi, ii) for gi, g in enumerate(groups) for ii in range(len(g[2]))]

        def col_height(seq):
            h, cur, first = 0.0, None, True
            for gi, ii in seq:
                if cur != gi:
                    h += H[f"ghead:{gi}"] + (0.0 if first else head_gap)
                    cur = gi
                h += H[f"item:{gi}:{ii}"]
                first = False
            return h

        # Everything on one page: split into two columns at the most balanced point, strongly
        # preferring a group boundary (the sample keeps a group whole; a group cut in two repeats its
        # head, which only pays off when the columns would otherwise be badly lopsided).
        best = None
        for k in range(0, len(order) + 1):
            a, b = order[:k], order[k:]
            ha, hb = col_height(a), col_height(b)
            if ha > caps[0] or hb > caps[0]:
                continue
            boundary = k in (0, len(order)) or order[k - 1][0] != order[k][0]
            score = max(ha, hb) + (0.0 if boundary else 30.0) + (40.0 if not a or not b else 0.0)
            if best is None or score < best[0]:
                best = (score, k)
        if best is not None:
            k = best[1]
            cols = [c for c in (build(order[:k], lambda _: 1e9), build(order[k:], lambda _: 1e9))]
            cols = [c[0] if c else [] for c in cols]
            return [cols]
        cols = build(order, lambda n: caps[0] if n < 2 else caps[1])
        return [cols[i:i + 2] for i in range(0, len(cols), 2)]

    def plan_sections(self):
        L, t = self.L, self.tune["factor"]
        secs = [self.flysheet(), self.cover()]
        nc = tuple(c * t for c in self.cap["narr"])
        en_pages, ar_pages = self.paginate_text("en", nc), self.paginate_text("ar", nc)
        n = max(len(en_pages), len(ar_pages), 1)
        en_pages += [[]] * (n - len(en_pages))
        ar_pages += [[]] * (n - len(ar_pages))
        for i in range(n):
            if i > 0 and not en_pages[i] and not ar_pages[i]:
                continue
            secs.append(self.narrative_section(i == 0, en_pages[i], ar_pages[i]))
        if L.models:
            pages = self.paginate_rows(tuple(c * t for c in self.cap["res"]))
            for i, ms in enumerate(pages):
                secs.append(self.residences_section(ms, i == 0, i == len(pages) - 1))
            total = len(L.models)
            for idx, m in enumerate(L.models, 1):
                if m.plan:
                    secs.append(self.model_section(idx, total, m))
        rest = L.images[1:]
        groups = [rest[i:i + 3] for i in range(0, len(rest), 3)]
        for g in groups:
            secs.append(self.photo_section(g))
        amen = self.amenity_groups()
        if amen:
            pages = self.paginate_amenities(tuple(c * t for c in self.cap["amen"]))
            for i, cols in enumerate(pages):
                secs.append(self.amenities_section(cols, i == 0, i == len(pages) - 1))
        secs.append(self.location_section(with_developer=not amen))
        return secs

    def check(self, doc, secs):
        if len(doc.pages) != len(secs):
            raise BrochureError(f"{len(doc.pages)} pages rendered for {len(secs)} sections")
        bad = []
        for i, (m, s) in enumerate(zip(self.marks(doc), secs)):
            if "content" not in m:
                continue
            bottom = max(b for _, b in m["content"])
            floor = min([t for t, _ in m.get("floor", [])] + [SAFE_BOTTOM])
            if bottom > floor - CHECK_GAP:
                bad.append((i + 1, s.kind, round(bottom, 1), round(floor, 1)))
        return bad

    def compose(self, secs) -> str:
        return self.doc_html("".join(s.fn(i + 1) for i, s in enumerate(secs)))

    def layout(self, steps):
        """Cut the pages, render, check every page; re-cut tighter until nothing overlaps (or give up)."""
        for attempt in range(5):
            secs = self.plan_sections()
            doc = self.render(self.compose(secs))
            bad = self.check(doc, secs)
            if not bad:
                return secs, doc
            steps.append("refit:" + ",".join(f"p{p}-{k}" for p, k, _, _ in bad))
            kinds = {k for _, k, _, _ in bad}
            if kinds & {"flysheet", "photos"}:
                break
            if kinds & {"narrative", "residences", "amenities"}:
                self.tune["factor"] *= 0.9
            if "model" in kinds:
                self.tune["plan_h"] = max(70.0, self.tune["plan_h"] - 16.0)
            if "cover" in kinds:
                self.tune["cover"] += 1
            if "location" in kinds:
                self.tune["loc"] += 1
        p, k, bottom, floor = bad[0]
        raise BrochureError(f"layout does not fit: page {p} ({k}) text ends at {bottom}mm, limit {floor}mm")


# ---- entry point --------------------------------------------------------------------------------
class _Args(argparse.ArgumentParser):
    def error(self, message):
        raise BrochureError(f"usage: {message}")


def load_json(path: str, what: str):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        raise BrochureError(f"{what} not found: {path}")
    except (OSError, ValueError) as e:
        raise BrochureError(f"{what} is not readable JSON: {e}")


def default_work() -> pathlib.Path:
    base = pathlib.Path(os.environ.get("XDG_CACHE_HOME") or (pathlib.Path.home() / ".cache")) / "bona-brochure"
    base.mkdir(parents=True, exist_ok=True)
    return pathlib.Path(tempfile.mkdtemp(prefix="work-", dir=base))


def build(argv):
    ap = _Args(prog="brochure_pdf.py", add_help=False)
    ap.add_argument("listing")
    ap.add_argument("files_dir")
    ap.add_argument("site")
    ap.add_argument("out")
    ap.add_argument("--max-mb", type=float, default=DEFAULT_MAX_MB)
    ap.add_argument("--work", default=None)
    a = ap.parse_args(argv)
    if not (a.max_mb > 0):
        raise BrochureError("--max-mb must be positive")
    L = Listing(load_json(a.listing, "listing"), load_json(a.site, "site.json"))
    files_dir = pathlib.Path(a.files_dir)
    if not files_dir.is_dir():
        raise BrochureError(f"files-dir not found: {files_dir}")
    out = pathlib.Path(a.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    max_bytes = int(a.max_mb * MB)
    work = pathlib.Path(a.work).resolve() if a.work else default_work()
    work.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(f".{out.name}.tmp-{os.getpid()}")
    steps = []
    try:
        b = Brochure(L, files_dir, work)
        b.measure()
        steps.append("measure")
        secs, doc = b.layout(steps)
        steps.append("render")
        for scale in SCALES:
            if scale != 1.0:
                b.scale = scale
                doc = b.render(b.compose(secs))
                steps.append(f"scale-{scale}")
            doc.write_pdf(str(tmp))
            size = tmp.stat().st_size
            if size <= max_bytes:
                os.replace(tmp, out)
                steps.append("write")
                return {"ok": True, "out": str(out), "bytes": size, "pages": len(doc.pages),
                        "maxBytes": max_bytes, "steps": steps, "kinds": [s.kind for s in secs], "id": L.id}
            tmp.unlink()
        out.unlink(missing_ok=True)
        raise TooLarge(f"{size} bytes after scaling images to {SCALES[-1]}, cap {max_bytes}")
    finally:
        tmp.unlink(missing_ok=True)
        if not a.work:
            shutil.rmtree(work, ignore_errors=True)


def main(argv=None) -> int:
    real_stdout, sys.stdout = sys.stdout, sys.stderr     # nothing but the result line reaches stdout
    try:
        result, code = build(sys.argv[1:] if argv is None else argv), 0
    except TooLarge as e:
        result, code = {"ok": False, "reason": "too-large", "error": str(e)}, 1
    except BrochureError as e:
        result, code = {"ok": False, "reason": "error", "error": str(e)}, 1
    except Exception as e:  # noqa: BLE001 — the caller needs one JSON line, whatever broke
        traceback.print_exc(file=sys.stderr)
        result, code = {"ok": False, "reason": "error", "error": f"{type(e).__name__}: {e}"}, 1
    finally:
        sys.stdout = real_stdout
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return code


if __name__ == "__main__":
    sys.exit(main())
