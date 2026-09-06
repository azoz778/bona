# REGA advertising licences — one per listing, before any promotion

Source: `docs/research/2026-09-06-saudi-re-acquisition-research.md` §1 (official
gazette + REGA service pages; fees and validity from REGA news and agency blogs, treat
as indicative). This page is what you do; the site, the export and the dashboard
already carry the data model.

## 1. The rule (since 1 May 2026)

- **Regulatory Bylaw on Real Estate Marketing & Advertising**
  (اللائحة التنظيمية للتسويق والإعلانات العقارية), 12 articles, dated 14/11/1447 =
  **1 May 2026**, issued under the Real Estate Brokerage Law (Royal Decree M/130).
  Gazette: https://www.uqn.gov.sa/decisions-and-regulations/authorities/4000857 ·
  REGA: https://rega.gov.sa/ (الأنظمة واللوائح › اللوائح › اللائحة التنظيمية للتسويق والإعلانات العقارية).
- **Scope (Art. 3): every channel** — Instagram, Snapchat, TikTok, X, YouTube,
  WhatsApp/Telegram groups, websites and portals, brochures, billboards, exhibitions.
  A "Story" of a villa is an advert.
- **One licence per advertisement** (ترخيص إعلان عقاري), issued electronically on the
  **FAL platform (منصة فال)**. An *individual* FAL holder can issue them — no CR needed.
  Service page: https://rega.gov.sa/en/rega-services/eservices/real-estate-advertisement-license-issuance-service/
  (my.gov.sa service 20735).
- **Mandatory content on every advert (Art. 5)** — the site's listing page renders
  all of it in the REGA block, the branded brochure prints it in the footer, and the
  Aqar export includes it:
  1. the right advertised (sale / rent) · 2. description and condition · 3. location ·
  4. services, encumbrances, disputes · 5. **contact data identical to the licence
  application** · 6. **advertiser name and capacity** · 7. **ad-licence number** ·
  8. **licence expiry date and the FAL number**. A **QR code** may replace the detailed
  text (the site renders one per listing; use it on Snaps, Reels covers and boards).
- **Prohibited (Art. 7):** fake or bait listings, contact details that do not match the
  licensed advertiser, government logos, photos or text that contradict reality,
  disparaging others.
- **Penalties:** up to **SAR 200,000** per violation for advertising without a licence
  or unlicensed brokerage (platforms up to SAR 1 M); graduated correction → warning →
  fine → suspension ≤ 1 year → revocation; fines can double on repeat within 3 years.
  Hotline **199011**; REGA monitors social media electronically.

## 2. Advertiser until Bona has its own CR

The advert must name the **licensed person**, and the contact data must match the
licence. So today every Bona advert carries:

> **المُعلن: عبدالعزيز زيدان — رخصة فال 1100313556** · Advertiser: Abdulaziz Zidan —
> FAL 1100313556 · WhatsApp +966 59 329 6933

"Bona" stays the brand on the site and the socials; the advertiser line is the person.
`site.json → advertiser` holds this and every surface reads it from there.

## 3. Issue a licence — per listing, on the FAL platform (~10 min each)

**Prerequisites** (once per property, all inside FAL):
- your FAL licence active (1100313556, expires 22/08/2027);
- a **brokerage contract with marketing scope** (عقد وساطة يتضمن نطاق التسويق)
  registered on FAL and **approved by the owner**: you enter the owner's mobile, the
  owner approves through **Nafath / Absher OTP** — ask the owner to have the Nafath app
  ready before you start;
- the property's **electronic deed number** (رقم الصك).

**The 12 steps (منصة فال › تراخيص الإعلانات):**

1. Log in to the FAL platform with **Nafath**.
2. Menu → **تراخيص الإعلانات العقارية** (Advertisement Licences).
3. **إصدار ترخيص جديد** (New licence).
4. Pick the **brokerage contract** (عقد الوساطة) for this property.
5. Pick the **deed** (الصك) from the contract.
6. Purpose: **بيع** (sale) or **إيجار** (rent).
7. **Advertising channels** (قنوات الإعلان): tick *موقع إلكتروني*, *منصات التواصل*
   (Instagram, Snapchat, …), *منصات عقارية* (Aqar), *مطبوعات* (brochure) — tick every
   channel you might use; a channel not ticked is not covered.
