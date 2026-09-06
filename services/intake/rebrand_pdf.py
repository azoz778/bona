#!/usr/bin/env python3
"""Bona intake — re-publish a developer's brochure under Bona's branding (PyMuPDF).

Run through uv so nothing has to be installed on the box:

    uv run --with pymupdf --with segno --with fonttools --with brotli python \
        services/intake/rebrand_pdf.py <in.pdf> <facts.json> <out.pdf> [--max-mb 25]

What it does to the PDF, and nothing else:

  1. inserts a Bona **cover** in front of page 1 — ivory ground, the BONA wordmark drawn in
     Cormorant with the champagne hairline from `public/logo.svg` under it, the title in
     Arabic and English, the location/price line and the tagline;
  2. stamps a discreet **footer strip** across the bottom of every ORIGINAL page —
     `bona.azoz.uk · +966 59 329 6933 · FAL 1100313556 · <listing id>`, ink on ivory;
  3. appends a closing **"Enquire"** page — listing URL, a QR code of it (segno), the
     WhatsApp link, the opening hours in both languages and the licence line.

The developer's own pages are never re-rendered and their branding is never removed: it is
their document and their brand is legitimately on it. What IS enforced is that nothing we
add carries another agency's name — every listing fact is run through `scrub()` first, and
a fact that carries a rival broker, a foreign phone number, an email or a link is dropped
rather than printed (`scrubbed` in the result JSON says which).

Sizing. Developer brochures run 50–80 MB and this file is committed to a public repo that
CI clones on every build, so the output is capped (`--max-mb`, default 25). Over the cap the
images are downsampled in escalating steps (`Document.rewrite_images` where the installed
PyMuPDF has it, else `ez_save(deflate_images=True, garbage=4)`), and if it STILL does not
fit the output is deleted and `{"ok": false, "reason": "too-large"}` is printed — the caller
publishes the listing without a brochure rather than committing an 80 MB file.

Fonts. The brand faces live in `public/fonts/*.woff2` (one source of truth with the site).
PyMuPDF cannot read woff2, so they are decompressed to TTF once into a cache dir with
fontTools and reused. Arabic is laid out by `Page.insert_htmlbox`, which shapes and
bidi-orders it properly; every mixed-script line lists the LATIN family FIRST because the
brand's Arabic faces are subset to Arabic only (no digits, no dashes, no Latin) and a
missing glyph in the first family is what puts a tofu box on the page.

Never raises for a bad PDF: prints {"ok": false, "error": "..."} on one line and exits 1.

Result JSON (one line, stdout):

    {"ok": true, "out": "…/brochure.pdf", "bytes": 8123456, "srcBytes": 10308939,
     "pages": 31, "srcPages": 29, "maxBytes": 26214400, "steps": ["save"],
     "scrubbed": [], "id": "BONA-W001"}
"""
from __future__ import annotations

import argparse
import html
import io
import json
import os
import re
import sys
import tempfile

# ---- palette (src/styles/global.css) ---------------------------------------------------
IVORY = (0xF5 / 255, 0xF1 / 255, 0xEA / 255)
INK = (0x0F / 255, 0x12 / 255, 0x14 / 255)
STONE = (0x6F / 255, 0x6A / 255, 0x62 / 255)
CHAMPAGNE = (0xC8 / 255, 0xA9 / 255, 0x6A / 255)
IVORY_HEX = "#f5f1ea"
INK_HEX = "#0f1214"
STONE_HEX = "#6f6a62"

# ---- fonts (public/fonts, the same files the site serves) -------------------------------
FONT_FACES = {
    "bona-display": "cormorant-600",       # Cormorant Garamond 600 — display Latin
    "bona-sans": "montserrat-400",         # Montserrat 400 — body/labels
    "bona-sans-bold": "montserrat-600",
    "bona-arabic": "plex-arabic-400",      # IBM Plex Arabic — body Arabic
    "bona-arabic-display": "amiri-700",    # Amiri — display Arabic
}

