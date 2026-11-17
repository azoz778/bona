# services/intake/assets

Files `brochure_pdf.py` reads at run time, kept here so the brochure never depends on a
folder outside the repo.

## brochure.css

The brochure's stylesheet, read as data. Three sections, in this order:

1. **TK brochure CSS**, verbatim from the `tk-property-brochure` skill
   (`scripts/build_brochure.py`, its `CSS = """…"""` block). Do not edit it here.
2. **The approved Bona sample's extra components** (the units table, notes, plan box), from the
   owner-approved sample `bona-debug-w023/dirs/tk_style.py`.
3. **Bona additions**: fixed column widths (so measuring = printing), paragraph rhythm,
   captions on one line, and small fixes. Changes go here; they override sections 1 and 2.

## fonts/

The 11 files of the four font families of the TK brochure design system, copied unchanged
from the `tk-property-brochure` skill (`assets/fonts/`). All are licensed under the
**SIL Open Font License 1.1**, which allows bundling them and embedding them in documents.
Each file's `name` table carries its copyright and a short licence notice with the licence
URL; the full licence text, with every copyright line, is in [`fonts/OFL.txt`](fonts/OFL.txt).

| File | Family | Copyright |
|---|---|---|
| `CormorantGaramond-300/400/500.ttf` | Cormorant Garamond 4.001 | 2015 The Cormorant Project Authors |
| `Montserrat-300/400/500/600.ttf` | Montserrat 9.000 | 2011 The Montserrat Project Authors |
| `Amiri-Regular.ttf` | Amiri 1.002 | 2010-2022 The Amiri Project Authors |
| `Tajawal-Light/Regular/Medium.ttf` | Tajawal 1.700 | 2017 Boutros International |

The site's own `public/fonts/*.woff2` are subsets (no Latin in the Arabic faces), so they
cannot set this brochure.
