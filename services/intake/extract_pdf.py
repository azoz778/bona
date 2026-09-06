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

With `--mode pages` it does something else entirely: it renders EVERY page as a readable
JPEG (long side <= 1600 px by default) into <outdir>/pages/ and prints
{"ok": true, "pages": n, "mode": "pages", "pageImages": [{page, file, abs, width, height}]}.
That mode exists for brochures with no text layer — the AI reads the page images instead.
`--pages 1,3,5` renders only those pages, `--page-dir crops` puts them somewhere else, and
`--render-min-short-side` / `--render-max-pixels` raise the resolution for the pages photo
regions are cropped out of (a 1080x10449 pt "story" page is useless at 166x1600).

With `--mode views` it renders the same pages FOR LOOKING AT: a page whose aspect ratio is
more extreme than --view-max-aspect is cut into overlapping slices first, because a single
render of a 1:9.7 page is a 166 px wide sliver by the time it reaches the model. Each view
carries the normalised page rectangle it covers, so a box the model draws on a slice maps
back onto the page:
{"ok": true, "mode": "views", "views": [{id, page, slice, slices, file, abs, width, height,
                                         x0, y0, x1, y1}]}

Decompression-bomb caps: an embedded bitmap over MAX_PIXELS (50 MP) is dropped in usable()
BEFORE any Pixmap is built, and every page render is clamped to a long side in pixels
(RENDER_LONG_SIDE) whatever DPI is asked for.

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
import unicodedata

MIN_SIDE_DEFAULT = 700
MIN_SHORT_SIDE = 420
MIN_PIXELS = 700 * 450          # drop banners/strips that pass one side but carry no scene
MAX_PIXELS = 50_000_000         # decompression-bomb cap: never build a Pixmap bigger than this
FLAT_RATIO = 0.015              # below this a bitmap is a logo/wordmark, never a photograph
FLAT_MIN_COLOURS = 32
MAX_CANDIDATES = 40
MAX_PAGES = 60
RENDER_DPI = 150
RENDER_THRESHOLD = 3            # < this many usable embedded images -> rasterise pages
RENDER_LONG_SIDE = 2000         # hard cap on a rendered page's long side, in pixels
PAGE_READ_LONG_SIDE = 1600      # page renders handed to the AI to READ (--mode pages)
VIEW_LONG_SIDE = 1600           # a view the model looks at (--mode views)
VIEW_MAX_ASPECT = 2.2           # beyond this a page is sliced before it is rendered
VIEW_TARGET_ASPECT = 1.45       # what each slice of a sliced page aims for
VIEW_OVERLAP = 0.06             # slices overlap, so a photo on a seam is whole in one of them
MAX_VIEWS = 40                  # hard cap on how many images one --mode views run produces
RENDER_MAX_PIXELS = 30_000_000  # a render is scaled down until it fits (memory cap)


def collapse(s: str) -> str:
    return re.sub(r"[ \t ]+", " ", (s or "")).strip()


def usable(width: int, height: int, min_side: int) -> bool:
    # Longest side carries the resolution; the short side only has to be big enough
    # to survive a 1920px hero crop. Portrait brochure photos (e.g. 649x1190) count.
    if max(width, height) < min_side or min(width, height) < MIN_SHORT_SIDE:
        return False
    if width * height < MIN_PIXELS:
        return False
    # Decompression bomb: a 60000x60000 "image" would be 10 GB once PyMuPDF builds the
    # Pixmap. Checked HERE, before colour_ratio() or extract_image() ever touch it.
    if width * height > MAX_PIXELS:
        return False
    ar = width / height if height else 0
    # Logos/banners/rules: absurdly wide or tall crops are never property photos.
    return 0.28 <= ar <= 4.0


def render_zoom(width_pt: float, height_pt: float, dpi: int, long_side: int,
                min_short_side: int = 0, max_pixels: int = 0) -> float:
    """Zoom for `dpi`, capped at `long_side` px, floored at `min_short_side` px, and then
    scaled back until the render fits `max_pixels`.

    The floor is what makes a "story" page usable: 1080x10449 pt at long_side=3000 is
    310x3000, and nothing croppable survives that. Asking for a 1600 px SHORT side gives
    1600x15476 instead — which is what the page's own bitmap actually holds.
    """
    long_pt = max(width_pt, height_pt) or 1.0
    short_pt = min(width_pt, height_pt) or 1.0
    zoom = dpi / 72.0
    if long_side and long_pt * zoom > long_side:
        zoom = long_side / long_pt
    if min_short_side and short_pt * zoom < min_short_side:
        zoom = min_short_side / short_pt
    if max_pixels and (width_pt * zoom) * (height_pt * zoom) > max_pixels:
        zoom = (max_pixels / (width_pt * height_pt)) ** 0.5
    return zoom