DEFAULT_MAX_MB = 25.0
A4 = (595.0, 842.0)
MIN_PAGE_PT, MAX_PAGE_PT = 120.0, 3000.0

# Escalating downsample passes, applied in order until the file fits.
SHRINK_STEPS = [
    {"dpi_threshold": 200, "dpi_target": 150, "quality": 80},
    {"dpi_threshold": 150, "dpi_target": 110, "quality": 70},
    {"dpi_threshold": 110, "dpi_target": 90, "quality": 60},
    {"dpi_threshold": 90, "dpi_target": 72, "quality": 45},
]

# ---- the "no other agency on OUR pages" guard -------------------------------------------
# Mirrors scripts/curate/rules.mjs::FORBIDDEN, plus the shapes that carry a rival's contact
# details. A fact that matches is dropped whole — never partially masked, because half a
# scrubbed sentence still reads as branding.
FORBIDDEN = [
    re.compile(r"\bTK\b", re.I),
    re.compile(r"tk[\s-]?estates?", re.I),
    re.compile(r"https?://", re.I),
    re.compile(r"\bwww\.", re.I),
    re.compile(r"\bwa\.me\b", re.I),
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+"),
    re.compile(r"\+\d[\d\s()-]{6,}"),          # international phone
    re.compile(r"\b0\d{8,}\b"),                 # local phone
    re.compile(r"\b\d{3,4}[\s-]?\d{3}[\s-]?\d{4}\b"),
    re.compile(r"[م][ك][ت][ب]\s"),  # "مكتب " (broker's office)
]


def fail(message: str, reason: str = "error") -> int:
    print(json.dumps({"ok": False, "error": message, "reason": reason}, ensure_ascii=False))
    return 1


def scrub(value, dropped: list, label: str):
    """Return `value` when it is safe to print on a Bona page, else None (and record it)."""
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if not text:
        return None
    for pattern in FORBIDDEN:
        if pattern.search(text):
            dropped.append(label)
            return None
    return text


# ---- fonts -------------------------------------------------------------------------------
def prepare_fonts(fonts_dir: str, cache_dir: str) -> dict:
    """woff2 -> ttf, once, into `cache_dir`. Returns {css family: ttf file name}.

    A TTF/OTF sitting next to the woff2 wins, so dropping real desktop fonts into
    public/fonts/ later needs no code change.
    """
    os.makedirs(cache_dir, exist_ok=True)
    out = {}
    missing = []
    for family, stem in FONT_FACES.items():
        direct = None
        for ext in (".ttf", ".otf"):
            candidate = os.path.join(fonts_dir, stem + ext)
            if os.path.exists(candidate):
                direct = candidate
                break
        target = os.path.join(cache_dir, stem + ".ttf")
        if direct:
            if os.path.abspath(direct) != os.path.abspath(target):
                with open(direct, "rb") as src, open(target, "wb") as dst:
                    dst.write(src.read())
            out[family] = stem + ".ttf"
            continue
        source = os.path.join(fonts_dir, stem + ".woff2")
        if not os.path.exists(source):
            missing.append(stem)
            continue
        if not os.path.exists(target) or os.path.getmtime(target) < os.path.getmtime(source):
            from fontTools.ttLib import TTFont  # noqa: PLC0415 — only needed for woff2
            font = TTFont(source)
            font.flavor = None
            font.save(target)
        out[family] = stem + ".ttf"
    if missing:
        raise FileNotFoundError(f"missing brand font(s) in {fonts_dir}: {', '.join(missing)}")
    return out


def font_css(faces: dict) -> str:
    return "\n".join(f"@font-face {{font-family: {family}; src: url({file});}}" for family, file in faces.items())


