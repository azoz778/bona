# Fonts

Six faces, the same six the website loads from `public/fonts/*.woff2`, converted to plain
`.ttf` so **fontconfig** can see them. Pango (inside sharp) reads a fontconfig font set, and
fontconfig does not read WOFF2.

| File | Family | Used for |
|---|---|---|
| `Amiri-Bold.ttf` | Amiri | Arabic display — hooks, headlines, titles |
| `IBMPlexSansArabic-Regular.ttf` | IBM Plex Sans Arabic | Arabic text — specs, eyebrows, small print |
| `IBMPlexSansArabic-Medium.ttf` | IBM Plex Sans Arabic Medium | Arabic text, emphasis |
| `CormorantGaramond-SemiBold.ttf` | Cormorant Garamond | Latin display — the BONA wordmark, English headlines |
| `Montserrat-Regular.ttf` | Montserrat | Latin text, and the fallback that supplies Western digits to Arabic runs |
| `Montserrat-SemiBold.ttf` | Montserrat SemiBold | Latin text, emphasis |

## Why the name records were rewritten

Google's static instances ship families like `Montserrat Thin SemiBold` and
`Cormorant Garamond Light SemiBold` — the weight is baked into the family name, which makes
fontconfig match them unpredictably. The conversion rewrites nameIDs 1/2/4/6/16/17 and
`OS/2.usWeightClass` back to the correct family + style, so `Montserrat SemiBold 30` in a
Pango font description resolves to the file you expect. Glyph outlines are untouched.

Neither Amiri nor IBM Plex Sans Arabic carries `U+0030..0039`; they only have Arabic-Indic
digits. That is why `lib/fonts.mjs` hands Pango a **family list** (`AR_STACK`) rather than one
family — a Western numeral inside an Arabic line falls through to Montserrat.

## Reproducing

```bash
uv run --with "fonttools[woff]" python3 scripts/social/fonts/build-fonts.py
```

Licences: Amiri, IBM Plex Sans Arabic, Cormorant Garamond and Montserrat are all SIL Open
Font License 1.1. The OFL permits modification and redistribution; renaming away from a
Reserved Font Name is what it *requires* of a modified font, and no RFN is claimed here — the
family names above are the upstream ones, restored.
