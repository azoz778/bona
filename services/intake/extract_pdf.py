#!/usr/bin/env python3
"""Bona intake — PDF text + image extraction (PyMuPDF).

Run through uv so no system install is needed:

    uv run --with pymupdf python services/intake/extract_pdf.py <in.pdf> <outdir> [--json]

Writes candidate images to <outdir>/images/NNN.<ext> and prints one JSON object on
stdout:

    {
      "ok": true,
      "pages": 12,
      "encrypted": false,
      "meta": {...},                       # PDF metadata (title/author/producer)
      "pageText": ["page 1 text", ...],    # per page, whitespace-collapsed
      "text": "all pages joined",
      "embeddedImageCount": 41,            # before filtering
      "rendered": false,                   # true when pages were rasterised
      "candidates": [
        { "index": 0, "file": "images/000.jpg", "abs": "/…/000.jpg",
          "width": 1600, "height": 1067, "page": 2, "source": "embedded",
          "sha256": "…", "bytes": 412233 }
      ]
    }

Never raises for a bad PDF: prints {"ok": false, "error": "..."} and exits 1.
The caller (lib/pdf.mjs) is responsible for the default-deny classification.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys

MIN_SIDE_DEFAULT = 700
MIN_SHORT_SIDE = 420
MIN_PIXELS = 700 * 450          # drop banners/strips that pass one side but carry no scene
FLAT_RATIO = 0.015              # below this a bitmap is a logo/wordmark, never a photograph
FLAT_MIN_COLOURS = 32
MAX_CANDIDATES = 40
MAX_PAGES = 60
RENDER_DPI = 150
RENDER_THRESHOLD = 3            # < this many usable embedded images -> rasterise pages


def collapse(s: str) -> str:
    return re.sub(r"[ \t ]+", " ", (s or "")).strip()


def usable(width: int, height: int, min_side: int) -> bool:
    # Longest side carries the resolution; the short side only has to be big enough
    # to survive a 1920px hero crop. Portrait brochure photos (e.g. 649x1190) count.
    if max(width, height) < min_side or min(width, height) < MIN_SHORT_SIDE:
        return False
    if width * height < MIN_PIXELS:
        return False
    ar = width / height if height else 0
    # Logos/banners/rules: absurdly wide or tall crops are never property photos.
    return 0.28 <= ar <= 4.0


def colour_ratio(doc, xref: int):
    """Distinct colours in a <=64px thumbnail / its pixel count.

    Measured on real brochures: brand logos and wordmarks score ~0.0004–0.003,
    QR codes ~0.03, photographs and renders 0.05–1.0. Anything under
    FLAT_RATIO is flat vector art, not a photo of a property.
    Returns (distinct, sampled, ratio) or None when the image cannot be decoded.
    """
    try:
        import pymupdf
        pix = pymupdf.Pixmap(doc, xref)
        if pix.colorspace is None:
            return None
        if pix.n > 3:
            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        while max(pix.width, pix.height) > 64:
            pix.shrink(1)
        samples, n = pix.samples, pix.n
        colours = {samples[i:i + n] for i in range(0, len(samples) - n + 1, n)}
        sampled = max(1, pix.width * pix.height)
        return len(colours), sampled, len(colours) / sampled
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("outdir")
    ap.add_argument("--min-side", type=int, default=MIN_SIDE_DEFAULT)
    ap.add_argument("--max-candidates", type=int, default=MAX_CANDIDATES)
    ap.add_argument("--max-pages", type=int, default=MAX_PAGES)
    ap.add_argument("--render-dpi", type=int, default=RENDER_DPI)
    args = ap.parse_args()

    try:
        import pymupdf  # noqa: PLC0415
    except Exception as exc:  # pragma: no cover - environment problem
        print(json.dumps({"ok": False, "error": f"pymupdf unavailable: {exc}"}))
        return 1

    img_dir = os.path.join(args.outdir, "images")
    os.makedirs(img_dir, exist_ok=True)

    try:
        doc = pymupdf.open(args.pdf)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": f"unreadable PDF: {exc}"}))
        return 1

    if doc.needs_pass:
        print(json.dumps({"ok": False, "error": "PDF is password protected"}))
        return 1

    pages = doc.page_count
    if pages > args.max_pages:
        print(json.dumps({"ok": False, "error": f"{pages} pages exceeds the {args.max_pages}-page limit"}))
        return 1

    page_text = []
    for i in range(pages):
        try:
            page_text.append(collapse(doc[i].get_text()))
        except Exception:
            page_text.append("")

    seen: set[str] = set()
    candidates = []
    embedded_total = 0

    def add(data: bytes, ext: str, width: int, height: int, page: int, source: str,
            colours: int | None = None) -> None:
        digest = hashlib.sha256(data).hexdigest()
        if digest in seen:
            return
        seen.add(digest)
        idx = len(candidates)
        name = f"{idx:03d}.{ext}"
        path = os.path.join(img_dir, name)
        with open(path, "wb") as fh:
            fh.write(data)
        candidates.append({
            "index": idx,
            "file": os.path.join("images", name),
            "abs": os.path.abspath(path),
            "width": width,
            "height": height,
            "page": page,
            "source": source,
            "sha256": digest,
            "bytes": len(data),
            "colours": colours,
        })

    for i in range(pages):
        try:
            images = doc[i].get_images(full=True)
        except Exception:
            images = []
        embedded_total += len(images)
        for info in images:
            if len(candidates) >= args.max_candidates:
                break
            xref = info[0]
            try:
                ext_img = doc.extract_image(xref)
            except Exception:
                continue
            w, h = int(ext_img.get("width") or 0), int(ext_img.get("height") or 0)
            if not usable(w, h, args.min_side):
                continue
            stats = colour_ratio(doc, xref)
            if stats and (stats[2] < FLAT_RATIO or stats[0] < FLAT_MIN_COLOURS):
                continue  # brand logo / wordmark / flat vector art
            ext = (ext_img.get("ext") or "png").lower()
            if ext not in ("jpg", "jpeg", "png", "webp", "tiff", "bmp"):
                ext = "png"
            add(ext_img["image"], ext, w, h, i + 1, "embedded", stats[0] if stats else None)

    rendered = False
    if len(candidates) < RENDER_THRESHOLD:
        # Image-heavy design PDFs (Canva/Illustrator) often carry one flattened bitmap
        # per page, or vector art we cannot extract — rasterise instead.
        rendered = True
        candidates = []
        seen.clear()
        zoom = args.render_dpi / 72.0
        matrix = pymupdf.Matrix(zoom, zoom)
        for i in range(min(pages, args.max_candidates)):
            try:
                pix = doc[i].get_pixmap(matrix=matrix, alpha=False)
                add(pix.tobytes("jpg"), "jpg", pix.width, pix.height, i + 1, "render")
            except Exception:
                continue

    meta = {k: collapse(str(v)) for k, v in (doc.metadata or {}).items() if v}
    doc.close()

    print(json.dumps({
        "ok": True,
        "pages": pages,
        "encrypted": False,
        "meta": meta,
        "pageText": page_text,
        "text": collapse("\n".join(page_text)),
        "embeddedImageCount": embedded_total,
        "rendered": rendered,
        "candidates": candidates,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
