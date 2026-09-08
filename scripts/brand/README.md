# Brand art generators

Regenerate the social profile art in `marketing/brand/`.

```sh
# avatars (320/400/800, light + dark) — needs the repo's own sharp
node scripts/brand/make-avatars.mjs

# banners (YouTube, X, LinkedIn, Snapchat) — renders in the CDP Chrome
~/.claude/scripts/chrome-debug.sh          # start headless Chrome on :9222
cd ~/.claude/scripts && node <path-to>/make-banners.mjs
node scripts/brand/make-banners.mjs --safe # overlay red safe-area guides
```

`make-banners.mjs` needs `playwright-core`, which this repo does not depend on —
run it from a directory where `playwright-core` resolves (e.g. `~/.claude/scripts`),
or `npm i -D playwright-core` here first. It attaches to the already-running Chrome
over CDP and needs no browser binary.

The avatar's `B` is the vector path from `public/favicon.svg`, so it stays crisp at
any size. Banners embed the real brand woff2 files from `public/fonts/` as data
URIs, so typography matches the site exactly.

**Safe areas** (verify with `--safe` before shipping a change):
YouTube 2560×1440 → 1546×423 centred · X 1500×500 → avoid bottom-left ~300×180
(avatar overlay) · LinkedIn 1128×191 → avoid left ~300px (logo overlay) ·
Snapchat 1080×1920 → avoid top ~300px.
