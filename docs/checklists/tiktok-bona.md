# TikTok for Bona — business account and Pixel

Why: TikTok's Saudi reach is roughly on a par with Snapchat's and its audience skews
younger and more urban than Meta's — the people who screenshot a villa and send it to a
parent who buys. It is the third paid channel after Meta and Snapchat, and it is the
cheapest of the three to *test*, because the site already carries the pixel: only the id
is missing. Budget 10 minutes; sign in with **bona.com.sa@gmail.com**.

Scope: this is the **site pixel only**. TikTok's Events API (the server-to-server half,
equivalent to Meta CAPI) is not wired yet — there is no `TIKTOK_*` key in
`~/.secrets/bona-marketing.env` and the fan-out worker has no `tiktok` destination. Do
the pixel first, see whether the channel is worth it, and only then ask for the Events
API.

## 1. Business account and ad account (5 min)

1. https://ads.tiktok.com → **Create now** / **Log in** → sign in with the Bona Google
   account.
2. Country **Saudi Arabia** · Industry **Real Estate** · Currency **SAR** · Time zone
   **Asia/Riyadh**. Currency and time zone **cannot be changed afterwards** — get them
   right in this one screen.
3. Business name **Bona**, business type **Company** (or Individual if the CR is not
   issued yet — it can be upgraded later).
4. **Billing → Payment** → add a card. Nothing spends until a campaign runs.

## 2. The Pixel = the site tag (3 min)

1. Ads Manager → **Tools** (or ☰ **Assets**) → **Events** → **Web Events** → **Set Up
   Web Events**.
2. Connection method: **TikTok Pixel** → **Manually install pixel code**. Do **not**
   pick Events API or a partner integration.
3. Name it **Bona web** → Next.
4. TikTok shows a code block. **Ignore the code** — the site loads the pixel itself.
   What is needed is the **Pixel ID** in it: the `sdkid=` value, or the string shown as
   *Pixel ID* on the pixel's page (a ~20-character alphanumeric code, e.g.
   `C4A1B2C3D4E5F6G7H8I9`).
5. Send that id to the agent. It goes in exactly one place:

   | Value | File | Field |
   |---|---|---|
   | TikTok Pixel ID (`sdkid`) | `src/data/site.json` | `analytics.tiktokPixel` |

   Nothing else changes: the tag loader already knows what to do with it, and until it
   is filled in TikTok is not requested at all.

6. Event setup mode: choose **Developer mode / manual**, and do **not** add any
   "standard events" through TikTok's own click-to-configure builder. The site already
   fires them itself: `ViewContent` on a listing, `Contact` on a WhatsApp or phone
   click, `SubmitForm` on an enquiry, `Download` on a brochure. Configuring them a
   second time in TikTok's UI double-counts.

## 3. Verify (2 min)

1. Ask the agent to deploy, then run:

   ```
   node scripts/marketing/verify-integrations.mjs
   ```

   The `tiktok-pixel` row turns **live** when the id is actually served by the live home
   page. Anything else means the deploy has not landed.

2. Install the **TikTok Pixel Helper** Chrome extension, open
   https://bona-real-estate.com, **accept the cookie banner** (nothing loads before
   that — that is the PDPL design, not a bug), and confirm the helper shows the pixel
   and a `Pageview`. Open a listing and confirm `ViewContent`.

## 4. What is deliberately not done

- **No Events API.** Server-side TikTok conversions need a `TIKTOK_ACCESS_TOKEN` and a
  destination in the fan-out worker. Ask for it once TikTok is proving itself.
- **No Advanced Matching.** The site hands TikTok no email or phone number, hashed or
  otherwise. Under PDPL that is a decision to take deliberately, with the privacy
  policy updated first — not a checkbox to tick in an ad UI.
- **Nothing loads before consent.** The pixel is injected only after the visitor accepts
  in the banner, and only when they accepted the **ads** category.
