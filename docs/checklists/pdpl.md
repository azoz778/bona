# PDPL — what is live, what you still register, how to behave

Saudi Personal Data Protection Law (PDPL), in force since 14 Sep 2023, enforced by
SDAIA since 14 Sep 2024. Bona is a *controller* for visitor, enquiry and call data.
Research: `docs/research/2026-09-06-saudi-re-acquisition-research.md` §2.

## 1. What is already live (agent-built)

| Requirement | What Bona does |
|---|---|
| Notice before collection (Art. 12) | https://bona.azoz.uk/privacy/ (AR authoritative + EN): who we are, what is collected, WhatsApp, the AI concierge, legal basis, retention, recipients (Google, Meta, Snap, Retell, WhatsApp/Meta, Cloudflare, GitHub), the internal dashboard, transfers outside KSA, rights, security |
| Consent for non-essential cookies/pixels | consent banner (AR/EN) with **analytics** and **advertising** categories; GA4 / Meta Pixel / Snap Pixel load only after the matching category is allowed; decline = no third-party tags, session-scoped id only; choice stored and re-editable from the footer link |
| Data minimisation towards ad platforms | only **hashed** phone / pseudonymous ids reach Meta and Snap; GA4 receives no names or phone numbers; ad-platform events are sent only for sessions that allowed *advertising* |
| Data residency | names, phone numbers, enquiry text, transcripts stay in `~/bona-data/bona.db` (mode 0600) on this PC in Jeddah; the public site holds nothing personal |
| WhatsApp reading | the poller keeps **only** messages that match a Bona Ref code, a known lead, a Bona keyword or an ad context; everything else is discarded in memory and never written |
| AI + recording disclosure | Dana's first sentence on every call: *"This is Dana, Bona's AI concierge. This call is recorded to handle your enquiry."* / *"معك دانة، المساعدة الذكية لبونا. هذه المكالمة مسجّلة لمتابعة طلبك."* — live after `node services/api/retell/provision.mjs`. The chat panel shows *"Conversations are stored to serve your enquiry · Privacy"* |
| Private dashboard | not on the public site; login by a one-time code to your WhatsApp; HttpOnly cookie; no PII leaves the PC |
| Transfer risk assessment | `docs/compliance/pdpl-transfer-risk-assessment.md` (one page, review every 6 months) |

## 2. Register as a controller on NDGP (owner, ~20 min, free)

The 2025 amendments make **cross-border transfers** a registration trigger; with GA4,
Meta, Snap and Retell in the US, register.

1. https://dgp.sdaia.gov.sa → **المنصة الوطنية لحوكمة البيانات (National Data Governance
   Platform)** → **تسجيل الدخول** with **Nafath**.
2. **السجل الوطني لجهات التحكم** (National Register of Controllers) → **تسجيل جهة
   تحكم جديدة** (Register a new controller).
3. Entity type: until Bona has a CR, register as an **individual establishment /
   natural person** under your name with the FAL licence 1100313556 as the activity
   licence; re-register (or update) in the CR's name once it exists.
4. Contact: you as the data-protection contact (**مسؤول حماية البيانات**), email
   bona.com.sa@gmail.com, phone +966 59 329 6933.
5. **Processing activities** (أنشطة المعالجة) — add three:
   - *Website analytics and advertising measurement* — categories: identifiers,
     device/usage data; basis: consent; recipients: Google, Meta, Snap; transfer: yes.
   - *Enquiry and lead management (WhatsApp, forms, AI concierge)* — categories:
     name, phone, enquiry content, call recordings/transcripts; basis: contract /
     legitimate interest for the enquiry, consent for marketing; recipients: Retell
     (concierge), WhatsApp/Meta (messaging), Cloudflare (transport); transfer: yes.
   - *Property marketing to opted-in contacts* — basis: consent; opt-out on every
     message.
6. **Cross-border transfers** (النقل خارج المملكة): yes → purpose "service delivery
   and analytics", safeguard "contractual clauses with each provider + documented
   risk assessment" (attach `pdpl-transfer-risk-assessment.md` as PDF if the form
   allows).
7. Submit → keep the registration number in `~/.secrets/bona-services.env` as a
   comment or in the dashboard's Integrations notes. Labels on the portal change;
   the substance above is what the form asks for.

## 3. Rules of conduct (the ones that get brokers fined)

- **Marketing messages need prior opt-in** (Art. 25/26): no WhatsApp broadcasts, SMS
  or email blasts to numbers that only enquired once. Record the opt-in as a note on
  the lead ("agreed to receive new listings, 2026-09-07"). Every marketing message ends
  with an opt-out line (*للإيقاف أرسل "إيقاف"* / *Reply STOP to opt out*) and a
  request to stop is honoured the same day. Replies inside an active enquiry are
  service messages, not marketing.
- **Calls are announced**, never silently recorded; if a caller objects, Dana hands
  over to WhatsApp and the recording is deleted (ask the agent; Retell keeps audio
  per its retention setting — set it to the minimum in the Retell dashboard).
- **Rights requests** (access, correction, deletion, objection): answer within
  **30 days**. The dashboard's lead detail is the export; deletion = ask the agent to
  run the delete on `bona.db` and the JSONL logs, and to delete the Retell
  call/chat, then confirm to the person in writing.
- **Breach = 72 hours**: a lost laptop, a leaked token, a wrong recipient. Steps:
  (1) stop it — rotate the token / lock the device; (2) tell the agent to assess
  scope from the logs; (3) notify SDAIA through NDGP (**الإبلاغ عن حادثة**) within
  72 h of knowing; (4) notify the affected people without undue delay when the risk
  to them is real; (5) write it up in `docs/compliance/` .
- **Retention**: events 13 months; a lead while the enquiry is live, then 3 years
  (contract/dispute window); call recordings only as long as needed to handle the
  enquiry. The agent runs the purge; the policy text on /privacy/ says the same.
- **Do not** collect ID numbers, IBANs or deeds over WhatsApp before a contract
  exists; Dana never asks for them (prompt rule 7).
- **Children**: the site is not for under-18s; no targeting under 18 in any ad platform.

## 4. When something changes

Update `/privacy/` (agent, `src/data/privacy.json`) **and** the risk assessment when a
recipient is added (TikTok, a CRM, an email provider), when the CR arrives (controller
name), or at the 6-month review date on the assessment.
