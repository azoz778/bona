# Meta for Bona — Business Portfolio, Page, Pixel/CAPI, ad account, bot token

Owner-only work: Meta will not let the agent create a Page, a portfolio or a token
inside your Facebook session. Budget ~40 minutes in one sitting; every value you copy
goes into exactly one place (table at the end). When done, the agent verifies
everything with `node scripts/marketing/verify-integrations.mjs`.

## Account facts before you start

- Your personal Facebook is **"Abdulaziz Zaidan"**. It already owns two Business
  Portfolios: **"abdulaziz Zaidan"** (1 Page, 2 people) and **"mountainbikeksa"**.
- TK's portfolio **"TKEstate" must NOT be used** for anything Bona — Bona keeps its own
  assets, its own ad account, its own Pixel, so TK's CAC and audiences are never mixed
  with Bona's and the TK token never publishes for Bona.
- Instagram **@bona.com.sa** is already a **Business** account (category Real Estate
  Agent). Its Instagram Business ID is **17841427688957180**. It is linked to no Page
  yet — that link is step 3.
- Sign in from the Bona Chrome profile if you like (`C:\Users\ASUS\AppData\Local\cc-chrome-bona`,
  Instagram already logged in there) — or any browser where you are logged into Facebook.

## 1. Create the Business Portfolio "Bona" (3 min)

1. Open https://business.facebook.com/overview → top-left portfolio picker →
   **Create a business portfolio** (label may read *Create a business account*).
2. Business name **Bona** · Your name **Abdulaziz Zidan** · Business email
   **bona.com.sa@gmail.com** → **Submit**. Confirm the email when Meta asks.
