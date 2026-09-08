#!/usr/bin/env python3
"""Rebuild scripts/social/fonts/*.ttf from public/fonts/*.woff2.

Run from the repo root:

    uv run --with "fonttools[woff]" python3 scripts/social/fonts/build-fonts.py

Pango (inside sharp) reads a fontconfig font set and fontconfig cannot read WOFF2, so the six
brand faces the website loads are re-emitted here as plain TrueType. The name table is
rewritten at the same time: Google's static instances call themselves things like
"Montserrat Thin SemiBold", which fontconfig then matches badly. Glyph outlines are untouched.
See README.md in this directory.
"""
import os
import sys

from fontTools.ttLib import TTFont

SRC = os.path.join("public", "fonts")
OUT = os.path.join("scripts", "social", "fonts")

# (source woff2, output ttf, family, style, usWeightClass)
JOBS = [
    ("amiri-700.woff2", "Amiri-Bold.ttf", "Amiri", "Bold", 700),
    ("plex-arabic-400.woff2", "IBMPlexSansArabic-Regular.ttf", "IBM Plex Sans Arabic", "Regular", 400),
    ("plex-arabic-500.woff2", "IBMPlexSansArabic-Medium.ttf", "IBM Plex Sans Arabic", "Medium", 500),
    ("cormorant-600.woff2", "CormorantGaramond-SemiBold.ttf", "Cormorant Garamond", "SemiBold", 600),
    ("montserrat-400.woff2", "Montserrat-Regular.ttf", "Montserrat", "Regular", 400),
    ("montserrat-600.woff2", "Montserrat-SemiBold.ttf", "Montserrat", "SemiBold", 600),
]

# Styles fontconfig understands as a plain style rather than part of the family name.
CANONICAL_STYLES = {"Regular", "Bold", "Italic", "Bold Italic"}


def main() -> int:
    if not os.path.isdir(SRC):
        print(f"run me from the repo root: {SRC} not found", file=sys.stderr)
        return 1
    os.makedirs(OUT, exist_ok=True)
    for src, out, family, style, weight in JOBS:
        font = TTFont(os.path.join(SRC, src))
        font.flavor = None  # woff2 -> ttf
        postscript = (family + "-" + style).replace(" ", "")
        full = family if style == "Regular" else f"{family} {style}"

        for record in list(font["name"].names):
            if record.nameID in (1, 2, 3, 4, 6, 16, 17):
                font["name"].removeNames(record.nameID, record.platformID, record.platEncID, record.langID)
        for pid, peid, lid in ((3, 1, 0x409), (1, 0, 0)):
            font["name"].setName(family, 1, pid, peid, lid)
            font["name"].setName(style if style in CANONICAL_STYLES else "Regular", 2, pid, peid, lid)
            font["name"].setName(f"{family}:{style}:bona-social", 3, pid, peid, lid)
            font["name"].setName(full, 4, pid, peid, lid)
            font["name"].setName(postscript, 6, pid, peid, lid)
            if style not in CANONICAL_STYLES:
                font["name"].setName(family, 16, pid, peid, lid)
                font["name"].setName(style, 17, pid, peid, lid)

        os2 = font["OS/2"]
        os2.usWeightClass = weight
        # fsSelection bit 5 = BOLD, bit 6 = REGULAR; they are mutually exclusive.
        os2.fsSelection = (os2.fsSelection & ~0x21) | (0x20 if weight >= 700 else 0x40 if style == "Regular" else 0)
        font["head"].macStyle = 1 if weight >= 700 else 0

        dest = os.path.join(OUT, out)
        font.save(dest)
        print(f"wrote {dest} ({os.path.getsize(dest)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