# ---- html helpers ------------------------------------------------------------------------
def line(text: str, *, family: str, size: float, color: str = INK_HEX, align: str = "center",
         tracking: float = 0.0, rtl: bool = False, leading: float = 1.35) -> str:
    """One centred line of html for insert_htmlbox.

    `family` must name the LATIN face first for any string that can carry digits, a dash or
    a Latin word: the Arabic faces are Arabic-only subsets and an uncovered codepoint in the
    first family renders as a tofu box instead of falling through.
    """
    style = (
        f"font-family:{family};font-size:{size:.2f}px;color:{color};"
        f"text-align:{align};line-height:{leading};margin:0;"
        f"direction:{'rtl' if rtl else 'ltr'};unicode-bidi:isolate;"
    )
    if tracking:
        # letter-spacing also lands AFTER the last glyph, so a centred tracked line sits
        # half a track to the left of true centre. Pad the box to put it back.
        style += f"letter-spacing:{tracking:.2f}px;"
        if align == "center" and not rtl:
            style += f"padding-left:{tracking:.2f}px;"
    return f'<div style="{style}">{html.escape(text)}</div>'


class Stack:
    """A vertical stack of centred blocks, measured before it is drawn.

    The brochures the owner is actually sent are 16:9 slide decks (1920x1080) as often as
    they are portrait, and one of them mixes 709x510 and 1417x510 pages in the same file.
    Positioning by fractions of the page height therefore does not work: the same fraction
    is a comfortable gap on an A4 page and an overlap on a 1080pt-high one. So every block
    is measured on a scratch page first, the stack is centred as a whole, and nothing is
    placed at a hard-coded height.
    """

    def __init__(self, page, scratch, css, archive, column):
        self.page = page
        self.scratch = scratch
        self.css = css
        self.archive = archive
        self.column = column
        self.items: list = []

    def _measure(self, htmltext) -> float:
        import pymupdf

        spare, _scale = self.scratch.insert_htmlbox(
            pymupdf.Rect(0, 0, self.column, 3000), htmltext, css=self.css, archive=self.archive)
        return max(6.0, 3000.0 - max(spare, 0.0))

    def text(self, htmltext, gap: float = 0.0):
        if htmltext is None:
            return self
        self.items.append(("text", htmltext, self._measure(htmltext), gap))
        return self

    def rule(self, width: float, thickness: float, gap: float = 0.0):
        self.items.append(("rule", (width, thickness), thickness, gap))
        return self

    def image(self, stream: bytes, side: float, gap: float = 0.0):
        self.items.append(("image", stream, side, gap))
        return self

    @property
    def height(self) -> float:
        return sum(h + gap for _kind, _payload, h, gap in self.items)

    def draw(self, top: float):
        import pymupdf

        W = self.page.rect.width
        x0 = (W - self.column) / 2
        y = top
        for kind, payload, h, gap in self.items:
            y += gap
            if kind == "text":
                self.page.insert_htmlbox(pymupdf.Rect(x0, y, x0 + self.column, y + h + 2),
                                         payload, css=self.css, archive=self.archive)
            elif kind == "rule":
                width, thickness = payload
                self.page.draw_line(pymupdf.Point(W / 2 - width / 2, y + thickness / 2),
                                    pymupdf.Point(W / 2 + width / 2, y + thickness / 2),
                                    color=CHAMPAGNE, width=thickness)
            else:
                self.page.insert_image(
                    pymupdf.Rect((W - h) / 2, y, (W + h) / 2, y + h), stream=payload)
            y += h
        return y


def page_unit(width: float, height: float) -> float:
    """Type scale for a page of any shape.

    Against A4 in BOTH directions, smaller wins: a 1920x1080 deck is 3.2x A4's width but
    only 1.3x its height, and scaling type by the width alone puts a 110pt wordmark on a
    page with 1080pt of room for the whole cover.
    """
    return max(0.55, min(width / 595.0, height / 842.0))


def text_column(width: float, unit: float) -> float:
    """A readable measure, never the full width of a 1920pt-wide deck."""
    return min(width * 0.78, 640.0 * unit)


