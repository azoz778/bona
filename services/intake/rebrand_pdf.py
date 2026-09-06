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


def put(page, rect, htmltext, css, archive):
    """insert_htmlbox with a hard failure when the text does not fit its box."""
    spare, _scale = page.insert_htmlbox(rect, htmltext, css=css, archive=archive, scale_low=0.55)
    return spare


# ---- pages -------------------------------------------------------------------------------
def draw_cover(page, facts, brand, css, archive, unit):
    import pymupdf

    W, H = page.rect.width, page.rect.height
    page.draw_rect(pymupdf.Rect(0, 0, W, H), fill=IVORY, color=None)
    side = W * 0.14

    # wordmark — the logo IS the name set in Cormorant; the champagne rule under it is the
    # bar at the foot of public/logo.svg.
    put(page, pymupdf.Rect(side, H * 0.200, W - side, H * 0.262),
        line(brand["name"].upper(), family="bona-display", size=36 * unit, tracking=14 * unit),
        css, archive)
    rule = W * 0.10
    y_rule = H * 0.272
    page.draw_line(pymupdf.Point(W / 2 - rule, y_rule), pymupdf.Point(W / 2 + rule, y_rule),
                   color=CHAMPAGNE, width=1.0 * unit)

    y = H * 0.298
    put(page, pymupdf.Rect(side, y, W - side, y + 26 * unit),
        line(brand["tagline"]["en"].upper(), family="bona-sans", size=7.6 * unit,
             color=STONE_HEX, tracking=2.6 * unit), css, archive)
    y += 22 * unit
    put(page, pymupdf.Rect(side, y, W - side, y + 30 * unit),
        line(brand["tagline"]["ar"], family="bona-sans, bona-arabic", size=10 * unit,
             color=STONE_HEX, rtl=True), css, archive)

    # the property
    y = H * 0.445
    if facts.get("titleAr"):
        put(page, pymupdf.Rect(side * 0.7, y, W - side * 0.7, y + 90 * unit),
            line(facts["titleAr"], family="bona-display, bona-arabic-display",
                 size=21 * unit, rtl=True, leading=1.6), css, archive)
        y += 92 * unit
    if facts.get("titleEn"):
        put(page, pymupdf.Rect(side * 0.7, y, W - side * 0.7, y + 90 * unit),
            line(facts["titleEn"], family="bona-display, bona-arabic-display", size=25 * unit,
                 leading=1.28), css, archive)
        y += 84 * unit

    meta = " · ".join([p for p in [facts.get("place"), facts.get("priceEn")] if p])
    if meta:
        put(page, pymupdf.Rect(side * 0.6, y, W - side * 0.6, y + 40 * unit),
            line(meta, family="bona-sans, bona-arabic", size=9 * unit, color=STONE_HEX,
                 tracking=1.4 * unit), css, archive)
        y += 26 * unit
    project = " · ".join([p for p in [facts.get("project"), facts.get("developer")] if p])
    if project:
        put(page, pymupdf.Rect(side * 0.6, y, W - side * 0.6, y + 34 * unit),
            line(project, family="bona-sans, bona-arabic", size=8 * unit, color=STONE_HEX,
                 tracking=1.2 * unit), css, archive)

    foot = " · ".join([p for p in [brand["host"], f"FAL {brand['fal']}", facts.get("id")] if p])
    put(page, pymupdf.Rect(side * 0.5, H * 0.895, W - side * 0.5, H * 0.945),
        line(foot, family="bona-sans", size=7.4 * unit, color=STONE_HEX, tracking=1.4 * unit),
        css, archive)


