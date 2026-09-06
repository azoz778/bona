# Snapchat for Bona — business, Pixel, Conversions API token

Why: Snapchat reaches ~73 % of Saudis, CPMs run 50–70 % below Meta, and the one
published KSA real-estate case (Rakez) cut CPL 38 % once the Conversions API was on.
It is Bona's second paid channel after Meta. Budget 15 minutes; sign in with
**bona.com.sa@gmail.com** (Snap accepts Google sign-in) or the @bona Snapchat account
if one exists.

## 1. Business and ad account (5 min)

1. https://ads.snapchat.com → **Log in / Sign up** → create the Snapchat account for
   the business if you have none (a Snapchat login is required even with Google
   sign-in).
2. First screen → **Business name: Bona** · Country **Saudi Arabia** · Currency
   **SAR** → Create. (Existing business? https://business.snapchat.com → **Business
   settings › Business details**.)
3. It creates an **Ad Account** in the same step; check **Ad Account name "Bona ads"**,
   time zone **Asia/Riyadh**, currency **SAR** (cannot be changed later).
4. Billing: Ads Manager ☰ → **Billing & Payments › Add payment method** (card).

## 2. Snap Pixel = the site tag (3 min)

1. Ads Manager ☰ (top-left) → **Events Manager** → **New Event Source** (or *Set up
   Snap Pixel*) → **Web** → name **Bona web** → Create.
2. The **Pixel ID** is the UUID shown on the pixel's page
   (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`). Skip the "install code" step — the site
   loads the pixel itself from `site.json` after consent.
3. Send the Pixel ID to the agent → `src/data/site.json → analytics.snapPixel`, and put
   it yourself in `~/.secrets/bona-marketing.env` as `SNAP_PIXEL_ID` (the server needs
   it to address the Conversions API).

## 3. Conversions API token (2 min)

1. https://business.snapchat.com → **Business settings › Business details** → scroll
   to **Conversions API tokens** → **Generate token** → name **bona-api** → copy (shown
   once).
2. `~/.secrets/bona-marketing.env` → `SNAP_CAPI_TOKEN=<token>`.

```bash
nano ~/.secrets/bona-marketing.env && chmod 600 ~/.secrets/bona-marketing.env
node ~/bona/scripts/marketing/verify-integrations.mjs   # snap → live = /events/validate accepted a test SIGN_UP
systemctl --user restart bona-api
```

## 4. What the stack then does

- Browser: Snap Pixel `PAGE_VIEW` on every page, `SIGN_UP` on a WhatsApp click /
  enquiry, only after the visitor allowed *advertising* cookies in the banner.
- Server (bona-api fan-out): `SIGN_UP` when a lead is created, `PURCHASE` when you mark
  a lead *won* in the dashboard — with the hashed phone, `sc_click_id` (the `ScCid` Snap
  appends to the landing URL) and `sc_cookie1`, deduplicated by `event_id`.
- Snap needs the landing page to receive `ScCid` **without a redirect** — always link
  ads straight to `https://bona.azoz.uk/…` (later `https://bona.sa/…`), never through a
  shortener.

## 5. Ads set-up notes (when you launch)

- Public Profile (Ads Manager › **Public Profiles** › Create) named **Bona** with the
  logo and the Arabic bio — organic Stories/Spotlight and Snap Map presence.
- Targeting: Jeddah (Snap Map geo around Obhur / Al Shati / Al Khalidiyah) + interests
  *luxury*, *real estate*, *investing*; later a lookalike from the WhatsApp leads
  (Custom Audience uploads take hashed phones — the dashboard exports them).
- Creative: native Hijazi Arabic, vertical video, 6–10 s, the REGA licence line in
  the caption or a QR frame (see `rega-ad-licences.md`).
- Test budget SAR 3–5k/month, two ad sets; kill any ad set with no lead after
  SAR 1,500.
- UTMs on every swipe-up URL: `?utm_source=snapchat&utm_medium=paid&utm_campaign=<name>&utm_id={{campaign.id}}`.

## 6. Access

Business settings › **Members › Invite** → `azoz778@gmail.com` → **Admin**.