def dominant_page_size(doc) -> tuple:
    """The size MOST of the brochure's pages use, for the pages we add.

    Not page 1's size: real brochures open on a half-spread or a portrait title page and
    then run landscape. A size outside MIN_PAGE_PT..MAX_PAGE_PT is not trusted at all and
    the cover falls back to A4.
    """
    counts: dict = {}
    for page in doc:
        rect = page.rect
        key = (round(float(rect.width), 1), round(float(rect.height), 1))
        counts[key] = counts.get(key, 0) + 1
    if not counts:
        return A4
    (W, H), _n = max(counts.items(), key=lambda kv: (kv[1], kv[0][0] * kv[0][1]))
    if not (MIN_PAGE_PT <= W <= MAX_PAGE_PT and MIN_PAGE_PT <= H <= MAX_PAGE_PT):
        return A4
    return W, H


# ---- pages -------------------------------------------------------------------------------
def draw_cover(page, scratch, facts, brand, css, archive, unit):
    import pymupdf

    W, H = page.rect.width, page.rect.height
    page.draw_rect(pymupdf.Rect(0, 0, W, H), fill=IVORY, color=None)
    column = text_column(W, unit)

    stack = Stack(page, scratch, css, archive, column)
    # The wordmark IS the name set in Cormorant; the rule under it is the champagne bar at
    # the foot of public/logo.svg.
    stack.text(line(brand["name"].upper(), family="bona-display", size=34 * unit, tracking=13 * unit))
    stack.rule(column * 0.30, 1.0 * unit, gap=10 * unit)
    stack.text(line(brand["tagline"]["en"].upper(), family="bona-sans", size=7.6 * unit,
                    color=STONE_HEX, tracking=2.6 * unit), gap=18 * unit)
    stack.text(line(brand["tagline"]["ar"], family="bona-sans, bona-arabic", size=10 * unit,
                    color=STONE_HEX, rtl=True), gap=4 * unit)
    if facts.get("titleAr"):
        stack.text(line(facts["titleAr"], family="bona-display, bona-arabic-display",
                        size=21 * unit, rtl=True, leading=1.55), gap=44 * unit)
    if facts.get("titleEn"):
        stack.text(line(facts["titleEn"], family="bona-display, bona-arabic-display",
                        size=25 * unit, leading=1.28), gap=10 * unit)
    meta = " \u00b7 ".join([p for p in [facts.get("place"), facts.get("priceEn")] if p])
    if meta:
        stack.text(line(meta, family="bona-sans, bona-arabic", size=9 * unit,
                        color=STONE_HEX, tracking=1.4 * unit), gap=22 * unit)
    project = " \u00b7 ".join([p for p in [facts.get("project"), facts.get("developer")] if p])
    if project:
        stack.text(line(project, family="bona-sans, bona-arabic", size=8 * unit,
                        color=STONE_HEX, tracking=1.2 * unit), gap=8 * unit)

    foot = " \u00b7 ".join([p for p in [brand["host"], f"FAL {brand['fal']}", facts.get("id")] if p])
    foot_html = line(foot, family="bona-sans", size=7.4 * unit, color=STONE_HEX, tracking=1.4 * unit)
    foot_h = stack._measure(foot_html)                                   # noqa: SLF001
    foot_top = H - foot_h - 34 * unit

    # Sit the stack a little above true centre in what is left above the foot line — a
    # cover reads better weighted to the upper half than dead-centred.
    top = max(24 * unit, (foot_top - stack.height) * 0.38)
    stack.draw(top)
    x0 = (W - column) / 2
    page.insert_htmlbox(pymupdf.Rect(x0, foot_top, x0 + column, foot_top + foot_h + 2),
                        foot_html, css=css, archive=archive)


def draw_footer(page, text, latin_font, latin_file, unit):
    """The strip on a developer's page: ivory band, champagne hairline, ink text.

    Latin only and drawn with insert_text rather than the story engine \u2014 it is stamped on
    every page, the baseline has to be exact, and there is nothing to shape.
    """
    import pymupdf

    rect = page.rect
    W, H = rect.width, rect.height
    band = max(15.0, 19.0 * unit)
    size = max(5.6, 6.9 * unit)
    y0 = H - band
    page.draw_rect(pymupdf.Rect(0, y0, W, H), fill=IVORY, color=None, overlay=True)
    page.draw_line(pymupdf.Point(0, y0), pymupdf.Point(W, y0), color=CHAMPAGNE, width=0.4 * unit)
    width = latin_font.text_length(text, fontsize=size)
    if width > W * 0.94:                      # a narrow page: shrink rather than clip
        size = size * (W * 0.94) / width
        width = latin_font.text_length(text, fontsize=size)
    baseline = y0 + band / 2 + size * 0.34
    page.insert_text(pymupdf.Point((W - width) / 2, baseline), text,
                     fontname="bonafoot", fontfile=latin_file,
                     fontsize=size, color=INK, overlay=True)