3. You land in **Business settings** (https://business.facebook.com/settings). Keep this
   tab open; every later step starts here.

## 2. Create the Facebook Page "Bona Real Estate" (5 min)

1. https://www.facebook.com/pages/create → Page name **Bona Real Estate** → Category
   type *Real Estate* and pick **Real Estate Agent** → Bio: the EN bio from
   `marketing/instagram-profile.md` → **Create Page**.
2. Contact block: Phone **+966 59 329 6933**, Email **bona.com.sa@gmail.com**,
   Website **https://bona.azoz.uk**, Location *Jeddah, Saudi Arabia* (tick "no street
   address" — the office is not customer-facing yet), Hours Sun–Thu 10:00–19:00.
3. Profile picture `public/icon-512.png`; cover `public/og-default.png`.
4. **Action button** (below the cover) → **WhatsApp** → enter **+966 59 329 6933** →
   confirm the code WhatsApp sends → Save.
5. Attach the Page to the portfolio: Business settings → **Accounts › Pages › Add ›
   Add a Page** → pick *Bona Real Estate* (if the create-page dialog already asked
   which portfolio, choose *Bona* there and skip this).

## 3. Link Instagram @bona.com.sa to the Page (3 min)

1. Page → **Settings → Linked accounts → Instagram → Connect account** → log in as
   @bona.com.sa → allow *Access Instagram messages in Inbox* (optional) → Confirm.
   Alternative path: Accounts Center (https://accountscenter.instagram.com/accounts/)
   → **Accounts › Add accounts** → Facebook → the Page's profile.
2. Business settings → **Accounts › Instagram accounts › Add** → *Connect your
   Instagram account* → log in as @bona.com.sa → it now appears under the Bona portfolio.
   If Meta says the account is already linked to another Page, unlink it there first
   (Page settings › Linked accounts › Disconnect).

## 4. Events Manager: dataset "Bona web" = the Pixel (5 min)

1. https://business.facebook.com/events_manager2 → make sure the portfolio picker says
   **Bona** → **Connect data sources** (green + ) → **Web** → **Connect**.
2. Name **Bona web** → **Create**.
3. "How do you want to connect?" → choose **Meta Pixel and Conversions API** (not
   "partner integration") → **Install code manually** → **Skip** — the site loads the
   pixel itself from `site.json`; nothing to paste into the site.
4. Open the dataset → **Settings** tab → copy the **Dataset ID** (15–16 digits; older
   screens call it *Pixel ID*). This is `META_PIXEL_ID` **and** `site.json.analytics.metaPixel`.

## 5. Conversions API access token (2 min)

Same dataset → **Settings** → scroll to **Conversions API** → **Set up manually** →
**Generate access token** (Meta creates a system user for the dataset behind the scenes)
→ copy the token (`EAA…`, shown once). This is `META_CAPI_TOKEN`.

## 6. Test-events code (1 min)

Dataset → **Test events** tab → the code in the box (looks like `TEST12345`). This is
`META_TEST_EVENT_CODE`. While it is set, server events show up live on that tab and are
kept **out of reporting**; empty the key once you see "Received" and the events are
correct.

## 7. Ad account in SAR (5 min)

1. Business settings → **Accounts › Ad accounts › Add › Create a new ad account**.
2. Name **Bona ads** · Time zone **(GMT+03:00) Riyadh** · Currency **SAR — Saudi Riyal**
   → *This ad account will be used for* → **My business** → Next → add yourself with
   **Full control** → Create.
3. Copy the ad account id (the number after `act_` in the URL, or the *Ad account ID*
   on the account's page). This is `META_AD_ACCOUNT_ID`.
4. Payment: **Business settings › Billing and payments › Payment methods › Add** →
   mada / credit card. Without a payment method the account cannot publish ads and
   Meta shows "no payment method" on every campaign.
5. Currency and time zone cannot be changed later — check SAR / Riyadh before Create.

## 8. Meta app (needed for a system-user token) (4 min)

1. https://developers.facebook.com/apps → **Create app** → use case *Other* → type
   **Business** → App name **Bona Publisher** → Business portfolio **Bona** → Create.
2. In the app dashboard → **Add product** → **Marketing API** → Set up; then
   **Instagram** (Instagram Graph API) → Set up. Leave the app in *Development* mode:
   a system user of the same portfolio can use it without App Review.

## 9. System user "bona-bot" + one token for everything (5 min)

1. Business settings → **Users › System users › Add** → Name **bona-bot** → Role
   **Admin** → Create system user.
2. **Assign assets** (Add assets): Pages → *Bona Real Estate* (Full control) ·
   Instagram accounts → *@bona.com.sa* (Full control) · Datasets → *Bona web* (Full
   control) · Ad accounts → *Bona ads* (Full control) → Save changes.
3. **Generate new token** → App **Bona Publisher** → Token expiration **Never** →
   tick exactly these permissions:
   `ads_management` · `ads_read` · `business_management` · `pages_show_list` ·
   `pages_read_engagement` · `instagram_basic` · `instagram_content_publish` ·
   `leads_retrieval` → **Generate token** → copy (shown once). This is `META_ACCESS_TOKEN`.
4. Page ID: Business settings → Accounts › Pages → click *Bona Real Estate* → the
   numeric **Page ID** under the name. This is `META_PAGE_ID`.

## 10. Verify the domain(s) (3 min, one line for the agent)

1. Business settings → **Brand safety and suitability › Domains › Add** → type
   **bona.azoz.uk** → Add.
2. Verification method **Meta-tag verification** → you see
   `<meta name="facebook-domain-verification" content="abc123…" />` → **copy only the
   `content` value** and send it to the agent ("Meta domain tag: abc123…"). The agent
   puts it in the site's head and deploys (~3 min).
3. Back on the same screen → **Verify**. Green tick = done. Repeat for **bona.sa** after
   the domain cutover (`docs/OWNER-RUNBOOK.md` §11).

## 11. Where each value goes

| Value | Copy from | Goes to |
|---|---|---|
| Dataset ID (Pixel ID) | step 4 | `META_PIXEL_ID` in `~/.secrets/bona-marketing.env` **and** `src/data/site.json → analytics.metaPixel` (agent) |
| CAPI access token | step 5 | `META_CAPI_TOKEN` in `~/.secrets/bona-marketing.env` |
| Test events code | step 6 | `META_TEST_EVENT_CODE` in `~/.secrets/bona-marketing.env` (empty it once live) |
| System-user token | step 9 | `META_ACCESS_TOKEN` in `~/.secrets/bona-meta-graph.env` |
| Page ID | step 9 | `META_PAGE_ID` in `~/.secrets/bona-meta-graph.env` |
| Instagram Business ID | known: `17841427688957180` | `IG_BUSINESS_ID` in `~/.secrets/bona-meta-graph.env` |
| Ad account ID | step 7 | `META_AD_ACCOUNT_ID` in `~/.secrets/bona-meta-graph.env` |
| Domain-verification tag | step 10 | send to the agent → site head |

Writing the secrets files (both mode 0600, never committed; the agent must not see the
values, so type them yourself):

```bash
nano ~/.secrets/bona-marketing.env      # META_PIXEL_ID=  META_CAPI_TOKEN=  META_TEST_EVENT_CODE=
nano ~/.secrets/bona-meta-graph.env     # META_ACCESS_TOKEN=  META_PAGE_ID=  IG_BUSINESS_ID=17841427688957180  META_AD_ACCOUNT_ID=
chmod 600 ~/.secrets/bona-marketing.env ~/.secrets/bona-meta-graph.env
```

## 12. Check it works

```bash
cd ~/bona
node scripts/marketing/verify-integrations.mjs      # meta-capi → live, meta-pixel → live once site.json carries the id
set -a; source ~/.secrets/bona-meta-graph.env; set +a
node scripts/instagram-post.mjs whoami                # prints the IG account the token can publish to
```

Then `systemctl --user restart bona-api` so the fan-out picks up the keys (the agent can
do the site.json edit and the deploy; the restart is one command for you).

## Later (needs the CR)

- **Business verification** (Business settings › Security centre › Start verification):
  upload the CR extract; legal name must match. Unlocks WhatsApp Business Platform,
  Meta Verified, higher ad limits.
- **Click-to-WhatsApp ads** need a WhatsApp *Business* account on the number — today
  every ad lands on the website and the site's Ref code carries the attribution.
- **Lead Ads** (instant forms) must link https://bona.azoz.uk/privacy/ as the privacy
  policy; `leads_retrieval` on the token is already there for the pull.
