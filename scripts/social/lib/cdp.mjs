// Raw Chrome DevTools Protocol client for the shared, already-logged-in Windows Chrome on :9222.
//
// Why raw CDP and not Playwright: connectOverCDP enumerates and attaches to every open target,
// and on this Chrome (dozens of tabs owned by other sessions) it hangs. Here we talk to ONE tab
// that we opened ourselves (PUT /json/new) and close it at the end; other tabs are never touched.
// Node 22+ global WebSocket, no dependency.
//
// Chrome runs on Windows: a file handed to DOM.setFileInputFiles must be a Windows path. See
// stageForUpload() — media is copied to %LOCALAPPDATA%\bona-social-upload first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const CDP_BASE = process.env.BONA_CDP_URL || 'http://localhost:9222';
export const ENSURE_SCRIPT = process.env.BONA_CHROME_ENSURE || path.join(os.homedir(), '.claude/scripts/chrome-debug.sh');
/** WSL view and Windows view of the upload staging folder (the Windows Chrome reads the latter). */
export const UPLOAD_DIR_WSL = process.env.BONA_UPLOAD_DIR_WSL || '/mnt/c/Users/ASUS/AppData/Local/bona-social-upload';
export const UPLOAD_DIR_WIN = process.env.BONA_UPLOAD_DIR_WIN || 'C:\\Users\\ASUS\\AppData\\Local\\bona-social-upload';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

/** A stable error class so the publisher can tell "the browser is not there" from a page problem. */
export class BrowserError extends Error {
  constructor(kind, message) { super(message); this.name = 'BrowserError'; this.kind = kind; }
}

async function version(base, fetchImpl) {
  const r = await fetchImpl(`${base}/json/version`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
/** Chrome reachable, else start it with chrome-debug.sh (idempotent) and try once more. */
export async function ensureChrome({ base = CDP_BASE, fetchImpl = fetch, ensureScript = ENSURE_SCRIPT, spawn = spawnSync } = {}) {
  try { return await version(base, fetchImpl); } catch { /* start it below */ }
  if (ensureScript && fs.existsSync(ensureScript)) spawn('bash', [ensureScript], { stdio: 'ignore', timeout: 40_000 });
  for (let i = 0; i < 10; i++) {
    try { return await version(base, fetchImpl); } catch { await sleep(1000); }
  }
  throw new BrowserError('chrome-unreachable', `Chrome DevTools not reachable at ${base} (tried ${ensureScript}); start it with ~/.claude/scripts/chrome-debug.sh`);
}
export async function openTab(url, { base = CDP_BASE, fetchImpl = fetch } = {}) {
  const r = await fetchImpl(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT', signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new BrowserError('chrome-unreachable', `Could not open a tab (HTTP ${r.status})`);
  return r.json();
}
export async function closeTab(id, { base = CDP_BASE, fetchImpl = fetch } = {}) {
  try { await fetchImpl(`${base}/json/close/${id}`, { signal: AbortSignal.timeout(5000) }); } catch { /* best effort */ }
}

/**
 * One session on one target. ev() evaluates in the page's main world and returns by value.
 * Every helper is small on purpose: the page adapters (lib/browser-sites.mjs) compose them.
 */
export async function connect(target, { WebSocketImpl = globalThis.WebSocket } = {}) {
  const ws = new WebSocketImpl(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new BrowserError('chrome-unreachable', 'DevTools websocket failed')); });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = m => {
    const d = JSON.parse(typeof m.data === 'string' ? m.data : String(m.data));
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}, timeoutMs = 60_000) => new Promise((res, rej) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); rej(new BrowserError('timeout', `${method} timed out`)); }, timeoutMs);
    pending.set(id, d => { clearTimeout(timer); d.error ? rej(new Error(`${method}: ${JSON.stringify(d.error)}`)) : res(d.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const s = {
    send, ev,
    close: () => { try { ws.close(); } catch { /* closed */ } },
    async navigate(url) { await send('Page.enable'); await send('Page.navigate', { url }); await sleep(800); await s.waitFor('document.readyState === "complete"', 30_000); },
    async waitFor(cond, ms = 15_000, every = 400) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try { const v = await ev(cond); if (v) return v; } catch { /* page navigating */ }
        await sleep(every);
      }
      return null;
    },
    async viewport(width = 1400, height = 1000) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    },
    /** Click the centre of the element a JS expression returns (real mouse events, so React handlers fire). */
    async clickEl(expr) {
      const p = await ev(`(() => { const e = (${expr}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height, text: (e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,60) }; })()`);
      if (!p || !p.w) return null;
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
      return p;
    },
    /** Focus the element, then type as the keyboard would (Input.insertText fires beforeinput/input, which rich editors need). */
    async typeInto(expr, value, { clear = true } = {}) {
      const ok = await ev(`(() => { const e = (${expr}); if (!e) return false; e.scrollIntoView({block:'center'}); e.focus(); return true; })()`);
      if (!ok) return false;
      await s.clickEl(expr);
      if (clear) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
      }
      // One line at a time with a real Enter between, so editors make paragraphs instead of dropping "\n".
      const lines = String(value).split('\n');
      for (const [i, line] of lines.entries()) {
        if (line) await send('Input.insertText', { text: line });
        if (i < lines.length - 1) {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 /* shift: soft break, no submit */ });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8 });
        }
      }
      return true;
    },
    async key(key, code = key, vk = 0) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
    },
    /** DOM.setFileInputFiles on the <input type=file> a JS expression returns. Paths are Windows paths. */
    async setFiles(expr, files) {
      await send('DOM.enable');
      await send('DOM.getDocument', { depth: 0 });
      const r = await send('Runtime.evaluate', { expression: expr });
      if (!r.result?.objectId) return false;
      await send('DOM.setFileInputFiles', { objectId: r.result.objectId, files });
      return true;
    },
    async screenshot(file) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    text: (max = 6000) => ev(`(document.body?.innerText || '').slice(0, ${max})`),
    url: () => ev('location.href'),
  };
  return s;
}

/**
 * Copy local media to the Windows-reachable staging folder under a per-run name and return the
 * Windows paths. The run's own subfolder is removed by unstage().
 */
export function stageForUpload(files, runId, { wslDir = UPLOAD_DIR_WSL, winDir = UPLOAD_DIR_WIN } = {}) {
  const sub = String(runId).replace(/[^\w.-]+/g, '-');
  const dir = path.join(wslDir, sub);
  fs.mkdirSync(dir, { recursive: true });
  return files.map(f => {
    const name = path.basename(f);
    fs.copyFileSync(f, path.join(dir, name));
    return `${winDir}\\${sub}\\${name}`;
  });
}
export function unstage(runId, { wslDir = UPLOAD_DIR_WSL } = {}) {
  const sub = String(runId).replace(/[^\w.-]+/g, '-');
  fs.rmSync(path.join(wslDir, sub), { recursive: true, force: true });
}

/** Open our own tab, run fn(session), always close the tab. */
export async function withTab(url, fn, opts = {}) {
  await ensureChrome(opts);
  const target = await openTab('about:blank', opts);
  let s;
  try {
    s = await connect(target, opts);
    await s.viewport();
    await s.navigate(url);
    return await fn(s, target);
  } finally {
    s?.close();
    if (!opts.keepTab) await closeTab(target.id, opts);
  }
}