def draw_enquire(page, scratch, facts, brand, css, archive, unit):
    import pymupdf
    import segno

    W, H = page.rect.width, page.rect.height
    page.draw_rect(pymupdf.Rect(0, 0, W, H), fill=IVORY, color=None)
    column = text_column(W, unit)

    url = facts.get("url") or brand["site"]
    qr = io.BytesIO()
    segno.make(url, error="m").save(qr, kind="png", scale=14, border=1,
                                    dark=INK_HEX, light=IVORY_HEX)

    stack = Stack(page, scratch, css, archive, column)
    stack.text(line(brand["name"].upper(), family="bona-display", size=25 * unit, tracking=10 * unit))
    stack.rule(column * 0.22, 1.0 * unit, gap=9 * unit)
    stack.text(line("ENQUIRE", family="bona-sans", size=8 * unit, color=STONE_HEX,
                    tracking=3.2 * unit), gap=16 * unit)
    stack.text(line("\u0644\u0644\u0627\u0633\u062a\u0641\u0633\u0627\u0631 \u0648\u0627\u0644\u0645\u0639\u0627\u064a\u0646\u0629",
                    family="bona-sans, bona-arabic", size=11 * unit, color=STONE_HEX, rtl=True), gap=4 * unit)
    if facts.get("titleEn"):
        stack.text(line(facts["titleEn"], family="bona-display, bona-arabic-display",
                        size=16 * unit, leading=1.3), gap=26 * unit)
    if facts.get("titleAr"):
        stack.text(line(facts["titleAr"], family="bona-display, bona-arabic-display",
                        size=13 * unit, rtl=True, leading=1.55), gap=6 * unit)
    stack.image(qr.getvalue(), min(column * 0.34, H * 0.26), gap=24 * unit)
    stack.text(line(facts.get("urlLabel") or url, family="bona-sans", size=9.6 * unit,
                    tracking=0.6 * unit), gap=20 * unit)
    stack.text(line(brand["waLink"], family="bona-sans", size=9 * unit, tracking=0.6 * unit), gap=7 * unit)
    stack.text(line(brand["phone"], family="bona-sans", size=10.5 * unit, tracking=1.6 * unit), gap=7 * unit)
    stack.text(line(brand["hours"]["en"], family="bona-sans", size=8.4 * unit, color=STONE_HEX,
                    tracking=1.0 * unit), gap=12 * unit)
    stack.text(line(brand["hours"]["ar"], family="bona-sans, bona-arabic", size=10 * unit,
                    color=STONE_HEX, rtl=True), gap=4 * unit)

    licence = f"{brand['legalName']} \u00b7 {brand['host']} \u00b7 FAL {brand['fal']}"
    foot = Stack(page, scratch, css, archive, column)
    foot.text(line(licence, family="bona-sans", size=7.4 * unit, color=STONE_HEX, tracking=1.2 * unit))
    foot.text(line(f"{brand['nameAr']} \u00b7 \u0631\u062e\u0635\u0629 \u0641\u0627\u0644 {brand['fal']}",
                   family="bona-sans, bona-arabic", size=9 * unit, color=STONE_HEX, rtl=True), gap=5 * unit)
    foot_top = H - foot.height - 30 * unit

    top = max(20 * unit, (foot_top - stack.height) * 0.42)
    stack.draw(top)
    foot.draw(foot_top)