def render_matrix(page, dpi: int, long_side: int, min_short_side: int = 0,
                  max_pixels: int = RENDER_MAX_PIXELS):
    """Zoom for `dpi`, clamped so the rendered page never exceeds `long_side` pixels."""
    import pymupdf
    rect = page.rect
    zoom = render_zoom(rect.width, rect.height, dpi, long_side, min_short_side, max_pixels)
    return pymupdf.Matrix(zoom, zoom)


def clip_matrix(clip, dpi: int, long_side: int, max_pixels: int = RENDER_MAX_PIXELS):
    """render_matrix for part of a page (a view slice): same caps, measured on the clip."""
    import pymupdf
    zoom = render_zoom(clip.width, clip.height, dpi, long_side, 0, max_pixels)
    return pymupdf.Matrix(zoom, zoom)


def view_rects(width_pt: float, height_pt: float, max_aspect: float = VIEW_MAX_ASPECT,
               target: float = VIEW_TARGET_ASPECT, overlap: float = VIEW_OVERLAP):
    """Normalised page rectangles to render as separate views.

    One rectangle (the whole page) unless the page is more extreme than `max_aspect`, in
    which case it is cut along its long axis into overlapping slices of roughly `target`.
    """
    import math
    w = width_pt or 1.0
    h = height_pt or 1.0
    tall = h / w
    wide = w / h
    if tall > max_aspect:
        n = min(MAX_VIEWS, max(2, math.ceil(tall / target)))
        step = 1.0 / n
        out = []
        for i in range(n):
            y0 = max(0.0, i * step - overlap * step)
            y1 = min(1.0, (i + 1) * step + overlap * step)
            out.append((0.0, y0, 1.0, y1))
        return out
    if wide > max_aspect:
        n = min(MAX_VIEWS, max(2, math.ceil(wide / target)))
        step = 1.0 / n
        out = []
        for i in range(n):
            x0 = max(0.0, i * step - overlap * step)
            x1 = min(1.0, (i + 1) * step + overlap * step)
            out.append((x0, 0.0, x1, 1.0))
        return out
    return [(0.0, 0.0, 1.0, 1.0)]


def wanted_pages(spec: str, pages: int) -> list[int]:
    """`--pages "1,3,5"` -> [0, 2, 4]; empty -> every page."""
    if not spec:
        return list(range(pages))
    out = []
    for part in str(spec).replace(" ", "").split(","):
        if not part:
            continue
        try:
            n = int(part)
        except ValueError:
            continue
        if 1 <= n <= pages and (n - 1) not in out:
            out.append(n - 1)
    return out


