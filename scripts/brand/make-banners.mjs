import { chromium } from 'playwright-core';
import fs from 'node:fs';
const ROOT = new URL('../../', import.meta.url).pathname;
const F = ROOT + 'public/fonts/';
const d = f => 'data:font/woff2;base64,' + fs.readFileSync(F + f).toString('base64');
const OUT = ROOT + 'marketing/brand/';

const FACES = `
@font-face{font-family:Cormorant;src:url('${d('cormorant-600.woff2')}') format('woff2');font-weight:600;font-display:block}
@font-face{font-family:Mont;src:url('${d('montserrat-400.woff2')}') format('woff2');font-weight:400;font-display:block}
@font-face{font-family:Mont;src:url('${d('montserrat-600.woff2')}') format('woff2');font-weight:600;font-display:block}
@font-face{font-family:Amiri;src:url('${d('amiri-700.woff2')}') format('woff2');font-weight:700;font-display:block}
@font-face{font-family:PlexAr;src:url('${d('plex-arabic-400.woff2')}') format('woff2');font-weight:400;font-display:block}`;

const BASE = `${FACES}
*{margin:0;padding:0;box-sizing:border-box}
html,body{background:#f5f1ea}
.canvas{position:relative;background:#f5f1ea;overflow:hidden;display:flex;align-items:center;justify-content:center}
.frame{position:absolute;border:1px solid #ddd0b8}
.wm{font-family:Cormorant,serif;font-weight:600;color:#0f1214;line-height:1;white-space:nowrap}
.rule{background:#c8a96a;margin:0 auto}
.lbl{font-family:Mont,sans-serif;font-weight:400;color:#3a3a38;text-transform:uppercase;white-space:nowrap}
.ar{font-family:Amiri,serif;font-weight:700;color:#0f1214;direction:rtl}
.meta{font-family:Mont,sans-serif;font-weight:400;color:#6f6a62;white-space:nowrap}
.stack{display:flex;flex-direction:column;align-items:center;text-align:center}
.safe{position:absolute;border:2px dashed rgba(255,0,0,.55)}`;

// {name, w, h, html, safe?:[x,y,w,h]}
const specs = [
  { name:'youtube-banner-2560x1440', w:2560, h:1440,
    frame:'left:120px;top:120px;right:120px;bottom:120px;',
    safe:[507,508,1546,424],
    body:`<div class="stack">
      <div class="wm" style="font-size:124px;letter-spacing:.30em;text-indent:.30em">BONA</div>
      <div class="rule" style="width:160px;height:2px;margin-top:30px"></div>
      <div class="lbl" style="font-size:25px;letter-spacing:.34em;text-indent:.34em;margin-top:28px">Private Luxury Real Estate &nbsp;·&nbsp; Jeddah</div>
      <div class="ar" style="font-size:38px;margin-top:20px">بونا</div>
      <div class="meta" style="font-size:20px;letter-spacing:.14em;margin-top:24px">bona-real-estate.com &nbsp;·&nbsp; REGA FAL 1100313556</div>
    </div>` },
  { name:'x-header-1500x500', w:1500, h:500,
    frame:'left:44px;top:40px;right:44px;bottom:40px;',
    safe:[0,320,300,180],
    body:`<div class="stack" style="transform:translateY(-26px)">
      <div class="wm" style="font-size:104px;letter-spacing:.30em;text-indent:.30em">BONA</div>
      <div class="rule" style="width:140px;height:2px;margin-top:26px"></div>
      <div class="lbl" style="font-size:21px;letter-spacing:.34em;text-indent:.34em;margin-top:24px">Private Luxury Real Estate &nbsp;·&nbsp; Jeddah</div>
      <div class="meta" style="font-size:17px;letter-spacing:.14em;margin-top:18px">REGA FAL 1100313556</div>
    </div>` },
  { name:'linkedin-cover-1128x191', w:1128, h:191,
    frame:'left:0;top:0;right:0;bottom:0;border:none;',
    safe:[0,0,300,191],
    body:`<div style="position:absolute;left:340px;top:0;right:56px;height:100%;display:flex;flex-direction:column;justify-content:center;align-items:flex-start">
      <div class="wm" style="font-size:52px;letter-spacing:.30em;text-indent:.30em">BONA</div>
      <div class="rule" style="width:88px;height:2px;margin:14px 0 0 4px"></div>
      <div class="lbl" style="font-size:14px;letter-spacing:.30em;text-indent:.30em;margin-top:14px">Private Luxury Real Estate &nbsp;·&nbsp; Jeddah &nbsp;·&nbsp; FAL 1100313556</div>
    </div>
    <div style="position:absolute;right:0;top:0;width:6px;height:100%;background:#c8a96a"></div>` },
  { name:'snapchat-hero-1080x1920', w:1080, h:1920,
    frame:'left:64px;top:64px;right:64px;bottom:64px;',
    safe:[0,0,1080,300],
    body:`<div class="stack" style="transform:translateY(-40px)">
      <div class="wm" style="font-size:132px;letter-spacing:.30em;text-indent:.30em">BONA</div>
      <div class="rule" style="width:170px;height:2px;margin-top:40px"></div>
      <div class="ar" style="font-size:62px;margin-top:44px">بونا</div>
      <div class="lbl" style="font-size:25px;letter-spacing:.26em;text-indent:.26em;margin-top:52px">Private Luxury Real Estate</div>
      <div class="lbl" style="font-size:25px;letter-spacing:.26em;text-indent:.26em;margin-top:16px">Jeddah</div>
      <div class="rule" style="width:60px;height:1px;margin-top:56px"></div>
      <div class="meta" style="font-size:22px;letter-spacing:.12em;margin-top:56px">bona-real-estate.com</div>
      <div class="meta" style="font-size:22px;letter-spacing:.12em;margin-top:14px">REGA FAL 1100313556</div>
    </div>` },
];

const showSafe = process.argv.includes('--safe');
const b = await chromium.connectOverCDP('http://localhost:9222');
const ctx = b.contexts()[0] || await b.newContext();
const p = await ctx.newPage();
for (const s of specs) {
  const safeDiv = (showSafe && s.safe) ? `<div class="safe" style="left:${s.safe[0]}px;top:${s.safe[1]}px;width:${s.safe[2]}px;height:${s.safe[3]}px"></div>` : '';
  const html = `<style>${BASE}</style><div class="canvas" style="width:${s.w}px;height:${s.h}px">
    <div class="frame" style="${s.frame}"></div>${s.body}${safeDiv}</div>`;
  await p.setViewportSize({ width: s.w, height: s.h });
  await p.setContent(html, { waitUntil: 'load' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(400);
  const file = OUT + s.name + (showSafe ? '.SAFECHECK.png' : '.png');
  await p.locator('.canvas').screenshot({ path: file });
  console.log('wrote', file);
}
await p.close().catch(()=>{});
process.exit(0);
