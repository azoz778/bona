#!/usr/bin/env python3
"""Turn a developer unit-inventory spreadsheet into src/data/units.json.

Source: Darco's own stock list "مخزون الوحدات 2-9-2026.xlsx" (owner, 2026-09-08).
Every field is copied from the sheet; nothing is estimated (TAQEEM).

Output shape (one row per available unit):
{
  "listingId": "BONA-W014",          # the project listing these units belong to
  "project": {"en": ..., "ar": ...},
  "district": {"en": ..., "ar": ...},
  "city": {"en": "Jeddah", "ar": "جدة"},
  "delivery": "2028-06",
  "currency": "SAR",
  "updated": "2026-09-02",           # the date ON the sheet, not today
  "units": [
    {"ref":"B08-19","building":"B08","unit":"19","floor":{"en":"3rd","ar":"الدور الثالث"},
     "floorIndex":3,"facing":{"en":"East","ar":"شرقية"},"beds":1,"baths":2,"maid":false,
     "class":"The Jewel","type":{"en":"Apartment","ar":"شقة"},"areaSqm":85.01,"roofSqm":0,
     "feature":{"en":"Street","ar":"شارع"},
     "price":{"cash":1069607,"half":1092871,"year":1176568,"twoYear":1230048}}
  ]
}
"""
import json, sys, datetime, unicodedata
import openpyxl

XLSX = "/home/azoz778/.hermes/cache/documents/doc_ec350c72273d_مخزون الوحدات 2-9-2026.xlsx"
OUT = "/home/azoz778/bona/src/data/units.json"
LISTING_ID = "BONA-W014"
SHEET_DATE = "2026-09-02"   # from the file name: مخزون الوحدات 2-9-2026

DISTRICT, DELIV, AREA, ROOF, FEATURE, UTYPE, FLOOR, FACE, ROOMS, BATH, MAID, CLASS, BLD, UNIT = range(14)
CASH, HALF, YEAR, TWOYR = 14, 15, 16, 17

FLOOR_MAP = {
    "الدور الارضي": ("Ground", 0),
    "الدور الأرضي": ("Ground", 0),
    "الدور الاول": ("1st", 1),
    "الدور الأول": ("1st", 1),
    "الدور الثاني": ("2nd", 2),
    "الدور الثالث": ("3rd", 3),
    "الملحق العلوي": ("Roof annex", 4),
}
FACE_MAP = {
    "شمالية": "North", "جنوبية": "South", "شرقية": "East", "غربية": "West",
    "شمالية شرقية": "North-East", "شمالية غربية": "North-West",
    "جنوبية شرقية": "South-East", "جنوبية غربية": "South-West",
}
TYPE_MAP = {"شقة": "Apartment", "شقة روف": "Roof apartment"}
FEATURE_MAP = {
    "حديقة رئيسية": "Main garden",
    "حديقة فرعية": "Secondary garden",
    "حديقة رئيسية و فرعية": "Main and secondary garden",
    "شارع": "Street",
    "شارع و حديقة رئيسية": "Street and main garden",
}
CLASS_MAP = {"Standard": "Standard", "Premium": "Premium",
             "Penthouse": "Penthouse", "(The Jewel)": "The Jewel"}


def norm(s):
    return unicodedata.normalize("NFKC", str(s)).strip() if s is not None else ""


wb = openpyxl.load_workbook(XLSX, data_only=True)
rows = list(wb["Sheet1"].values)
raw = [r for r in rows[1:] if r and r[0]]

units, unknown = [], set()
for r in raw:
    ar_floor = norm(r[FLOOR])
    en_floor, fidx = FLOOR_MAP.get(ar_floor, (None, None))
    if en_floor is None:
        unknown.add(("floor", ar_floor))
        en_floor, fidx = ar_floor, None

    ar_face = norm(r[FACE])
    en_face = FACE_MAP.get(ar_face)
    if en_face is None:
        unknown.add(("facing", ar_face)); en_face = ar_face

    ar_type = norm(r[UTYPE])
    en_type = TYPE_MAP.get(ar_type)
    if en_type is None:
        unknown.add(("type", ar_type)); en_type = ar_type

    ar_feat = norm(r[FEATURE])
    en_feat = FEATURE_MAP.get(ar_feat)
    if en_feat is None:
        unknown.add(("feature", ar_feat)); en_feat = ar_feat

    cls = CLASS_MAP.get(norm(r[CLASS]), norm(r[CLASS]))
    bld, un = norm(r[BLD]), norm(r[UNIT])

    def money(v):
        return int(round(v)) if isinstance(v, (int, float)) else None

    units.append({
        "ref": f"{bld}-{un}",
        "building": bld,
        "unit": un,
        "floor": {"en": en_floor, "ar": ar_floor},
        "floorIndex": fidx,
        "facing": {"en": en_face, "ar": ar_face},
        "beds": int(r[ROOMS]) if isinstance(r[ROOMS], (int, float)) else None,
        "baths": int(r[BATH]) if isinstance(r[BATH], (int, float)) else None,
        "maidRoom": norm(r[MAID]) == "نعم",
        "class": cls,
        "type": {"en": en_type, "ar": ar_type},
        "areaSqm": round(float(r[AREA]), 2) if isinstance(r[AREA], (int, float)) else None,
        "roofSqm": round(float(r[ROOF]), 2) if isinstance(r[ROOF], (int, float)) else 0,
        "feature": {"en": en_feat, "ar": ar_feat},
        "price": {
            "cash": money(r[CASH]),
            "half": money(r[HALF]),
            "year": money(r[YEAR]),
            "twoYear": money(r[TWOYR]),
        },
    })

deliv = next((r[DELIV] for r in raw if isinstance(r[DELIV], datetime.datetime)), None)
district_ar = norm(raw[0][DISTRICT])

doc = {
    "listingId": LISTING_ID,
    "project": {"en": "Darco Prime Waterfront", "ar": "داركو برايم الواجهة البحرية"},
    "developer": {"en": "Darco Real Estate Company", "ar": "شركة داركو العقارية"},
    "district": {"en": "Al-Shati District", "ar": f"حي {district_ar}"},
    "city": {"en": "Jeddah", "ar": "جدة"},
    "delivery": deliv.strftime("%Y-%m") if deliv else None,
    "currency": "SAR",
    "updated": SHEET_DATE,
    "source": "developer unit-inventory sheet",
    "units": units,
}

# --- self-checks: refuse to write something silently wrong -------------------
assert len(units) == len(raw), "lost rows"
refs = [u["ref"] for u in units]
dupes = {r for r in refs if refs.count(r) > 1}
assert not dupes, f"duplicate unit refs: {sorted(dupes)}"
assert all(u["price"]["cash"] for u in units), "a unit has no cash price"
if unknown:
    print("UNMAPPED VALUES (left as Arabic):")
    for k, v in sorted(unknown):
        print(f"  {k}: {v!r}")

cash = [u["price"]["cash"] for u in units]
print(f"units      : {len(units)}")
print(f"buildings  : {sorted({u['building'] for u in units})}")
print(f"cash range : {min(cash):,} – {max(cash):,} SAR")
print(f"beds       : {sorted({u['beds'] for u in units})}")
print(f"delivery   : {doc['delivery']}")

if "--commit" not in sys.argv:
    print("\nDRY RUN — nothing written. Re-run with --commit.")
    sys.exit(0)

with open(OUT, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print("\nwrote", OUT)