def draw_footer(page, text, latin_font, latin_file, unit):
    """The strip on a developer's page: ivory band, champagne hairline, ink text.

    Latin only and drawn with insert_text rather than the story engine — it is stamped on
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


def draw_enquire(page, facts, brand, css, archive, unit):
    import pymupdf
    import segno

    W, H = page.rect.width, page.rect.height
    page.draw_rect(pymupdf.Rect(0, 0, W, H), fill=IVORY, color=None)
    side = W * 0.14

    put(page, pymupdf.Rect(side, H * 0.10, W - side, H * 0.175),
        line(brand["name"].upper(), family="bona-display", size=26 * unit, tracking=9 * unit),
        css, archive)
    rule = W * 0.07
    page.draw_line(pymupdf.Point(W / 2 - rule, H * 0.176), pymupdf.Point(W / 2 + rule, H * 0.176),
                   color=CHAMPAGNE, width=1.0 * unit)

    y = H * 0.205
    put(page, pymupdf.Rect(side, y, W - side, y + 26 * unit),
        line("ENQUIRE", family="bona-sans", size=8 * unit, color=STONE_HEX, tracking=3.2 * unit),
        css, archive)
    y += 20 * unit
    put(page, pymupdf.Rect(side, y, W - side, y + 30 * unit),
        line("للاستفسار والمعاينة", family="bona-sans, bona-arabic", size=11 * unit,
             color=STONE_HEX, rtl=True), css, archive)

    y = H * 0.275
    if facts.get("titleEn"):
        put(page, pymupdf.Rect(side * 0.6, y, W - side * 0.6, y + 70 * unit),
            line(facts["titleEn"], family="bona-display, bona-arabic-display", size=17 * unit),
            css, archive)
        y += 46 * unit
    if facts.get("titleAr"):
        put(page, pymupdf.Rect(side * 0.6, y, W - side * 0.6, y + 60 * unit),
            line(facts["titleAr"], family="bona-display, bona-arabic-display", size=14 * unit,
                 rtl=True, leading=1.6), css, archive)

    # QR of the listing URL
    url = facts.get("url") or brand["site"]
    qr_side = min(W * 0.30, H * 0.20)
    qr_top = H * 0.44
    buf = io.BytesIO()
    segno.make(url, error="m").save(buf, kind="png", scale=14, border=1,
                                    dark=INK_HEX, light=IVORY_HEX)
    page.insert_image(pymupdf.Rect((W - qr_side) / 2, qr_top, (W + qr_side) / 2, qr_top + qr_side),
                      stream=buf.getvalue())

    y = qr_top + qr_side + 22 * unit
    rows = [
        (facts.get("urlLabel") or url, "bona-sans", 9.6 * unit, INK_HEX, 0.6 * unit, False),
        (brand["waLink"], "bona-sans", 9.0 * unit, INK_HEX, 0.6 * unit, False),
        (brand["phone"], "bona-sans", 10.5 * unit, INK_HEX, 1.6 * unit, False),
        (brand["hours"]["en"], "bona-sans", 8.4 * unit, STONE_HEX, 1.0 * unit, False),
        (brand["hours"]["ar"], "bona-sans, bona-arabic", 10 * unit, STONE_HEX, 0, True),
    ]
    for text, family, size, colour, tracking, rtl in rows:
        if not text:
            continue
        put(page, pymupdf.Rect(side * 0.4, y, W - side * 0.4, y + size * 3.4),
            line(text, family=family, size=size, color=colour, tracking=tracking, rtl=rtl),
            css, archive)
        y += size * 2.3

    y = H * 0.895
    licence = f"{brand['legalName']} · {brand['host']} · FAL {brand['fal']}"
    put(page, pymupdf.Rect(side * 0.4, y, W - side * 0.4, y + 30 * unit),
        line(licence, family="bona-sans", size=7.4 * unit, color=STONE_HEX, tracking=1.2 * unit),
        css, archive)
    y += 20 * unit
    put(page, pymupdf.Rect(side * 0.4, y, W - side * 0.4, y + 30 * unit),
        line(f"{brand['nameAr']} · رخصة فال {brand['fal']}", family="bona-sans, bona-arabic",
             size=9 * unit, color=STONE_HEX, rtl=True), css, archive)


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
    first = doc[0].rect
    W, H = float(first.width), float(first.height)
    if not (MIN_PAGE_PT <= W <= MAX_PAGE_PT and MIN_PAGE_PT <= H <= MAX_PAGE_PT):
        W, H = A4
    unit = W / 595.0

    css = font_css(faces)
    archive = pymupdf.Archive(cache)
    latin_file = os.path.join(cache, faces["bona-sans"])
    latin = pymupdf.Font(fontfile=latin_file)
    footer_text = " · ".join([p for p in [brand["host"], brand["phone"], f"FAL {brand['fal']}",
                                          facts.get("id")] if p])

    try:
        for i in range(src_pages):
            draw_footer(doc[i], footer_text, latin, latin_file, unit)
        draw_enquire(doc.new_page(width=W, height=H), facts, brand, css, archive, unit)
        draw_cover(doc.new_page(pno=0, width=W, height=H), facts, brand, css, archive, unit)
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
