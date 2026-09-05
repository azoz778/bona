# Instagram → Meta Graph API connection checklist (owner steps)

Goal: let `scripts/instagram-post.mjs` publish to **@bona.com.sa** unattended. Everything below is
account-owner work (Meta will not let an agent do it). Budget: ~10 minutes.

## 1. Convert @bona.com.sa to a Business account
1. Instagram app → profile → **☰ → Settings and privacy → Account type and tools → Switch to professional account**.
2. Choose **Business** (not Creator — Creator accounts cannot use the content-publishing API for carousels in some regions).
3. Category: **Real Estate** (search "Real Estate" → choose *Real Estate Agent* if offered).
4. Contact options: WhatsApp button → +966 59 329 6933 (this also enables the "Message on WhatsApp" CTA on the profile).

## 2. Create / link the Facebook Page "Bona"
The API only works through a Facebook Page.
1. facebook.com/pages/create → Name **Bona**, Category **Real Estate Agent**, Bio = the EN bio from `instagram-profile.md`.
2. Add the logo (`public/icon-512.png`) as profile picture and `public/og-default.png` as cover (crop to 820×312 if asked).
3. Page → **Settings → Linked accounts → Instagram → Connect account** → log in as @bona.com.sa → allow "Access Instagram messages" (optional) → done.
   - If the Page settings say the IG account is linked to another Page, unlink it there first.

## 3. Add both to TK's Meta Business Portfolio
1. business.facebook.com → the existing **TK Estate** portfolio → **Settings → Accounts → Pages → Add → Add a Page you own** → Bona.
2. **Accounts → Instagram accounts → Add** → log in as @bona.com.sa (this associates it with the portfolio).
3. **Users → System users** → pick the existing system user used for TK's automations (or create `bona-poster`, role *Employee*).
   - **Add assets**: Page Bona (Full control) + Instagram account @bona.com.sa (Full control).
   - **Generate new token** → app: the TK app already in the portfolio (any app with *Instagram Graph API* product) → token expiry **Never** → permissions:
     `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `business_management`.
   - Copy the token once; it is shown only once.
4. Store it: `~/.config/bona/meta.env` → `META_ACCESS_TOKEN=EAAG…` (chmod 600). Never commit it.

## 4. Find the Instagram Business ID (agent can do this once the token exists)
```bash
# list pages the token can see
curl -s "https://graph.facebook.com/v21.0/me/accounts?fields=id,name&access_token=$META_ACCESS_TOKEN"
# then, with the Bona PAGE_ID from above:
curl -s "https://graph.facebook.com/v21.0/<PAGE_ID>?fields=instagram_business_account{id,username}&access_token=$META_ACCESS_TOKEN"
# → {"instagram_business_account":{"id":"1784…","username":"bona.com.sa"},"id":"<PAGE_ID>"}
```
Put the id in `~/.config/bona/meta.env` as `IG_BUSINESS_ID=1784…`, then verify:
```bash
set -a; source ~/.config/bona/meta.env; set +a
node scripts/instagram-post.mjs whoami
node scripts/instagram-post.mjs list-media --limit 5
```
For GitHub Actions: repo **Settings → Secrets → Actions** → `META_ACCESS_TOKEN`, `IG_BUSINESS_ID`.

## 5. Meta App review (only if the app is still in Development mode)
- Development-mode apps can publish only for users with a role on the app. Adding the system user's assets is enough for automation — no App Review required as long as the Page/IG account belong to the same portfolio as the app.
- If posting returns `code 10 / 200`, the app is missing the *Instagram Graph API* product or the IG account is not linked to the Page (step 2).

## 6. Profile polish (5 min, same session)
- Bio: pick one from `instagram-profile.md` (≤150 chars), link = https://bona.azoz.uk (→ bona.com.sa later).
- Action button: **WhatsApp** → +966 59 329 6933.
- Highlights: create the 5 covers named in `instagram-profile.md` (upload a plain ivory square with the champagne rule as cover — `public/icon-512.png` works as a placeholder).
- Turn on **Show category label** and **Show contact info**.

## 7. DM auto-reply (Instagram → Settings → Business tools → Saved replies / Meta Business Suite → Inbox → Automations → Instant reply)
**EN**
> Thank you for contacting Bona. We reply personally within office hours (Sun–Thu, 10:00–19:00 KSA). For a faster answer about a specific home, WhatsApp us on +966 59 329 6933 with the property reference — or tell us what you're looking for here.

**AR**
> شكراً لتواصلك مع بونا. نرد عليك شخصياً خلال ساعات العمل (الأحد–الخميس، 10:00–19:00). للرد الأسرع بخصوص عقار معيّن، راسلنا على واتساب +966 59 329 6933 مع رقم العقار — أو أخبرنا هنا عمّا تبحث عنه.

Away message (outside hours):
> Bona — we're away right now and will reply when the office opens (Sun–Thu 10:00). Urgent? WhatsApp +966 59 329 6933. / بونا — سنرد عند فتح المكتب (الأحد–الخميس 10:00). للطوارئ: واتساب +966 59 329 6933.

## 8. Link-in-bio
Keep it a single URL (the site) — no Linktree. The site home page is the hub; the properties page has category filters. When bona.com.sa is live, change the bio link before changing anything else so old posts keep resolving.

## 9. Ready-to-run test (after 1–4)
```bash
node scripts/instagram-post.mjs post-image \
  --image-url "https://tk-storage.azoz.uk/tk-estate-media/media/<folder>/<file>.jpg" \
  --caption-file marketing/captions/launch-01.txt --dry-run   # drop --dry-run to publish
```
Image URLs must be public **JPEG** (Instagram rejects PNG/WebP), ≤ 8 MB, aspect ratio between 4:5 and 1.91:1.
