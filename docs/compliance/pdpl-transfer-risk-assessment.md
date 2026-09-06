# PDPL cross-border transfer risk assessment — Bona (v1, 2026-09-06)

Prepared under the PDPL Transfer Regulations (Sept 2024) and SDAIA's risk-assessment
guideline (Feb 2025). One page; reviewed every six months or when a recipient changes.

| | |
|---|---|
| **Controller** | Abdulaziz Zidan, trading as **Bona** (بونا), Jeddah — REGA FAL 1100313556; CR pending. Contact: bona.com.sa@gmail.com · +966 59 329 6933 |
| **System of record** | `~/bona-data/bona.db` (SQLite, mode 0600) + JSONL logs on the owner's PC in Jeddah (KSA-resident). The public website (GitHub Pages) stores no personal data. |
| **Data subjects** | website visitors; people who enquire by WhatsApp, form, chat or call; property owners under brokerage contracts |
| **Review date** | **2027-03-06** (or earlier on any change) |

## Recipients outside KSA and what each receives

| Recipient (location) | Purpose | Data sent | Legal basis | Safeguards | Residual risk |
|---|---|---|---|---|---|
| **Google — GA4 + Measurement Protocol** (US/EU) | site analytics; `generate_lead` + stage events so paid search can optimise | pseudonymous client id, session id, page paths, event names; **no names, phones or message text**; IP not stored by GA4 | consent (analytics category) | Google Ads Data Processing Terms (SCC-equivalent); consent gate; no PII; 14-month retention in GA4 | **Low** |
| **Meta — Pixel + Conversions API** (US) | measure and optimise Instagram/Facebook ads | browser: pixel events after consent; server: `sha256(phone)`, `sha256(anon_id)`, `fbc/fbp`, IP + user agent of the click, page URL, listing id, event value on won deals | consent (advertising category) | Meta Data Processing Terms; hashing; events only for sessions with ad consent; test-events isolation; 48-h dedupe | **Low–medium** (hashed phone is still personal data; Meta is a controller for its own ads) |
| **Snap — Pixel + Conversions API v3** (US) | same as Meta for Snapchat | `sha256(phone)`, `sc_click_id`, `sc_cookie1`, IP + UA, page URL | consent (advertising) | Snap Data Processing Agreement; hashing; consent gate | **Low–medium** |
| **Retell AI** (US) | the AI concierge "Dana" — chat and voice | chat text, **call audio and transcripts**, name/phone if volunteered, page context, pseudonymous ids in metadata; leads are copied to the KSA store immediately | contract / legitimate interest (handling the enquiry); recording announced at call start | Retell DPA and security terms; recording disclosure in the first sentence; retention set to minimum in Retell; no ID/IBAN ever requested (prompt rule); transcripts also stored locally so Retell copies can be deleted | **Medium** — raw voice content leaves KSA; mitigated by disclosure, minimisation and short retention |
| **WhatsApp / Meta** (US, end-to-end encrypted transport) | the enquiry channel itself | message content between the person and the owner's number (the same as any WhatsApp use); Bona's poller reads only matched messages | contract / legitimate interest | WhatsApp terms; matched-only policy; no broadcast without opt-in | **Low** (inherent to the channel the person chose) |
| **Cloudflare** (global edge; KSA PoPs) | DNS, TLS, tunnel to bona-api | IP addresses and request metadata in transit; no storage of message content | legitimate interest (security, availability) | Cloudflare DPA; proxied only for the API host | **Low** |
| **GitHub** (US) | hosting the static site and the code repository | web-server access logs (IP, UA); **no personal data in the repository** (leads never committed) | legitimate interest | GitHub DPA; gitleaks pre-commit hooks | **Low** |

## Data categories, purposes, retention

| Category | Purpose | Kept |
|---|---|---|
| analytics events (pseudonymous ids, pages, UTMs, click ids) | measure which channel produced which enquiry | 13 months |
| lead record (name, phone, WhatsApp jid, interest, budget, notes, stage) | handle the enquiry, brokerage contract, dispute window | while the enquiry is live, then 3 years |
| first inbound message snippet (≤ 200 chars) | context for the owner's reply | with the lead |
| call recordings / transcripts, chat transcripts | handle the enquiry; quality of the concierge | as long as needed to handle the enquiry (Retell retention at minimum; local copy with the lead) |
| consent choices | prove consent | with the session (13 months) |

## Assessment

- **Necessity**: the transfers are for direct service to the data subject (the concierge,
  the messaging channel) or for the controller's operations (measuring paid channels) —
  the Regulations' permitted purposes. No adequacy list exists yet, so the basis is the
  contractual safeguards above plus this documented assessment.
- **Sensitive data**: none is collected by design (no ID numbers, financial data, health
  or religion); Dana is instructed never to ask for ID or IBAN.
- **Data subject impact**: low for analytics (pseudonymous); moderate for voice
  (identifiable by voice and content) — addressed by the announcement, the right to
  continue on WhatsApp instead, and minimum retention.
- **Overall residual risk: acceptable (low–medium)** with the safeguards in place.
- **Actions**: register on NDGP (`docs/checklists/pdpl.md` §2); set Retell recording
  retention to the minimum; re-assess when TikTok, a CRM or an email provider is added,
  and when the CR changes the controller's name.

Signed: Abdulaziz Zidan, 2026-09-06 · next review 2027-03-06