def placement_coverage(page, xref: int):
    """How much of the page this image is drawn over, 0..1 (None when it cannot be told).

    A brochure page exported as one flattened picture covers 1.0 of its page — that, not a
    guess about the pixels, is what marks a candidate as a page-sized composite.
    """
    try:
        rects = page.get_image_rects(xref)
    except Exception:
        return None
    if not rects:
        return None
    area = page.rect.width * page.rect.height
    if area <= 0:
        return None
    biggest = max(rects, key=lambda r: r.width * r.height)
    return round(min(1.0, (biggest.width * biggest.height) / area), 4)


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
    ap.add_argument("--render-long-side", type=int, default=RENDER_LONG_SIDE)
    ap.add_argument("--render-min-short-side", type=int, default=0,
                    help="floor on the SHORT side of a page render (--mode pages); 0 = no floor")
    ap.add_argument("--render-max-pixels", type=int, default=RENDER_MAX_PIXELS)
    ap.add_argument("--page-dir", default="pages", help="subdirectory of outdir for --mode pages")
    ap.add_argument("--pages", default="", help="1-based page numbers to render, comma separated")
    ap.add_argument("--view-long-side", type=int, default=VIEW_LONG_SIDE)
    ap.add_argument("--view-max-aspect", type=float, default=VIEW_MAX_ASPECT)
    ap.add_argument("--view-dir", default=os.path.join("regions", "views"))
    ap.add_argument("--mode", choices=("full", "pages", "views"), default="full",
                    help="full = text + candidate photos; pages = render pages; views = render pages sliced for looking at")
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
    page_sizes = []
    for i in range(pages):
        try:
            page_text.append(collapse(doc[i].get_text()))
        except Exception:
            page_text.append("")
        try:
            rect = doc[i].rect
            page_sizes.append({"page": i + 1, "width": round(rect.width, 2), "height": round(rect.height, 2)})
        except Exception:
            page_sizes.append({"page": i + 1, "width": 0, "height": 0})

    if args.mode == "pages":
        # Every page as a readable JPEG, for a brochure with no text layer. Nothing is
        # classified here: the caller hands these to the AI gate, which decides.
        # The same mode, with --page-dir/--pages/--render-min-short-side, renders the few
        # pages photo regions are cropped out of, at the resolution the crops need.
        rel_dir = args.page_dir or "pages"
        page_dir = os.path.join(args.outdir, rel_dir)
        os.makedirs(page_dir, exist_ok=True)
        page_images = []
        long_side = args.render_long_side or PAGE_READ_LONG_SIDE
        for i in wanted_pages(args.pages, pages):
            try:
                page = doc[i]
                matrix = render_matrix(page, args.render_dpi, long_side,
                                       args.render_min_short_side, args.render_max_pixels)
                pix = page.get_pixmap(matrix=matrix, alpha=False)
                name = f"{i + 1:03d}.jpg"
                path = os.path.join(page_dir, name)
                with open(path, "wb") as fh:
                    fh.write(pix.tobytes("jpg"))
                page_images.append({
                    "page": i + 1,
                    "file": os.path.join(rel_dir, name),
                    "abs": os.path.abspath(path),
                    "width": pix.width,
                    "height": pix.height,
                })
            except Exception:
                continue
        doc.close()
        print(json.dumps({"ok": True, "pages": pages, "mode": "pages", "pageImages": page_images}, ensure_ascii=False))
        return 0

    if args.mode == "views":
        # Pages rendered FOR LOOKING AT, sliced when the page is too long to read whole.
        # Every view says which normalised slice of its page it is, so a box drawn on it
        # maps back onto the page (lib/photo-regions.mjs does that mapping).
        import pymupdf as _pymupdf  # noqa: PLC0415
        view_dir = os.path.join(args.outdir, args.view_dir)
        os.makedirs(view_dir, exist_ok=True)
        views = []
        for i in wanted_pages(args.pages, pages):
            if len(views) >= MAX_VIEWS:
                break
            try:
                page = doc[i]
            except Exception:
                continue
            rect = page.rect
            rects = view_rects(rect.width, rect.height, args.view_max_aspect)
            for k, (x0, y0, x1, y1) in enumerate(rects):
                if len(views) >= MAX_VIEWS:
                    break
                clip = _pymupdf.Rect(
                    rect.x0 + rect.width * x0, rect.y0 + rect.height * y0,
                    rect.x0 + rect.width * x1, rect.y0 + rect.height * y1,
                )
                try:
                    matrix = clip_matrix(clip, args.render_dpi, args.view_long_side, args.render_max_pixels)
                    pix = page.get_pixmap(matrix=matrix, clip=clip, alpha=False)
                    name = f"{i + 1:03d}-{k + 1:02d}.jpg"
                    path = os.path.join(view_dir, name)
                    with open(path, "wb") as fh:
                        fh.write(pix.tobytes("jpg"))
                except Exception:
                    continue
                views.append({
                    "id": len(views),
                    "page": i + 1,
                    "slice": k + 1,
                    "slices": len(rects),
                    "file": os.path.join(args.view_dir, name),
                    "abs": os.path.abspath(path),
                    "width": pix.width,
                    "height": pix.height,
                    "x0": round(x0, 6), "y0": round(y0, 6),
                    "x1": round(x1, 6), "y1": round(y1, 6),
                })
        doc.close()
        print(json.dumps({"ok": True, "pages": pages, "mode": "views", "views": views}, ensure_ascii=False))
        return 0

    seen: set[str] = set()
    candidates = []
    embedded_total = 0

    def add(data: bytes, ext: str, width: int, height: int, page: int, source: str,
            colours: int | None = None, coverage: float | None = None) -> None:
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
            # Fraction of its page this bitmap is drawn over. 1.0 = the page IS this
            # picture, which is what a designed deck exported page-by-page looks like.
            "coverage": coverage,
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
            add(ext_img["image"], ext, w, h, i + 1, "embedded", stats[0] if stats else None,
                placement_coverage(doc[i], xref))

    rendered = False
    if len(candidates) < RENDER_THRESHOLD:
        # Image-heavy design PDFs (Canva/Illustrator) often carry one flattened bitmap
        # per page, or vector art we cannot extract — rasterise instead.
        rendered = True
        candidates = []
        seen.clear()
        for i in range(min(pages, args.max_candidates)):
            try:
                page = doc[i]
                pix = page.get_pixmap(matrix=render_matrix(page, args.render_dpi, args.render_long_side), alpha=False)
                add(pix.tobytes("jpg"), "jpg", pix.width, pix.height, i + 1, "render", None, 1.0)
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
        "pageSizes": page_sizes,
        "text": collapse("\n".join(page_text)),
        "embeddedImageCount": embedded_total,
        "rendered": rendered,
        "candidates": candidates,
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
