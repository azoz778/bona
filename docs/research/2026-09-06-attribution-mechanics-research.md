# Attribution mechanics for bona.azoz.uk → WhatsApp → dashboard
Research date: 2026-09-06. Constraints: static Astro 7 on GitHub Pages (Cloudflare DNS), Node API at bona-api.azoz.uk (Cloudflare Tunnel, WSL), personal WhatsApp on Evolution API (Baileys) polled read-only via `chat/findMessages`, Retell concierge calling `create_lead`.

## 0. Headline findings (read these first)

1. **A personal WhatsApp number cannot be the destination of Click-to-WhatsApp (CTWA) ads.** Meta requires a WhatsApp *Business* account (app or Platform) connected to the Page ([Meta Business Help 372008982225441](https://www.facebook.com/business/help/372008982225441), [Ads that click to WhatsApp](https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-whatsapp)). So today every ad must land on the **website**, and the site → `wa.me` hop is where attribution must be captured. That is good news: it means one mechanism (our own session bundle + ref code) covers Meta, Snap, Google, TikTok and organic alike.
2. **Meta's "business messaging" CAPI events (`action_source: business_messaging`, `ctwa_clid`) are NOT usable on a Baileys number.** Prereqs are a WABA, Cloud API (or On-Prem ≥ v2.45.1), `whatsapp_business_manage_events`, and a Dataset linked to the WABA ([Meta CAPI for Business Messaging](https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging)). Use ordinary `action_source: website` Lead/Contact/Schedule events from bona-api with `fbc`/`fbp` captured on the site instead.
3. **Baileys does expose CTWA metadata** if the number were ever a Business-app account linked to a Page: `ContextInfo.externalAdReply` (field 28) → `ExternalAdReplyInfo { sourceType=7, sourceId=8, sourceUrl=9, ctwaClid=13, ref=14, sourceApp=17, ctaPayload=20, adType {CTWA, CAWC} }`, plus `ContextInfo.conversionSource=18`, `entryPointConversionSource=29`, `entryPointConversionApp=30`, `utm=41 (UTMInfo{utmSource, utmCampaign})`, `entryPointConversionExternalSource=50/Medium=51`, `ctwaSignals=54`, `ctwaPayload=55` — verified by grepping [WAProto.proto in WhiskeySockets/Baileys master](https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/WAProto/WAProto.proto). Evolution's `prepareMessage()` persists `contextInfo` from the content message and `fetchMessages()` selects it, so it is retrievable via `findMessages` on current `main` (an older report, [issue #975 on v2.1.2](https://github.com/EvolutionAPI/evolution-api/issues/975), said those fields were stripped — verify on the installed version).
4. **The durable link between a click and a chat is a short ref code in the prefilled text**, not cookies: GitHub Pages cannot set headers/cookies ([GitHub community #54257](https://github.com/orgs/community/discussions/54257)), Safari caps *all* script-written storage at 7 days of non-interaction ([WebKit blog](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)), and iOS 17 Link Tracking Protection strips `fbclid`/`gclid` in Mail/Messages/Private Browsing but leaves UTMs and custom params alone ([Terminus](https://www.terminusapp.com/blog/ios-17-link-tracking-protection-what-survives/), [Fathom](https://usefathom.com/blog/ios17-link-tracking-protection)).
5. **Storage: better-sqlite3 single file; dashboard: server-rendered page on bona-api behind Cloudflare Access one-time-PIN.** DuckDB can `ATTACH` the SQLite file later for ad-hoc analytics ([MotherDuck](https://motherduck.com/learn/duckdb-vs-sqlite-databases/)); Metabase in Docker is the fallback if the owner wants self-serve SQL ([Grafana vs Metabase 2025](https://blog.houseoffoss.com/post/grafana-vs-metabase-in-2025-which-open-source-data-tool-should-you-choose)).

---

## 1. Capturing first-touch / last-touch on a static site

### 1.1 Field set (what to read from the URL / browser)
| Group | Keys | Notes / source |
|---|---|---|
| UTM | `utm_source, utm_medium, utm_campaign, utm_content, utm_term, utm_id` | Put `{{campaign.id}}` in `utm_id` on Meta (names get renamed; IDs don't) — [Terminus Meta UTM guide 2026](https://www.terminusapp.com/blog/meta-facebook-ads-utm-tracking-2026/), [utm.new](https://utm.new/blog/meta-dynamic-utm-parameters). Use `{{placement}}` in `utm_medium`/`utm_content` to split Instagram vs Facebook vs Reels ([Mixed Analytics](https://mixedanalytics.com/blog/facebook-ads-google-analytics-url-dynamic-parameters/)). |
| Meta | `fbclid` | Auto-appended on every ad click; case-sensitive; feeds `fbc` ([Meta fbp/fbc](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc)). |
| Google | `gclid, gbraid, wbraid, gad_source, gad_campaignid` | `gbraid`/`wbraid` are the iOS-privacy variants and survive iOS stripping; capture all ([CustomerLabs](https://www.customerlabs.com/blog/what-are-gclid-gbraid-and-wbraid-parameters/), [WickedReports](https://www.wickedreports.com/blog/gclids-gbraids-wbraids-what-is-going-on)). |
| TikTok | `ttclid` | Valid 7 days for matching ([RudderStack TikTok](https://www.rudderstack.com/docs/destinations/streaming-destinations/tiktok-ads/cloud-mode/)). |
| Snapchat | `ScCid` | Appended by Snap on swipe-up; must reach the landing page without redirects ([Snap Conversions API](https://developers.snap.com/api/marketing-api/Conversions-API/UsingTheAPI), [Snap URL parameters](https://businesshelp.snapchat.com/s/article/url-parameters?language=en_US)). |
| Others | `msclkid, li_fat_id, twclid, dclid` | Cheap to store; future-proof. |
| Context | `document.referrer`, landing path+query, `Date.now()`, `navigator.language`, viewport class | Referrer is the only signal for organic Instagram/Google (Instagram in-app browser often sends `l.instagram.com`). |
| Cookies to mirror | `_fbp`, `_fbc` (if pixel loaded), `_ga`, `_ga_<ID>` (if GA4 loaded), `_scid`, `_ttp` | Read and copy into the bundle so the server can pass them to CAPI/MP/Snap/TikTok. |

### 1.2 Persistence model
- **First touch**: written once, kept 90 days (matches Meta's 90-day `_fbc` and Google's 90-day GCLID upload window — [Google Ads OCI FAQ](https://support.google.com/google-ads/answer/10029210?hl=en)). Reset after expiry.
- **Last touch**: overwritten whenever a page load carries any UTM/click-id **or** an external referrer.
- **Session**: 30-min inactivity window (GA4 convention), `session_id` = base36 timestamp + random.
- **Where**: `localStorage` (primary, survives app-switch better than cookies) + a mirror first-party cookie `bona_id` with `Max-Age=7776000; Secure; SameSite=Lax`. Both are *script-written*, so Safari ITP deletes them after 7 days of no visits ([Didomi on the 7-day cap](https://support.didomi.io/apple-adds-a-7-day-cap-on-all-script-writable-storage), [cookiestatus.com](https://www.cookiestatus.com/safari/)). Server-set cookies escape the cap only when set by a true first-party host; bona-api.azoz.uk is same-site with bona.azoz.uk, so a `Set-Cookie: bona_sid=…; Domain=.azoz.uk; Max-Age=7776000` from the `/v1/session` echo call (fetch with `credentials:'include'`) extends life on Safari — *provided* the DNS chain does not look CNAME-cloaked (Cloudflare-proxied records are flattened; Safari 16.4+ caps CNAME-cloaked hosts to 7 days — [Trackko](https://trackko.app/blog/safari-itp-explained-7-day-cookie-limits-and-the-fix)). Treat this as a bonus, not the backbone; the ref code is the backbone.

### 1.3 Generating `fbc` / `fbp` without the Pixel
Format is `fb.<subdomainIndex>.<creationTimeMs>.<value>` ([Meta fbp and fbc](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/fbp-and-fbc)):
- `fbc = "fb.1." + Date.now() + "." + fbclid` — timestamp = the moment you first saw the fbclid (13-digit ms), subdomain index `1` when generated without the `_fbc` cookie, never alter the fbclid's case ([UTMGrabber](https://utmgrabber.com/blog/facebook-fbc-missing-fbclid-meta-capi/)).
- `fbp = "fb.1." + Date.now() + "." + <random 10-digit integer>` — only if no `_fbp` cookie exists; if the Pixel is later loaded it will write its own `_fbp`, prefer the cookie value.
- Send both **unhashed**.

### 1.4 Consent Mode v2 (Google) and the KSA context
- Consent Mode v2 (`ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`) is mandatory only for traffic from the EEA/UK; enforcement since 21 Jul 2025 removes personalised ads/remarketing for non-compliant EEA advertisers ([Simo Ahava](https://www.simoahava.com/analytics/consent-mode-v2-google-tags/), [SecurePrivacy outside EEA](https://secureprivacy.ai/blog/how-to-use-google-consent-mode-v2-outside-eea-uk), [Groas post-June-2025](https://www.groas.com/post/navigating-consent-mode-v2-in-google-ads-post-june-2025-best-practices-for-compliance)).
- Recommendation for a Saudi site with incidental EEA visitors: set defaults **denied for EEA/UK regions only** via the `region` array in `gtag('consent','default', {...})`, granted elsewhere; show a banner only when `bona-api /v1/geo` (reads Cloudflare's `CF-IPCountry`) returns an EEA code. Our own first-party event store does not depend on Google consent state.
- Saudi PDPL (in force, grace period ended 14 Sep 2024): cross-border transfers are allowed with safeguards (Saudi SCCs, Aug-2024 Transfer Regulations), no SDAIA adequacy list yet, and a documented **risk assessment** before transfers (SDAIA guideline Feb 2025) ([King & Spalding](https://www.kslaw.com/news-and-insights/international-personal-data-transfers-under-saudi-arabias-data-protection-law), [ITIF Jun 2025](https://itif.org/publications/2025/06/09/saudi-arabia-cross-border-data-transfer-regulation/), [Clyde & Co](https://www.clydeco.com/en/insights/2024/09/saudi-arabia-s-personal-data-protection-law-become)). Practical stance: keep the system of record (phone numbers, chat text) on the WSL box; send only hashed phone / pseudonymous IDs to Meta/Google/Snap/TikTok; keep `/privacy/` current.

### 1.5 Vanilla-JS pattern (Astro: put in the base layout as `<script is:inline>`)
```html
<script is:inline>
(function () {
  var KEY='bona_attr', DAYS=90, SESSION_MIN=30, API='https://bona-api.azoz.uk';
  var now=Date.now(), q=new URLSearchParams(location.search);
  var UTMS=['utm_source','utm_medium','utm_campaign','utm_content','utm_term','utm_id'];
  var CIDS=['fbclid','gclid','gbraid','wbraid','gad_source','gad_campaignid','ttclid','ScCid','msclkid','li_fat_id','twclid','dclid'];
  var ALPHA='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  function rid(n){var a=new Uint8Array(n);crypto.getRandomValues(a);return Array.from(a,function(b){return b.toString(16).padStart(2,'0')}).join('');}
  function code(n){var a=new Uint8Array(n);crypto.getRandomValues(a);return Array.from(a,function(b){return ALPHA[b%32]}).join('');}
  function cookie(n){var m=document.cookie.match(new RegExp('(?:^|; )'+n+'=([^;]+)'));return m?decodeURIComponent(m[1]):null;}
  function load(){try{return JSON.parse(localStorage.getItem(KEY)||'null');}catch(e){return null;}}
  function save(s){try{localStorage.setItem(KEY,JSON.stringify(s));document.cookie='bona_id='+s.anon_id+'; Max-Age='+(DAYS*86400)+'; Path=/; Secure; SameSite=Lax';}catch(e){}}
  function touch(){
    var t={ts:now,landing:location.pathname+location.search,referrer:document.referrer||null,click_ids:{}};
    UTMS.forEach(function(k){if(q.get(k))t[k]=q.get(k);});
    CIDS.forEach(function(k){if(q.get(k))t.click_ids[k]=q.get(k);});
    if(!t.utm_source){
      var c=t.click_ids, h=null;
      try{h=t.referrer?new URL(t.referrer).hostname.replace(/^www\./,''):null;}catch(e){}
      if(c.fbclid){t.utm_source='meta';t.utm_medium='paid';}
      else if(c.gclid||c.gbraid||c.wbraid){t.utm_source='google';t.utm_medium='cpc';}
      else if(c.ttclid){t.utm_source='tiktok';t.utm_medium='paid';}
      else if(c.ScCid){t.utm_source='snapchat';t.utm_medium='paid';}
      else if(h&&h!==location.hostname){t.utm_source=h;t.utm_medium=/instagram|facebook|google|tiktok|snapchat|x\.com|twitter|linkedin/.test(h)?'social_or_organic':'referral';}
      else{t.utm_source='(direct)';t.utm_medium='(none)';}
    }
    return t;
  }
  var s=load();
  if(!s||now-s.created>DAYS*86400e3) s={v:1,anon_id:rid(16),created:now,first:null,last:null,session:null,fbp:null,fbc:null};
  var t=touch(), ext=false; try{ext=!!t.referrer&&new URL(t.referrer).hostname!==location.hostname;}catch(e){}
  var isTouch=Object.keys(t.click_ids).length>0||UTMS.some(function(k){return q.has(k);})||ext;
  if(!s.first) s.first=t;
  if(isTouch||!s.last) s.last=t;
  if(!s.session||now-s.session.last_seen>SESSION_MIN*60e3) s.session={id:now.toString(36)+'-'+rid(3),ref:code(5),start:now,pages:0};
  s.session.last_seen=now; s.session.pages++;
  if(q.get('fbclid')) s.fbc='fb.1.'+now+'.'+q.get('fbclid');
  s.fbc=cookie('_fbc')||s.fbc; s.fbp=cookie('_fbp')||s.fbp||('fb.1.'+now+'.'+Math.floor(Math.random()*1e10));
  s.ga={client_id:(cookie('_ga')||'').replace(/^GA1\.\d\./,'')||null, session_id:(function(){var m=document.cookie.match(/_ga_[A-Z0-9]+=GS\d\.\d\.s?(\d+)/);return m?m[1]:null;})()};
  s.scid=cookie('_scid'); s.ttp=cookie('_ttp');
  save(s); window.BONA_ATTR=s;
  function send(ev){ // text/plain keeps it a CORS "simple request": no preflight, works with keepalive
    var body=JSON.stringify(Object.assign({ts:Date.now(),anon_id:s.anon_id,session_id:s.session.id,ref:s.session.ref,page:location.pathname,attr:{first:s.first,last:s.last,fbp:s.fbp,fbc:s.fbc,ga:s.ga,scid:s.scid,ttp:s.ttp}},ev));
    try{fetch(API+'/v1/events',{method:'POST',keepalive:true,headers:{'Content-Type':'text/plain'},body:body});}catch(e){}
  }
  window.bonaTrack=send;
  send({event:'page_view',listing_id:document.body.dataset.listing||null});
  document.addEventListener('click',function(ev){
    var a=ev.target.closest&&ev.target.closest('a[href*="wa.me"],a[href*="api.whatsapp.com"]'); if(!a)return;
    var listing=a.dataset.listing||document.body.dataset.listing||'BONA';
    var u=new URL(a.href); var txt=u.searchParams.get('text')||'';
    if(!/\bRef\b/.test(txt)) u.searchParams.set('text',txt+(txt?'\n':'')+'Ref '+listing+' · '+s.session.ref);
    a.href=u.toString();
    send({event:'whatsapp_click',listing_id:listing,cta:a.dataset.cta||null,href:a.href});
  },true);
})();
</script>
```
Notes: the click handler runs in the capture phase so the rewritten `href` is what the browser navigates to; `fetch keepalive` survives the tab hand-off to the WhatsApp app; the ref is minted **per session** so the mapping `ref → bundle` exists server-side before the chat starts.

---

## 2. Getting attribution INTO the WhatsApp conversation (Baileys / Evolution number)

### 2.1 (a) Ref code in the prefilled text
- Format: `Ref BONA-W003 · K7Q2X` on its own last line. 5 chars from a 32-symbol alphabet = 33M codes; 4 chars = 1M (enough if you rotate per session and expire after 90 days). Keep the listing ID human-readable so the owner also understands it.
- Poller regex on inbound text: `/\bRef\s+([A-Z]+-[A-Z]?\d+)?\s*[·\-:]?\s*([A-HJ-NP-Z2-9]{4,6})\b/i`.
- Fallback matching when the client deletes the line: (1) phone already known → existing lead; (2) a `whatsapp_click` event within ±15 min of the first inbound message from a *new* JID → attach as `match_method: "time_window"` (flag as inferred); (3) else `direct/unknown`.
- **Baileys message structure for CTWA ads**: see §0 item 3 (proto field numbers). Real-world payload seen on Evolution when a chat starts from an ad: `"conversionSource":"FB_Ads"`, `"entryPointConversionSource":"ctwa_ad"`, `"entryPointConversionApp":"facebook"` inside `contextInfo` ([Evolution issue #2267](https://github.com/EvolutionAPI/evolution-api/issues/2267) — closed "not planned"; it also documents that such chats arrive with `remoteJid` = `…@lid` and `pushName: null`). Evolution 2.3.7's Baileys service now swaps `key.remoteJid` to `key.remoteJidAlt` when the JID is `@lid` (source: `whatsapp.baileys.service.ts` lines ~1478-1479 on `main`), and its Cloud-API channel added an `adReferral` object merged into `contextInfo` ([issue #2645](https://github.com/evolution-foundation/evolution-api/issues/2645)). For non-ad chats Baileys cannot generally map `@lid` back to a phone number ([Baileys #2414](https://github.com/WhiskeySockets/Baileys/issues/2414), [discussion #2551](https://github.com/WhiskeySockets/Baileys/discussions/2551)) — store both JIDs and key leads on whichever is stable.
- **Does `ctwa_clid` appear on a non-Cloud-API number?** Only if the number is a WhatsApp *Business* account that is the CTWA destination — impossible for the current personal number (§0 item 1). Even then the click ID can only be used for *internal* attribution, since Meta's business-messaging CAPI needs a WABA/Cloud API ([Meta doc](https://developers.facebook.com/docs/marketing-api/conversions-api/business-messaging), [Whapi on ctwa_clid](https://whapi.cloud/blog/track-click-to-whatsapp-ctwa-clid), [openclaw #39037](https://github.com/openclaw/openclaw/issues/39037)). Baileys pairs to a Business-app account exactly like a personal one (linked device via QR/pairing code, [Baileys README](https://github.com/WhiskeySockets/Baileys)); note Cloud-API *Coexistence* on the same number breaks Baileys decryption ([Baileys #1686](https://github.com/WhiskeySockets/Baileys/issues/1686)).
- Also log `contextInfo.utm` (`utmSource/utmCampaign`) and `entryPointConversionExternalSource/Medium` if WhatsApp ever populates them for click-to-chat links — unknown today, free to capture.

### 2.2 Evolution `findMessages` polling facts (from `channel.service.ts` on `main`)
- `POST /chat/findMessages/{instance}` body `{ where: { key: { remoteJid?, id?, fromMe?, participants? }, messageTimestamp: { gte: ISO, lte: ISO } }, page, offset }` — `offset` is the page size (default 50), `page` starts at 1, sorted `messageTimestamp desc`.
- **Gotcha**: `fromMe: false` is ignored (filter is `keyFilters?.fromMe ? … : {}`), and the timestamp filter only applies when *both* `gte` and `lte` are present. Filter `fromMe` client-side; always pass a window.
- Returned record: `{ id, key{remoteJid, fromMe, id, remoteJidAlt?}, pushName, messageType, message{conversation|…}, messageTimestamp, source, contextInfo, MessageUpdate[] }` (`extendedTextMessage.text` is flattened into `message.conversation`).
- Dedupe by `key.id`; keep a cursor of the last `messageTimestamp` polled; poll every 30-60 s.

### 2.3 (b) Link formats, prefill survival, limits
- `https://wa.me/966593296933?text=<urlencoded>` and `https://api.whatsapp.com/send?phone=966593296933&text=…` are both official click-to-chat forms; `wa.me` is the short one ([WhatsApp FAQ](https://faq.whatsapp.com/5913398998672934/?locale=en_US), [u2l guide 2026](https://u2l.ai/blog/whatsapp-click-to-chat-link)).
- `https://wa.me/message/<CODE>` is the **WhatsApp Business app "Short Link"** with one fixed default message configured in-app ([WABetaInfo](https://wabetainfo.com/whatsapp-is-rolling-out-the-short-link-feature/), [SleekFlow](https://sleekflow.io/blog/whatsapp-link)) — not available on a personal account and cannot carry a per-listing ref; do not use.
- Prefilled text: no official length limit; long URLs get truncated by some browsers/apps, so keep it to a sentence or two ([wha.tools reference](https://wha.tools/whatsapp-link-format), [Qualimero](https://qualimero.com/en/blog/create-whatsapp-link)). Practical budget: ≤ 300 characters after encoding. Always `encodeURIComponent`; raw `&`, `#`, `?` break the parameter ([Dotdigital](https://marketing.help.dotdigital.com/en/articles/11331301-click-to-chat-for-whatsapp)). Desktop shows an interstitial and opens WhatsApp Web/Desktop with the text ([u2l](https://u2l.ai/blog/whatsapp-click-to-chat-link)).
- iOS: no current evidence that iOS strips the `text` parameter itself; the documented iOS behaviour is Link Tracking Protection removing known tracking IDs (`fbclid`, `gclid`, `twclid`, `dclid`, `mc_eid`…) in Mail/Messages/Private Browsing ([Terminus](https://www.terminusapp.com/blog/ios-17-link-tracking-protection-what-survives/)). Our ref lives in the message body, not a tracking param, so it survives.

---

## 3. Meta Conversions API from bona-api

- Endpoint: `POST https://graph.facebook.com/v21.0/{PIXEL_ID}/events?access_token=…` (Dataset/Pixel ID; System User token).
- **Website events require `action_source: "website"`, `event_source_url`, and `user_data.client_user_agent`** ([Meta server-event params](https://developers.facebook.com/documentation/ads-commerce/conversions-api/parameters/server-event), [Hightouch summary](https://hightouch.com/docs/destinations/meta-conversions)). `event_time` may be at most 7 days old; `event_id`+`event_name` dedupe within 48 h, browser event preferred if both arrive within 5 min.
- Allowed `action_source`: `email, website, app, phone_call, chat, physical_store, system_generated, business_messaging, other` (same source). Use `website` for the click and `chat` (or `website` with the original URL) for the WhatsApp-confirmed lead; `business_messaging` is off-limits (§0).
- Standard events: `Contact` (browser, at `whatsapp_click`, with `eventID`), `Lead` (server, when the WhatsApp conversation is confirmed/qualified), `Schedule` (server, viewing booked); Purchase/custom for closed deals ([Meta Pixel reference](https://developers.facebook.com/docs/meta-pixel/reference/), [adsuploader standard events](https://adsuploader.com/blog/meta-pixel-standard-events)).
- Hashing ([customer information parameters](https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters)): `ph` = digits only, country code, **no `+`, no leading zeros**, SHA-256 lowercase hex — Saudi `05x xxx xxxx` → `9665xxxxxxxx`; `em` lowercase trimmed; `external_id` hashed (use `anon_id`); `fbc`/`fbp`/IP/UA **not** hashed.
- Minimal server payload:
```json
{"data":[{"event_name":"Lead","event_time":1757150000,"event_id":"lead_01J…","action_source":"website",
 "event_source_url":"https://bona.azoz.uk/listings/bona-w003/",
 "user_data":{"ph":["<sha256(9665…)>"],"external_id":["<sha256(anon_id)>"],"fbc":"fb.1.1757149000000.IwAR…","fbp":"fb.1.1757148000000.1234567890",
   "client_ip_address":"<from click event>","client_user_agent":"<from click event>","country":["<sha256('sa')>"]},
 "custom_data":{"content_name":"BONA-W003","content_ids":["BONA-W003"],"content_type":"product","currency":"SAR","value":0,"lead_source":"whatsapp"}}],
 "test_event_code":"TESTxxxxx"}
```
- **Meta Lead Ads (Instant Forms) retrieval** for a solo operator: (1) free/manual — Leads Center / CSV; (2) Make.com instant "New Lead" trigger (~$9/mo) → webhook to bona-api; Zapier's Facebook Lead Ads is a premium app (paid plans only) ([adsuploader Zapier guide](https://adsuploader.com/blog/facebook-lead-ads-zapier), [LeadSync vs Zapier](https://leadsync.me/blog/leadsync-vs-zapier/)); (3) Graph API: `GET /{form_id}/leads` with a Page token + `leads_retrieval`, `pages_show_list`, `pages_manage_ads`/`pages_read_engagement`; Standard Access works for Pages you administer while the app is in dev mode, Advanced Access (App Review + Business Verification) is only needed to serve other advertisers ([Meta Retrieving Leads](https://developers.facebook.com/documentation/ads-commerce/marketing-api/guides/lead-ads/retrieving), [leads_retrieval guide](https://singhamandeep.com/leads-retrieval-permission-approval-facebook-lead-ads-api/)). Leads expire after 90 days; rate limit = 200 × 24 × leads-in-last-90-days per Page per day. Webhooks (`leadgen` field, needs `pages_manage_metadata`) can silently die, so poll every 10-15 min as reconciliation regardless ([leadsync guide](https://leadsync.me/blog/meta-lead-gen-api-guide/), [Meta leadgen webhooks](https://developers.facebook.com/docs/graph-api/webhooks/getting-started/webhooks-for-leadgen/)). Lead record: `created_time, id, ad_id, form_id, field_data[{name, values[]}], is_organic`.

---

## 4. GA4 Measurement Protocol + privacy-friendly analytics

- `POST https://www.google-analytics.com/mp/collect?measurement_id=G-XXXX&api_secret=…` (validate at `/debug/mp/collect`). Body: `client_id` (the `_ga` cookie minus `GA1.1.`), optional `user_id`, `timestamp_micros` (≤ 72 h backdating), `consent`, `user_data`, `events[]` (≤ 25/req, ≤ 25 params each, values ≤ 100 chars) ([Google MP reference](https://developers.google.com/analytics/devguides/collection/protocol/ga4/sending-events?client_type=gtag)).
- For the event to attach to the browser session's source/medium you must send the same `client_id` **and** `params.session_id` (from `_ga_<ID>` cookie: `GS2.1.s<session_id>$o…` — strip the `s`; older `GS1.1.<session_id>.…`), plus `engagement_time_msec: 1`; MP events cannot set traffic source themselves ([Simo Ahava](https://www.simoahava.com/analytics/session-attribution-with-ga4-measurement-protocol/), [Tracking Chef](https://trackingchef.com/google-analytics/how-to-add-session-id-to-ga4-measurement-protocol-events/)). Since Feb 2026 Google also accepts raw cookie values, but extracted values remain recommended ([Data Journal](https://datajournal.datakyu.co/advanced-ga4-measurement-protocol-implementation/)).
- Use the lead-lifecycle recommended events: `generate_lead` (params `currency`, `value`, `lead_source`), then `qualify_lead`, `working_lead`, `close_convert_lead` / `close_unconvert_lead` from the server as stages change; mark `generate_lead` as a key event and import it into Google Ads as a conversion ([GA4 recommended events](https://support.google.com/analytics/answer/9267735?hl=en), [Stape](https://stape.io/news/ga4-new-recommended-events-lead-generation)). Later stages will be > 72 h after the session, so send them without `session_id` (they attribute to the user, not the session).
- Google Ads offline import for `gclid`/`gbraid`/`wbraid` (90-day window; enhanced conversions for leads use hashed email/phone, 63-day window) — moving to Data Manager; legacy API uploads blocked from 15 Jun 2026 ([Google Ads OCI](https://support.google.com/google-ads/answer/2998031?hl=en), [ECL](https://support.google.com/google-ads/answer/15713840?hl=en), [Google Ads API upload-clicks](https://developers.google.com/google-ads/api/docs/conversions/upload-clicks?authuser=1)). For a solo broker, a monthly CSV/Sheets upload from the `leads` table is enough.
- Privacy-friendly alternatives: **Umami** (v3, Postgres-only, ~200 MB RAM, cookieless, custom events) fits the WSL box behind the tunnel ([Umami install](https://docs.umami.is/docs/install), [OneUptime guide 2026](https://oneuptime.com/blog/post/2026-02-08-how-to-run-umami-analytics-in-docker/view)); **Plausible** needs ClickHouse ≥ 2 GB RAM ([plausible #4740](https://github.com/plausible/analytics/discussions/4740)); **Cloudflare Web Analytics** is free and cookieless but has no custom events/funnels ([Ctrl blog review](https://www.ctrl.blog/entry/review-cloudflare-analytics.html)). Recommendation: our own event store is the system of record; GA4 stays as the bridge to Google Ads bidding; Umami optional.

---

## 5. Snapchat CAPI v3 and TikTok Events API 2.0 (minimal Lead payloads, for later)

**Snapchat** ([Using the API](https://developers.snap.com/api/marketing-api/Conversions-API/UsingTheAPI), v2 deprecated early 2025 — [migration](https://developers.snap.com/api/marketing-api/Conversions-API/MigrationGuide)):
```
POST https://tr.snapchat.com/v3/{PIXEL_ID}/events?access_token=…   (validate: …/events/validate)
{"data":[{"event_name":"SIGN_UP","action_source":"WEB","event_time":1757150000,"event_id":"lead_01J…",
  "event_source_url":"https://bona.azoz.uk/listings/bona-w003/",
  "user_data":{"ph":"<sha256(966…)>","sc_click_id":"<ScCid>","sc_cookie1":"<_scid>","client_ip_address":"…","client_user_agent":"…"},
  "custom_data":{"currency":"SAR","value":0,"event_tag":"whatsapp_lead"}}]}
```
(`SIGN_UP` or `CUSTOM_EVENT_1` for a lead; `PURCHASE` needs `currency`+`value`.)

**TikTok** ([Events API 2.0 doc id 1771100865818625](https://business-api.tiktok.com/portal/docs?id=1771100865818625), field mapping via [MetaRouter](https://docs.metarouter.io/docs/tiktok) and [RudderStack](https://www.rudderstack.com/docs/destinations/streaming-destinations/tiktok-ads/cloud-mode/)):
```
POST https://business-api.tiktok.com/open_api/v1.3/event/track/   header: Access-Token: …
{"event_source":"web","event_source_id":"<PIXEL_CODE>","test_event_code":"…optional…",
 "data":[{"event":"SubmitForm","event_time":1757150000,"event_id":"lead_01J…",
   "user":{"ttclid":"<ttclid>","ttp":"<_ttp cookie>","phone":"<sha256('+966…')>","external_id":"<sha256(anon_id)>","ip":"…","user_agent":"…"},
   "page":{"url":"https://bona.azoz.uk/listings/bona-w003/","referrer":"…"},
   "properties":{"currency":"SAR","value":0,"content_id":"BONA-W003","content_type":"product"}}]}
```
(Lead-gen events: `SubmitForm` or `Contact`; email/phone SHA-256, phone in E.164 *with* `+` for TikTok; `ttclid` valid 7 days.)

---

## 6. Dashboard patterns and minimal event taxonomy

### 6.1 Taxonomy (event → required props)
| Event | Where fired | Props |
|---|---|---|
| `page_view` | site | `path`, `listing_id?` |
| `listing_view` | site (listing page) | `listing_id`, `price`, `district` |
| `gallery_open`, `tour_open`, `brochure_download` | site | `listing_id`, `asset` |
| `whatsapp_click`, `call_click` | site | `listing_id`, `cta`, `href`, `ref` |
| `concierge_chat_start`, `concierge_call_start` | site (Retell widget) → server | `listing_id?`, `retell_call_id` |
| `lead_created` | server (WA poller / Retell `create_lead` / Lead Ads) | `lead_id`, `channel`, `match_method`, `ref` |
| `lead_qualified`, `viewing_booked`, `offer`, `closed_won`, `closed_lost` | server (owner action in dashboard) | `lead_id`, `value_sar`, `reason?` |

Every event stores: `event_id (ULID)`, `ts`, `anon_id`, `session_id`, `lead_id?`, `listing_id?`, `path`, `src_first` and `src_last` (frozen copies of the bundle at that moment), `props` JSON, `ip_country` (from `CF-IPCountry`), `ua`.

Retell: pass `{anon_id, session_id, ref, listing_id}` as `metadata` when creating the web call / chat; the custom-function POST includes `call.metadata` so `create_lead` attaches attribution server-side instead of trusting LLM-generated args ([Retell create-web-call](https://docs.retellai.com/api-references/create-web-call), [custom function](https://docs.retellai.com/build/single-multi-prompt/custom-function)).

### 6.2 Views the owner actually needs
1. **Sources → leads** (last-touch and first-touch side by side; by `utm_source/medium/campaign(utm_id)`; CPL when `ad_spend` is filled — manual CSV or Marketing API insights).
2. **Listing funnel**: `listing_view → gallery/tour → whatsapp_click → conversation → viewing`.
3. **Pipeline**: leads by stage with age-in-stage, next action, response time (first inbound → first outbound, computable from Evolution `fromMe` messages).
4. **Match quality**: % of conversations matched by ref vs time-window vs unknown (tells him whether the ref line is surviving).
5. **Daily strip**: sessions, WA clicks, new conversations, viewings booked.

---

## 7. Storage / dashboard engine recommendation

| Option | Verdict |
|---|---|
| **better-sqlite3** (WAL, JSON1, window functions) | **Recommended.** Synchronous API, one file, trivially backed up, fine to millions of rows; aggregations for a solo broker's volume are milliseconds ([SoloDevStack](https://solodevstack.com/blog/duckdb-vs-sqlite-solo-developers), [dev.to](https://dev.to/soytuber/maybe-sqlite-is-still-better-than-duckdb-for-my-workloads-hli)). |
| DuckDB | Add later for ad-hoc analysis: `ATTACH 'events.db' (TYPE sqlite)` — columnar speed without changing the write path ([MotherDuck](https://motherduck.com/learn/duckdb-vs-sqlite-databases/)). |
| Postgres | Overkill; one more service to keep alive on WSL. |
| **Dashboard = server-rendered HTML on bona-api** (`/dashboard`, Chart.js/uPlot from cdnjs, JSON at `/v1/stats`) | **Recommended.** Protect with Cloudflare Access one-time PIN (free plan covers up to 50 users) ([Cloudflare OTP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/), [Zero Trust plans](https://blog.cloudflare.com/teams-plans/)). |
| Metabase (Docker) | Fallback for self-serve SQL; 5-min setup but ~1-2 GB RAM ([houseoffoss](https://blog.houseoffoss.com/post/grafana-vs-metabase-in-2025-which-open-source-data-tool-should-you-choose)). |
| Grafana | Wrong tool (time-series ops), skip. |
| Static `/dashboard/` on GitHub Pages reading a JSON export | Only for **non-PII aggregates** (public site, public repo); never for the lead list. |

Schema sketch (SQLite):
```sql
CREATE TABLE sessions(session_id TEXT PRIMARY KEY, anon_id TEXT, ref TEXT UNIQUE, started INTEGER, last_seen INTEGER,
  first_touch TEXT, last_touch TEXT, fbp TEXT, fbc TEXT, ga_client_id TEXT, ga_session_id TEXT, scid TEXT, ttp TEXT, ip TEXT, ua TEXT, country TEXT);
CREATE TABLE events(event_id TEXT PRIMARY KEY, ts INTEGER, name TEXT, anon_id TEXT, session_id TEXT, lead_id TEXT, listing_id TEXT, path TEXT,
  src_first TEXT, src_last TEXT, props TEXT);
CREATE INDEX ev_ts ON events(ts); CREATE INDEX ev_listing ON events(listing_id,name); CREATE INDEX ev_anon ON events(anon_id);
CREATE TABLE leads(lead_id TEXT PRIMARY KEY, created INTEGER, phone_e164 TEXT, wa_jid TEXT, wa_lid TEXT, name TEXT, channel TEXT,
  ref TEXT, match_method TEXT, session_id TEXT, anon_id TEXT, listing_id TEXT, first_touch TEXT, last_touch TEXT,
  stage TEXT, stage_ts INTEGER, value_sar REAL, notes TEXT);
CREATE TABLE lead_stage_history(lead_id TEXT, stage TEXT, ts INTEGER, actor TEXT);
CREATE TABLE wa_cursor(instance TEXT PRIMARY KEY, last_ts INTEGER); CREATE TABLE wa_seen(key_id TEXT PRIMARY KEY, ts INTEGER);
CREATE TABLE ad_spend(day TEXT, platform TEXT, campaign_id TEXT, campaign_name TEXT, spend_sar REAL, clicks INTEGER, PRIMARY KEY(day,platform,campaign_id));
CREATE TABLE fanout(event_id TEXT, dest TEXT, status TEXT, response TEXT, ts INTEGER, PRIMARY KEY(event_id,dest));
```

---

## (a) End-to-end architecture (text diagram)
```
[Meta/Snap/Google/TikTok ads, IG organic]      (all land on the site; CTWA impossible on personal number)
        │  URL: utm_* + utm_id={{campaign.id}} + fbclid/gclid/gbraid/wbraid/ttclid/ScCid
        ▼
bona.azoz.uk (Astro static, GitHub Pages)  <script is:inline> attribution.js
   ├─ localStorage bona_attr {anon_id, first, last, session{id, ref}, fbp, fbc, ga, scid, ttp}
   ├─ page_view / listing_view / gallery_open / tour_open / brochure_download  ──POST text/plain──▶ bona-api /v1/events
   ├─ CTA click ──rewrite href──▶ https://wa.me/966593296933?text=…%0ARef%20BONA-W003%20%C2%B7%20K7Q2X   (+ whatsapp_click event, keepalive)
   └─ Retell widget: createWebCall/chat metadata {anon_id, session_id, ref, listing_id} ──▶ Retell ──tool create_lead(call.metadata)──▶ bona-api
                                                                                       │
WhatsApp (personal number, Evolution/Baileys) ◀── client sends prefilled text ─────────┘
        │ poll every 30-60 s: POST /chat/findMessages/{instance} {where:{messageTimestamp:{gte,lte}}, page, offset}
        ▼
bona-api "wa-poller": dedupe key.id → filter fromMe=false → parse "Ref … <code>" → lookup sessions.ref
        │            → else time-window match vs whatsapp_click → else unknown; capture contextInfo.externalAdReply/utm if present
        ▼
SQLite (better-sqlite3): sessions, events, leads, lead_stage_history, ad_spend, fanout
        │
        ├─ fan-out worker (idempotent per event_id, logged in `fanout`):
        │     Meta CAPI  Lead/Schedule  (action_source website|chat, fbc/fbp, sha256 phone, event_id)
        │     GA4 MP     generate_lead / qualify_lead / close_* (client_id + session_id + engagement_time_msec)
        │     Snap CAPI  SIGN_UP (sc_click_id, sc_cookie1)      [later]
        │     TikTok     SubmitForm (ttclid, ttp)               [later]
        │     Google Ads gclid/gbraid CSV export (monthly)      [manual]
        │
        └─ /dashboard (server-rendered, Chart.js) + /v1/stats JSON  ── Cloudflare Access OTP ──▶ owner's phone/laptop
              views: sources→leads (first vs last touch), listing funnel, pipeline & response time, match quality, daily strip
```

## (b) Attribution "session bundle" JSON
```json
{
  "v": 1,
  "anon_id": "9f1c…32hex",
  "created": 1757140000000,
  "session": { "id": "mf3k2a-7b1c", "ref": "K7Q2X", "start": 1757149000000, "last_seen": 1757149600000, "pages": 4 },
  "first": {
    "ts": 1757140000000, "landing": "/listings/bona-w003/?utm_source=meta&utm_medium=paid&utm_campaign=villas_sep&utm_content=instagram_reels&utm_id=1203456789&fbclid=IwAR…",
    "referrer": "https://l.instagram.com/",
    "utm_source": "meta", "utm_medium": "paid", "utm_campaign": "villas_sep", "utm_content": "instagram_reels", "utm_term": null, "utm_id": "1203456789",
    "click_ids": { "fbclid": "IwAR…" }
  },
  "last": {
    "ts": 1757149000000, "landing": "/", "referrer": "https://www.google.com/",
    "utm_source": "google.com", "utm_medium": "social_or_organic", "click_ids": {}
  },
  "fbp": "fb.1.1757140000000.1234567890",
  "fbc": "fb.1.1757140000000.IwAR…",
  "ga":  { "client_id": "1234567890.1757140000", "session_id": "1757149000" },
  "scid": null, "ttp": null,
  "server": { "ip": "…", "ua": "…", "country": "SA", "received": 1757149600123 }
}
```
(`server.*` is appended by bona-api from headers on receipt; the site never sees it.)

## (c) Top pitfalls
1. **CTWA and business-messaging CAPI need a WhatsApp Business account/WABA** — on the personal number, every ad goes to the site; if the owner later converts to the WhatsApp Business *app*, CTWA becomes possible and Baileys still pairs, but `ctwa_clid` remains internal-only (no CAPI), and Cloud-API *Coexistence* would break Baileys decryption.
2. **Client-side storage is short-lived and GitHub Pages cannot set headers** — Safari deletes script-written localStorage/cookies after 7 days without a visit; no `Set-Cookie`, no CSP header (use `<meta http-equiv="Content-Security-Policy">` and allow `connect-src https://bona-api.azoz.uk`). The ref line in the WhatsApp text and the server-side `sessions.ref` map are the durable link; optional same-site `Set-Cookie` from bona-api extends life.
3. **Evolution polling quirks** — `fromMe:false` filter is ignored (falsy), time filter needs both `gte` and `lte`, ad-origin and privacy-mode chats arrive as `…@lid` with null `pushName` (use `remoteJidAlt`, keep both JIDs), older builds stripped `contextInfo` in `findMessages`, and `extendedTextMessage` is flattened into `message.conversation`. Dedupe by `key.id`; never trust the poller as the only lead intake (Retell + owner manual entry are the safety net).
4. **Ad-platform payload rules** — Meta website events need `client_user_agent` + `event_source_url`; `event_id` dedupe only works inside 48 h; `event_time` ≤ 7 days; phone hash = country code, no `+`, no leading zero (`9665…`), TikTok wants `+966…`; `fbc` needs a 13-digit ms timestamp and the untouched fbclid; iOS 17 LTP strips `fbclid/gclid` in Mail/Messages/Private Browsing, so always carry `utm_id={{campaign.id}}` too; GA4 MP must reuse `client_id` + `session_id` within 72 h or the lead lands in "unassigned".
5. **Consent and PDPL** — Consent Mode v2 defaults must be "denied" only for EEA/UK visitors (use the `region` array; a global denial cripples Google Ads for Saudi traffic for no legal reason); PDPL allows transfers with safeguards but expects a documented risk assessment, so keep raw phone numbers/chat text on the WSL box, send only hashed/pseudonymous identifiers to ad platforms, and keep the lead dashboard private (Cloudflare Access), never on the public static site.
