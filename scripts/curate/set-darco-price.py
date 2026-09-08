#!/usr/bin/env python3
"""Set the Darco Prime Waterfront price from the developer's unit-inventory sheet.

Source document (owner, 2026-09-08): "مخزون الوحدات 2-9-2026.xlsx" — Darco's own
unit stock list for the Al-Shati project, 111 available units.

Why this is TAQEEM-safe: the numbers are PRINTED in the developer's own inventory
sheet. Nothing here is estimated. The listing currently shows "Price on request"
only because the brochure PDF had no price in its text layer.

The listing is the whole PROJECT (BONA-W014, off-plan, 22 buildings / 534 units),
not one unit, so the published figure is the CASH starting price:
    price.amount = min(cash) , price.from = true  -> "From SAR 708,164"

Payment-plan columns are recorded in the description, not in price.amount:
the schema has ONE amount, and the cash column is the honest floor.

Dry run by default; --commit writes the inbox JSON.
"""
import json, sys, datetime
from collections import Counter
import openpyxl

XLSX = "/home/azoz778/.hermes/cache/documents/doc_ec350c72273d_مخزون الوحدات 2-9-2026.xlsx"
INBOX = "/home/azoz778/bona/scripts/curate/inbox/darco-prime-waterfront-al-shati.json"
COMMIT = "--commit" in sys.argv

# column indices
AREA, TYPE, FLOOR, ROOMS, BATH, MAID, CLASS, BLD, UNIT = 2, 5, 6, 8, 9, 10, 11, 12, 13
CASH, HALF, YEAR, TWOYR = 14, 15, 16, 17
DELIV = 1

wb = openpyxl.load_workbook(XLSX, data_only=True)
rows = list(wb["Sheet1"].values)
data = [r for r in rows[1:] if r and r[0]]

cash = [r[CASH] for r in data if isinstance(r[CASH], (int, float))]
areas = [r[AREA] for r in data if isinstance(r[AREA], (int, float))]
rooms = [r[ROOMS] for r in data if isinstance(r[ROOMS], (int, float))]
twoyr = [r[TWOYR] for r in data if isinstance(r[TWOYR], (int, float))]

n = len(data)
min_cash, max_cash = min(cash), max(cash)
min_area, max_area = min(areas), max(areas)
min_room, max_room = min(rooms), max(rooms)
buildings = sorted({r[BLD] for r in data})
delivery = {r[DELIV] for r in data if isinstance(r[DELIV], datetime.datetime)}
deliv = sorted(delivery)[0] if delivery else None
classes = Counter(r[CLASS] for r in data)

print(f"units in sheet      : {n}")
print(f"cash price          : {min_cash:,.0f} – {max_cash:,.0f} SAR")
print(f"2-year plan price   : {min(twoyr):,.0f} – {max(twoyr):,.0f} SAR")
print(f"built area          : {min_area:.2f} – {max_area:.2f} m2")
print(f"rooms               : {min_room} – {max_room}")
print(f"buildings available : {len(buildings)}  {buildings}")
print(f"delivery            : {deliv.date() if deliv else 'n/a'}")
print(f"classes             : {dict(classes)}")

listing = json.load(open(INBOX, encoding="utf-8"))
before = json.dumps(listing["price"], ensure_ascii=False)

listing["price"] = {
    "amount": int(min_cash),
    "currency": "SAR",
    "from": True,          # a project floor price, not one unit
    "period": None,
    "onRequest": False,
}

# specs: ranges belong in the copy, but the smallest unit's shape is a fair
# representation of the entry-level product and every value is from the sheet.
listing["specs"]["areaSqm"] = round(min_area, 2)
listing["specs"]["beds"] = int(min_room)
listing["specs"]["baths"] = int(min(r[BATH] for r in data if isinstance(r[BATH], (int, float))))

deliv_txt_en = deliv.strftime("%B %Y") if deliv else None
deliv_txt_ar = {6: "يونيو"}.get(deliv.month, str(deliv.month)) + " " + str(deliv.year) if deliv else None

fact_en = (
    f" Current availability from the developer's stock list dated 2 September 2026: "
    f"{n} units across {len(buildings)} buildings, built areas of {min_area:.0f}–{max_area:.0f} m² "
    f"with {min_room} to {max_room} bedrooms. Cash prices start at SAR {min_cash:,.0f}; "
    f"instalment plans over six months, one year and two years are offered by the developer. "
    f"Scheduled delivery {deliv_txt_en}."
)
fact_ar = (
    f" التوافر الحالي بحسب كشف مخزون الوحدات من المطور بتاريخ ٢ سبتمبر ٢٠٢٦: "
    f"{n} وحدة في {len(buildings)} مبانٍ، بمساحات بناء من {min_area:.0f} إلى {max_area:.0f} متر مربع "
    f"وعدد غرف من {min_room} إلى {max_room}. تبدأ أسعار الكاش من {min_cash:,.0f} ريال، "
    f"مع خطط تقسيط على ستة أشهر وسنة وسنتين من المطور. التسليم المتوقع {deliv_txt_ar}."
)

for lang, extra in (("en", fact_en), ("ar", fact_ar)):
    base = listing["description"][lang]
    marker = "stock list dated" if lang == "en" else "كشف مخزون الوحدات"
    if marker not in base:
        listing["description"][lang] = base.rstrip() + extra

print("\nprice BEFORE:", before)
print("price AFTER :", json.dumps(listing["price"], ensure_ascii=False))
print("specs       :", json.dumps(listing["specs"], ensure_ascii=False))

if not COMMIT:
    print("\nDRY RUN — nothing written. Re-run with --commit.")
    sys.exit(0)

with open(INBOX, "w", encoding="utf-8") as fh:
    json.dump(listing, fh, ensure_ascii=False, indent=2)
    fh.write("\n")
print("\nwrote", INBOX)