# ---- facts -------------------------------------------------------------------------------
DEFAULT_BRAND = {
    "name": "Bona",
    "nameAr": "بونا",
    "legalName": "Bona Real Estate",
    "tagline": {"en": "Exceptional homes, quietly.", "ar": "منازل استثنائية، بهدوء."},
    "site": "https://bona.azoz.uk",
    "phone": "+966 59 329 6933",
    "wa": "966593296933",
    "fal": "1100313556",
    "hours": {"en": "Sunday – Thursday, 10:00 – 19:00", "ar": "الأحد – الخميس، 10:00 – 19:00"},
}


def load_brand(site_json: str | None, override: dict | None) -> dict:
    brand = json.loads(json.dumps(DEFAULT_BRAND))
    if site_json and os.path.exists(site_json):
        try:
            with open(site_json, encoding="utf-8") as fh:
                site = json.load(fh)
            brand.update({
                "name": site.get("name") or brand["name"],
                "nameAr": site.get("nameAr") or brand["nameAr"],
                "legalName": site.get("legalName") or brand["legalName"],
                "tagline": site.get("tagline") or brand["tagline"],
                "site": site.get("url") or brand["site"],
                "phone": (site.get("whatsapp") or {}).get("display") or brand["phone"],
                "wa": (site.get("whatsapp") or {}).get("wa") or brand["wa"],
                "fal": (site.get("licences") or {}).get("fal") or brand["fal"],
                "hours": site.get("hours") or brand["hours"],
            })
        except (OSError, ValueError):
            pass
    if override:
        brand.update({k: v for k, v in override.items() if v})
    brand["host"] = re.sub(r"^https?://", "", brand["site"]).rstrip("/")
    brand["waLink"] = f"wa.me/{brand['wa']}"
    return brand


def read_facts(path: str, dropped: list) -> dict:
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    listing = raw.get("listing") if isinstance(raw.get("listing"), dict) else raw
    title = listing.get("title") or {}
    location = listing.get("location") or {}
    project = listing.get("project") or {}
    url = raw.get("url") or listing.get("url")
    if not url:
        site = (raw.get("brand") or {}).get("site") or DEFAULT_BRAND["site"]
        slug = listing.get("slug")
        url = f"{site.rstrip('/')}/properties/{slug}/" if slug else site
    place = raw.get("place")
    if not place:
        district = ((location.get("district") or {}).get("en") or "").strip()
        city = ((location.get("city") or {}).get("en") or "").strip()
        place = ", ".join([p for p in (district, city) if p])
    return {
        "id": scrub(raw.get("id") or listing.get("id"), dropped, "id"),
        "titleEn": scrub(raw.get("titleEn") or title.get("en"), dropped, "title.en"),
        "titleAr": scrub(raw.get("titleAr") or title.get("ar"), dropped, "title.ar"),
        "place": scrub(place, dropped, "location"),
        "priceEn": scrub(raw.get("priceEn") or raw.get("price"), dropped, "price"),
        "project": scrub(raw.get("project") or (project.get("name") or {}).get("en"), dropped, "project"),
        "developer": scrub(raw.get("developer") or project.get("developer"), dropped, "developer"),
        "url": url if re.match(r"^https://[\w.-]+/", url or "") else DEFAULT_BRAND["site"],
        "urlLabel": re.sub(r"^https?://", "", url or "").rstrip("/") or None,
        "brand": raw.get("brand") if isinstance(raw.get("brand"), dict) else None,
    }


# ---- size --------------------------------------------------------------------------------
def save_doc(doc, path: str) -> int:
    doc.save(path, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True, clean=True)
    return os.path.getsize(path)


def count_images(path: str, pages: int = 12) -> int:
    """How many images the first `pages` pages still reference. The blank-page canary."""
    import pymupdf

    total = 0
    doc = pymupdf.open(path)
    try:
        for i in range(min(doc.page_count, pages)):
            try:
                total += len(doc[i].get_images(full=True))
            except Exception:                                      # noqa: BLE001, S112
                continue
    finally:
        doc.close()
    return total


