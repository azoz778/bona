# Instagram @bona.com.sa — access brief for the owner (2026-09-05)

**Where we are.** TK's Meta system-user token (`~/.secrets/tk-meta-graph.env`, system user **tkcrmbot**) can see exactly one Facebook Page — **Tk Estate** (621957690990819), whose Instagram is **@tkestate.sa**. It cannot see @bona.com.sa at all. A `business_discovery` lookup of `bona.com.sa` with that token is being tested by the coordinator; expect it to answer "not a business account", which confirms the account is still Personal (or Creator). Until one of the two paths below is done, no post can be published to @bona.com.sa by any script.

**Pick one path.** Path A is recommended: it needs no password, takes about ten minutes, and gives the agent durable API access. Path B is only for when you would rather hand over the login than click through Meta yourself.

---

## PATH A — you do it in the app, no password shared (recommended)

**A1. Make the account a Business account (2 min)**
Instagram app, logged in as @bona.com.sa → profile → ☰ → **Settings and privacy** → **Account type and tools** → **Switch to professional account** → choose **Business** (not Creator) → category **Real Estate Agent** (or *Real Estate*) → add contact: WhatsApp +966 59 329 6933 → finish.

**A2. Then choose ONE of the two ways to connect it:**

**(i) Same Meta Business as Tk Estate — fastest; the existing token starts working**
1. On the last screen of A1 (or Settings → Business tools → **Connect a Facebook Page**) → **Create a new Facebook Page** named **Bona**, category *Real Estate Agent*. Link it to @bona.com.sa when asked.
2. Open business.facebook.com → select the business portfolio that owns **Tk Estate** → **Settings**:
   - **Accounts → Pages → Add → Add a Page you own** → *Bona*.
   - **Accounts → Instagram accounts → Add** → log in as @bona.com.sa.
   - **Users → System users → tkcrmbot → Add assets** → Page *Bona* (Full control) **and** Instagram *bona.com.sa* (Full control) → Save.
3. Tell the coordinator "A-i done". Nothing else is needed: the existing token in `~/.secrets/tk-meta-graph.env` now sees the Bona Page and its IG account, and posting via `scripts/instagram-post.mjs` works immediately.

**(ii) Separate Meta Business for Bona — cleaner long-term, one extra token**
1. Do step 1 of (i) (create + link the *Bona* Page).
2. business.facebook.com → **Create a business portfolio** named *Bona* → add the *Bona* Page and the @bona.com.sa Instagram account to it (Settings → Accounts).
3. **Settings → Apps → Add** → the TK app (any app in your name with the *Instagram Graph API* product), or create a new app of type *Business*.
4. **Users → System users → Add** → name `bona-poster`, role *Admin* → **Add assets**: *Bona* Page + *bona.com.sa* IG (Full control) → **Generate new token** → app from step 3 → expiry **Never** → permissions:
   `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, `business_management`.
5. The token is shown once. Paste it as `META_ACCESS_TOKEN=…` into `~/.secrets/bona-meta-graph.env` (chmod 600) and tell the coordinator; the IG business ID is read automatically from the Page.

---

## PATH B — you give the agent the password (fallback)

**What the agent will do with it**
- Log in from **your own Chrome profile on this PC** (not a fresh browser), so Instagram sees a known device and a Saudi IP. Nothing is stored outside that profile.
- Instagram will almost certainly send a **login code by SMS or email**. You must forward it to the coordinator **within a few minutes**; codes expire fast.
- The agent then performs Path A itself: switches the account to Business, creates and links the *Bona* Page, adds both to the Meta Business, grants the system user, and saves the token. After that the password is not used again.
- Posting through the web UI *is* possible but slower and riskier for the account (Instagram flags scripted browser sessions more readily than API calls). It will only be used as a fallback if the API path is blocked.

**Exactly what to send (once, over WhatsApp or in person — not by email)**
1. Username: `bona.com.sa`
2. Password
3. Which **phone number or email** receives the login code
4. Is **two-factor authentication** on? If yes: app-based (which app) or SMS
5. A **time window** (e.g. "tonight 21:00–22:00") when you can forward codes within 2–3 minutes
6. The Facebook account that should own the *Bona* Page (your personal Facebook login is needed for the Page and Meta Business; if you prefer not to share it, do step A2 yourself after the agent has switched the account to Business)

Change the password afterwards if you wish; the API token keeps working.

---

## Other accounts — what the agent needs

| Channel | Needed from you | Notes |
|---|---|---|
| **WhatsApp Business** +966 59 329 6933 | Nothing | You set the profile in the app yourself: name, category, description, hours, address, greeting/away messages and quick replies are in `marketing/social-bios.md` → "WhatsApp Business profile". |
| **Google Analytics 4** | The **Measurement ID** (`G-XXXXXXXXXX`) from a GA4 property you create at analytics.google.com | Goes into `src/data/site.json` → `analytics.ga4`. The tag is already wired in `<head>` and stays off until the ID is present; the privacy policy will be updated the same day. |
| **Meta Pixel** (optional, only if ads are planned) | The **Pixel / Dataset ID** (15–16 digits) from Events Manager | Goes into `src/data/site.json` → `analytics.metaPixel`. Same on/off behaviour as GA4. |

Once Path A or B is complete, the coordinator will run `node scripts/instagram-post.mjs whoami`, publish the 9-post launch grid from `marketing/launch-posts.md`, and start the 30-day calendar in `marketing/content-calendar.md`.
