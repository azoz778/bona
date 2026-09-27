# TikTok connections for Bona

Reviewed 2026-09-28. The owner chose to repurpose the existing personal TikTok
account as Bona; preserve its login email, phone and password. Profile configuration
is owned by the coordinator's browser session. Coordinator reload-verified `@bonarealestatesa`, Bona Real Estate display name and
bilingual bio. Coordinator also confirmed the official B logo on the TikTok OAuth consent screen.
TikTok For Business linking has reached its permission/terms consent screen.
The owner has authorized this consent; the browser executor is completing linking.
Business tier/API access and actual grants remain unverified.
Do not create a replacement account or use the abandoned info@ signup.

## What is ready, and what is still pending

| Connection | Evidence / status | Required next step |
|---|---|---|
| Existing account/profile | Coordinator confirmed handle/name/bio and unchanged login | Complete owner-approved Business linking and verify API access |
| Browser Pixel | Consent-gated loader and event IDs already exist; live Pixel ID is null | Obtain Bona web Pixel ID, configure and deploy |
| Server Events API | Implemented in this branch; no local/VPS token or Pixel ID configured | Configure real credentials, deploy API, verify Test Events |
| Business Center | Linking authorized; access and asset assignment not verified | Owner/admin links existing account and assigns least necessary access |
| Organic publishing/insights | No approved app, account grant or valid token verified | Establish approved API for Business Accounts API access or connect an approved provider |
| Content Posting/Login Kit OAuth | No client credentials or grant found | Only implement after choosing a permitted product/use case |
| Unattended operation | Not connected; no TikTok job installed | Verify permissions, delivery, renewal/revocation handling, and content approval first |

No changes here enable Instagram/Facebook publishing timers. No ad campaigns,
billing details, test posts or paid subscriptions are needed for this code review.

## Pixel and server Events API setup

1. In the owner's TikTok for Business workspace, verify access to the correct
   advertiser/data source. A Business Center administrator must authorize relevant
   people/assets; a TikTok profile rename alone supplies no API credentials.
   Use real business information in any verification flow. Record the account,
   Business Center and advertiser identifiers privately; never invent CR details.
2. In Ads Manager's Events Manager, select or create the website data source
   **Bona web** and choose manual Pixel + direct Events API setup. Do not add
   a duplicate click/event-builder rule for events the site already emits.
3. **Before enabling TikTok tracking, update and review the bilingual privacy notice.**
   The bilingual `src/data/privacy.json` now describes the actual forms, storage,
   first-party records and active/pending providers. Review it against the final
   enabled data flows before activation; no unverified deletion or residency promise
   is made. Confirm the business retention schedule and provider arrangements separately.
   Set the public Pixel ID in `src/data/site.json` → `analytics.tiktokPixel`.
   On the API service host only, set these in `~/.secrets/bona-marketing.env`
   with directory mode 0700 and file mode 0600:

   ```dotenv
   TIKTOK_PIXEL_ID=
   TIKTOK_EVENTS_ACCESS_TOKEN=
   TIKTOK_TEST_EVENT_CODE=
   ```

   The two Pixel IDs must match. Generate the Events API token through the data
   source's setup/settings using authorized access. This is separate from a TikTok
   for Developers `video.publish` or Login Kit token. Never paste tokens in chat,
   commit them, or store them in the site's JSON. Do not copy an entire local
   secret file over production merely to add these three keys.
4. Deploy the reviewed website and API changes, restarting only the API service.
   Do not run the broad publisher/install scripts or enable publishing timers.
5. Verify ads consent denied sends nothing. With a dedicated consented test session
   and the Events Manager test code, check one Contact/SubmitForm pair using identical
   `event` and `event_id` in browser and server. Inspect Test Events and Diagnostics
   for source, matching, and deduplication. The worker requires HTTP success **and**
   JSON `code: 0`; this proves API acceptance, not reporting accuracy. This task did
   not submit any live test events.
6. Remove the test code once verified. Check the dashboard's TikTok destination,
   last accepted event, failed rows and queue counts. Missing credentials skip new
   rows; previously skipped history is never replayed automatically.