def shrink_to_fit(doc, out: str, max_bytes: int, steps: list) -> tuple:
    """Save, then downsample the images in escalating passes until the file fits.

    Each pass RE-OPENS the file it is shrinking. That is not tidiness: calling
    `rewrite_images()` on a Document that has already been `save()`d with `clean=True` and
    then saving it again produces a file whose pages are blank — the images are gone and
    nothing errors. Measured on PyMuPDF 1.28.2 with a 70 MB brochure: 70 MB in, a 0.17 MB
    file of empty pages out. Reopening between passes gives the intended 70 → 29 → 7.6 MB.

    `count_images` guards the same failure from the other side: a pass that leaves a page
    with no images at all is thrown away, whatever it did to the file size.

    @returns (bytes, page count)
    """
    import pymupdf

    pages = doc.page_count
    size = save_doc(doc, out)
    doc.close()
    steps.append(f"save:{size}")
    if size <= max_bytes:
        return size, pages

    before = count_images(out)
    if not hasattr(pymupdf.Document, "rewrite_images"):
        # Older PyMuPDF: the only lever left is the compressor.
        tmp = f"{out}.shrink"
        reopened = pymupdf.open(out)
        try:
            reopened.ez_save(tmp, garbage=4, deflate=True, deflate_images=True, clean=True)
        finally:
            reopened.close()
        if os.path.getsize(tmp) < size:
            os.replace(tmp, out)
            size = os.path.getsize(out)
        elif os.path.exists(tmp):
            os.remove(tmp)
        steps.append(f"ez_save:{size}")
        return size, pages

    for step in SHRINK_STEPS:
        tmp = f"{out}.shrink"
        try:
            reopened = pymupdf.open(out)
            try:
                reopened.rewrite_images(dpi_threshold=step["dpi_threshold"],
                                        dpi_target=step["dpi_target"],
                                        quality=step["quality"], lossy=True, lossless=True)
                save_doc(reopened, tmp)
            finally:
                reopened.close()
        except Exception as exc:                                   # noqa: BLE001
            steps.append(f"rewrite_failed@{step['dpi_target']}dpi:{exc}")
            if os.path.exists(tmp):
                os.remove(tmp)
            break
        if before and count_images(tmp) == 0:
            steps.append(f"rewrite@{step['dpi_target']}dpi:emptied-pages-discarded")
            os.remove(tmp)
            break
        os.replace(tmp, out)
        size = os.path.getsize(out)
        steps.append(f"rewrite@{step['dpi_target']}dpi/q{step['quality']}:{size}")
        if size <= max_bytes:
            return size, pages
    return size, pages


