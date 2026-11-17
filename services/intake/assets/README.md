# services/intake/assets

Files `brochure_pdf.py` reads at run time, kept here so the brochure never depends on a
folder outside the repo.

## fonts/

The four faces of the TK brochure design system, copied unchanged from the
`tk-property-brochure` skill (`assets/fonts/`). All are licensed under the
**SIL Open Font License 1.1** (https://openfontlicense.org), which allows bundling and
embedding them in documents; the licence text is inside each file's `name` table.

| File | Family | Copyright |
|---|---|---|
| `CormorantGaramond-300/400/500.ttf` | Cormorant Garamond 4.001 | 2015 The Cormorant Project Authors |
| `Montserrat-300/400/500/600.ttf` | Montserrat 9.000 | 2011 The Montserrat Project Authors |
| `Amiri-Regular.ttf` | Amiri 1.002 | 2010-2022 The Amiri Project Authors |
| `Tajawal-Light/Regular/Medium.ttf` | Tajawal 1.700 | 2017 Boutros International |

The site's own `public/fonts/*.woff2` are subsets (no Latin in the Arabic faces), so they
cannot set this brochure.