Implementation: `services/api/lib/tiktok.mjs` uses Events API 2.0 at
`/open_api/v1.3/event/track/`. Website WhatsApp clicks map to Contact, forms to
SubmitForm. CRM lead_created fallbacks and pipeline stages are not sent to TikTok; only validated
   browser form events retain the deduplication ID. The
existing browser loader still handles ViewContent, Contact, SubmitForm and Download.
No server PageView, phone/name/email hashing or automatic advanced matching is added.
The server uses consented IP/user agent and existing `_ttp`/`ttclid`; query strings,
fragments and form text are omitted. TikTok requires ads consent recorded on the event AND current session, even if the
legacy fan-out consent override is disabled for other destinations.

Transient HTTP/network failures retry using the existing bounded queue/backoff;
API-envelope throttling (40100) and system errors (50000) use the same bounded
retry policy. Other HTTP-200 API errors fail visibly instead of being counted as sent. API response
messages are not persisted, preventing an echoed credential or personal field
from entering diagnostics. Investigate failed API codes before any manual replay.

`node scripts/marketing/verify-integrations.mjs --dry-run` checks readiness without
network calls. Normal execution also probes other vendors and may send a GA4 ping;
do not use it as a supposedly read-only TikTok check. The TikTok Events check itself
only examines configuration and cannot label token presence as a live connection.

## Organic posting, insights and account access

The [API for Business Accounts API overview](https://business-api.tiktok.com/portal/docs/accounts-api-overview/v1.3)
describes insights, comment management and publishing for Business and Personal
accounts. This is a separate access route from TikTok for Developers Content Posting.
For Bona, first verify developer-app approval, the account's authorization, available
permissions, regional eligibility, and the exact supported publishing/insight scopes
inside the authorized portal. These are currently unknown. Business Center ad-delivery
permission is not proof of organic publishing authorization. If direct access is
unavailable, use a platform-approved provider with an owner-completed connection.
No paid provider has been selected or purchased.

For TikTok for Developers, `user.info.basic` is basic identity, `video.list` is an
additional read grant, `video.upload` uploads a draft for creator completion, and
`video.publish` enables Direct Post only with the required access/review. A Business
switch does not grant any of them. Its [Direct Post guidelines](https://developers.tiktok.com/docs/en/content-sharing-guidelines)
exclude private/internal account-upload utilities; unaudited access cannot provide
public automated posts. Do not disguise Bona's use case to pass review. A compliant
public-facing app also needs the required creator preview, settings and consent flow.

No refresh daemon is installed: there is no approved credential/grant to refresh.
If a permitted TikTok for Developers OAuth integration is selected, implement a
registered HTTPS callback with expiring, single-use state, exchange server-side,
and store tokens outside Git under restricted service-user access. Refresh before
expiry, serialize refresh attempts, atomically persist the returned refresh token
(which may rotate) and both expiry timestamps, and stop with an owner action on
revocation/expired refresh grant. The documented user access token lasts 24 hours
and the initial refresh token 365 days; honor returned expiry fields. These lifetimes
must not be assumed for Events API or API for Business tokens. Verify their actual
issuer-specific lifecycle before scheduling any refresh job.

## Official references

- [Events API setup and authentication](https://ads.tiktok.com/resources/help/article/getting-started-events-api?lang=en)
- [Events API 2.0 endpoint reference](https://business-api.tiktok.com/portal/docs/report-app-web-offline-or-crm-events/v1.3)
- [Pixel/Events API deduplication](https://ads.tiktok.com/help/article/event-deduplication?lang=en)
- [Business Center account access](https://ads.tiktok.com/resources/help/article/manage-tiktok-accounts-business-center?redirected=2)
- [Direct Post prerequisites](https://developers.tiktok.com/docs/en/content-posting-api-get-started)
- [OAuth expiry, rotation and revocation](https://developers.tiktok.com/docs/en/oauth-user-access-token-management)

The account owner's consent and platform approval are external prerequisites;
code and mock tests alone establish neither. No TikTok delivery has been verified.