# ---- main --------------------------------------------------------------------------------
def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    repo_default = os.path.abspath(os.path.join(here, "..", ".."))

    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("facts", help="JSON: the listing (or {id,titleEn,titleAr,place,priceEn,url})")
    ap.add_argument("out")
    ap.add_argument("--max-mb", type=float, default=DEFAULT_MAX_MB)
    ap.add_argument("--repo", default=repo_default, help="where public/fonts and src/data/site.json live")
    ap.add_argument("--font-cache", default=None)
    args = ap.parse_args()

    max_bytes = int(max(0.25, args.max_mb) * 1024 * 1024)

    try:
        import pymupdf  # noqa: PLC0415
    except Exception as exc:                                       # noqa: BLE001
        return fail(f"pymupdf unavailable: {exc}", "environment")
    try:
        import segno  # noqa: F401,PLC0415
    except Exception as exc:                                       # noqa: BLE001
        return fail(f"segno unavailable: {exc}", "environment")

    if not os.path.exists(args.pdf):
        return fail(f"no such file: {args.pdf}", "input")

    dropped: list = []
    try:
        facts = read_facts(args.facts, dropped)
    except (OSError, ValueError) as exc:
        return fail(f"unreadable facts JSON: {exc}", "input")

    brand = load_brand(os.path.join(args.repo, "src", "data", "site.json"), facts.get("brand"))
    cache = args.font_cache or os.path.join(tempfile.gettempdir(), "bona-brochure-fonts")
    try:
        faces = prepare_fonts(os.path.join(args.repo, "public", "fonts"), cache)
    except Exception as exc:                                       # noqa: BLE001
        return fail(f"brand fonts unavailable: {exc}", "fonts")

    try:
        doc = pymupdf.open(args.pdf)
    except Exception as exc:                                       # noqa: BLE001
        return fail(f"unreadable PDF: {exc}", "input")
    if doc.needs_pass:
        doc.close()
        return fail("PDF is password protected", "input")
    src_pages = doc.page_count
    if src_pages < 1:
        doc.close()
        return fail("PDF has no pages", "input")

    # The added pages take the size of the brochure's own first page so the document reads
    # as one piece in a viewer instead of jumping between page sizes.
    # The added pages take the brochure's DOMINANT page size, not page 1's: one of the
    # owner's real files opens on a 709x510 half-spread and then runs 15 pages at
    # 1417x510, and a cover at the odd size out reads as a mistake in a viewer.
    W, H = dominant_page_size(doc)
    unit = page_unit(W, H)

    css = font_css(faces)
    archive = pymupdf.Archive(cache)
    latin_file = os.path.join(cache, faces["bona-sans"])
    latin = pymupdf.Font(fontfile=latin_file)
    footer_text = " · ".join([p for p in [brand["host"], brand["phone"], f"FAL {brand['fal']}",
                                          facts.get("id")] if p])

    try:
        # A scratch page in a throwaway document: every block is measured on it before a
        # real page is touched (see Stack).
        ruler = pymupdf.open()
        scratch = ruler.new_page(width=max(W, 700.0), height=3200)
        for i in range(src_pages):
            # A page's OWN size decides its footer, so a mixed-size brochure gets a strip
            # that is proportional on every page instead of one sized for the cover.
            page = doc[i]
            draw_footer(page, footer_text, latin, latin_file,
                        page_unit(page.rect.width, page.rect.height))
        draw_enquire(doc.new_page(width=W, height=H), scratch, facts, brand, css, archive, unit)
        draw_cover(doc.new_page(pno=0, width=W, height=H), scratch, facts, brand, css, archive, unit)
        ruler.close()
        title = " — ".join([p for p in [facts.get("titleEn"), brand["legalName"]] if p])
        doc.set_metadata({
            "title": title or brand["legalName"],
            "author": brand["legalName"],
            "subject": facts.get("place") or "",
            "keywords": facts.get("id") or "",
            "producer": brand["host"],
            "creator": brand["host"],
        })
    except Exception as exc:                                       # noqa: BLE001
        doc.close()
        return fail(f"could not brand the PDF: {exc}", "render")

    steps: list = []
    tmp_out = f"{args.out}.tmp-{os.getpid()}"
    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    try:
        # shrink_to_fit() closes `doc`: every downsample pass has to work on the file on
        # disk, never on the Document that was already saved (see its docstring).
        size, pages = shrink_to_fit(doc, tmp_out, max_bytes, steps)
    except Exception as exc:                                       # noqa: BLE001
        try:
            doc.close()
        except Exception:                                          # noqa: BLE001, S110
            pass
        for leftover in (tmp_out, f"{tmp_out}.shrink"):
            if os.path.exists(leftover):
                os.remove(leftover)
        return fail(f"could not save the branded PDF: {exc}", "save")

    if size > max_bytes:
        os.remove(tmp_out)
        return fail(
            f"the branded brochure is {size / 1048576:.1f} MB after downsampling, "
            f"over the {max_bytes / 1048576:.0f} MB limit",
            "too-large",
        )

    os.replace(tmp_out, args.out)
    print(json.dumps({
        "ok": True,
        "out": os.path.abspath(args.out),
        "bytes": size,
        "srcBytes": os.path.getsize(args.pdf),
        "pages": pages,
        "srcPages": src_pages,
        "maxBytes": max_bytes,
        "steps": steps,
        "scrubbed": sorted(set(dropped)),
        "id": facts.get("id"),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