8. **Price** as it will be advertised (the asking price on the site; for "price on
   request" enter the owner's asking price — it is on the licence, not necessarily on
   the advert).
9. Responsible employee: yourself.
10. Review.
11. Acknowledge the declarations (الإقرار).
12. **Save / pay** → the licence number and expiry appear; download the PDF and keep it
    with the contract.

**Fee:** about **SAR 50 per licence**; establishments can buy discounted **packages**
(https://rega.gov.sa/en/rega-services/eservices/purchase-of-advertising-license-packages/).
**Validity:** tied to the brokerage contract's period (earlier REGA guidance: one year,
extendable up to five). **The advert must come down when the licence expires.** Anyone
can verify a licence by number, contract or deed on REGA's inquiry service.

## 4. Record the number — the WhatsApp group command

In the intake WhatsApp group (the "PDF"/"Bona" group), reply:

```
licence BONA-W003 7200123456 2027-05-01      # ad-licence number, expiry YYYY-MM-DD
wafi BONA-W003 1234                          # Wafi project licence (off-plan) — see §5
```

The daemon writes `licence: { adNumber, adExpiry }` / `wafiNumber` into the listing,
commits, and the site republishes within ~3 minutes: the listing page shows
"Advertising licence 7200123456 · valid until 2027-05-01" (AR:
"رخصة الإعلان العقاري: 7200123456 — سارية حتى 2027-05-01") under the enquiry block, the
QR is regenerated, and `node scripts/portal-export.mjs` picks it up for Aqar.
(These two commands are being added to the intake in the last step of the tracking
work; until they land, send the numbers to the agent and it edits
`scripts/curate/licences.json` / the inbox JSON by hand.) For curated (TK-synced)
listings the agent records the number in `scripts/curate/licences.json` keyed by id.

## 5. Off-plan projects — Wafi instead of a per-ad licence

- Units of a **Wafi-licensed project** (NHC, Bin Saedan, Kian, …) are **exempt** from
  the per-ad licence, but every advert must cite the **project's Wafi licence number**
  (and the escrow account number where the developer states it). Record it with
  `wafi <id> <number>`; the page then shows "Wafi project licence <no>".
- You may market a developer's units only with the developer's **written marketing
  authorisation**; marketing an off-plan project that has no Wafi licence is the
  developer's SAR 10 M offence and your exposure. Ask each developer for: Wafi licence
  number, escrow account, marketing contract.
- To market **SME developers' off-plan** at scale you must be on **Wafi's broker
  registry** (CR required, qualifying programme) — not available until Bona has a CR.

## 6. What the dashboard flags

`https://bona-api.azoz.uk/dashboard/listings` (and the Aqar export's `--list`) mark:

| Flag | Meaning | Fix |
|---|---|---|
| `no_ad_licence` | sale/rent listing with no `adNumber` | §3 then `licence …` |
| `expiring_30d` | `adExpiry` within 30 days | renew on FAL, `licence …` with the new date |
| `expired` | `adExpiry` passed | take the advert down everywhere today, renew |
| `wafi_missing` | `category: off-plan` with no `wafiNumber` | get the number from the developer, `wafi …` |

Until a listing is clean it stays on the site with the advertiser + FAL block only (the
site itself is your own portfolio page), but it must **not** be pushed as an advert:
no Aqar, no paid ad, no Story naming it, no brochure sent to strangers.

## 7. Advertising as "Bona" — the path

1. **Reserve the trade name "Bona"** — Saudi Business Center
   https://business.sa (خدمة حجز اسم تجاري): English/Latin names allowed since the Trade
   Names Law of 3 Apr 2025; the reservation holds 60 days.
2. **Sole-establishment CR** with activity **682010** (real-estate brokerage) — Ministry
   of Commerce https://mc.gov.sa (≈ SAR 200/yr + chamber ≈ SAR 800/yr; annual CR
   confirmation now required).
3. **Establishment FAL licence** — REGA (https://rega.gov.sa/en/rega-services/platforms/fal-real-estate-brokerage/):
   the CR, a responsible licensed person (you), an office / national address, chamber
   membership; ≈ SAR 1,000/yr.
4. Then: `site.json → advertiser` becomes Bona + the establishment FAL, `licences.cr`
   gets the CR number, the brochures re-render, and the same CR unlocks Ejar,
   bona.com.sa, Meta Business Verification, Google Ads organisation verification, a
   business bank account and the Wafi broker registry.
