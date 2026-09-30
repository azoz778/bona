/**
 * The dashboard's static files (design §5, P3-2): a fixed map from URL to a file read once
 * at start. No part of a request's path ever reaches the filesystem. They are public — a
 * manifest is fetched without cookies, and a browser re-checks the service worker whether
 * or not its member is still signed in — and hold nothing private.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
const JS = 'text/javascript; charset=utf-8';
const FILES = [
  ['/dashboard/sw.js', 'sw.js', JS],
  ['/dashboard/app.js', 'app.js', JS],
  // The manifest's `scope` is `/dashboard` with no trailing slash (a manifest cannot hold
  // this comment): the overview lives at `/dashboard` itself and every login lands there,
  // and a `/dashboard/` scope would open it out of scope — on an iPhone that is a second
  // login in a browser sheet. `id` and `start_url` keep their own values.
  ['/dashboard/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['/dashboard/icon-192.png', 'icon-192.png', 'image/png'],
  ['/dashboard/icon-512.png', 'icon-512.png', 'image/png'],
  ['/dashboard/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
];

/** URL path → { body: Buffer, type } */
export const ASSETS = new Map(FILES.map(([url, file, type]) => [url, { body: fs.readFileSync(path.join(DIR, file)), type }]));
