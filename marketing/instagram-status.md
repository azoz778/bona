# Instagram @bona.com.sa — status (2026-09-05 22:30 KSA)

- **Login**: done from a dedicated Chrome profile on this PC (`C:\Users\ASUS\AppData\Local\cc-chrome-bona`, CDP port 9223, start with the scratch `chrome-bona.sh`). Email code was read from the owner's Gmail (signed in on the shared Chrome). Session persists in that profile; credentials in `~/.secrets/bona-instagram.env` (600), never in the repo.
- **Account type**: switched to **Business**, category **Real Estate Agent** (shown on profile), contact info public (phone +966 59 329 6933).
- **Profile**: bio (bilingual, option 2), website https://bona.azoz.uk, profile photo (B monogram). Display name is edited in Accounts Center on the web — set it in the app: `Bona · Jeddah Luxury Real Estate`.
- **API posting**: the account is now a Business account. For `scripts/instagram-post.mjs` to publish it must still be linked to a Facebook Page inside a Meta Business the system-user token can see (Path A-i in `instagram-access.md`) — owner step, ~5 minutes in business.facebook.com. Until then posts go through the web UI (scratch `post.mjs`, human-paced).
- **Ad licences**: listing posts carry a REGA ad-licence placeholder; only brand/editorial posts are published until numbers exist.
