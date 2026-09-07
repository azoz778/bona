import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseArgs, desiredRecords, diffRecords, patchSiteJson, patchAstroConfig, patchRobots, patchCors,
  patchTunnelConfig, tunnelIdFrom, redirectRule, GITHUB_PAGES_A, GITHUB_PAGES_AAAA,
} from '../domain-cutover.mjs';

test('parseArgs: domain and api are required, api must be one label under the domain', () => {
  const o = parseArgs(['--domain', 'bona.sa', '--api', 'api.bona.sa', '--dry-run']);
  assert.equal(o.apiLabel, 'api');
  assert.equal(o.dryRun, true);
  assert.throws(() => parseArgs(['--api', 'api.bona.sa']), /--domain/);
  assert.throws(() => parseArgs(['--domain', 'bona.sa', '--api', 'api.other.sa']), /under bona\.sa/);
  assert.throws(() => parseArgs(['--domain', 'bona.sa', '--api', 'a.b.bona.sa']), /one label/);
  assert.throws(() => parseArgs(['--domain', 'bona.sa', '--api', 'api.bona.sa', '--only', 'nope']), /unknown step/);
  assert.equal(parseArgs(['--domain', 'bona.sa', '--api', 'api.bona.sa', '--offline']).offline, true);
});

test('desiredRecords: 4 A + 4 AAAA at the apex (DNS-only), www CNAME, proxied api CNAME to the tunnel', () => {
  const recs = desiredRecords('bona.sa', 'api', 'abc-123');
  assert.equal(recs.filter((r) => r.type === 'A').length, 4);
  assert.equal(recs.filter((r) => r.type === 'AAAA').length, 4);
  assert.deepEqual(recs.filter((r) => r.type === 'A').map((r) => r.content), GITHUB_PAGES_A);
  assert.deepEqual(recs.filter((r) => r.type === 'AAAA').map((r) => r.content), GITHUB_PAGES_AAAA);
  assert.ok(recs.every((r) => r.type !== 'CNAME' ? r.proxied === false : true));
  assert.deepEqual(recs.find((r) => r.name === 'www.bona.sa'), { type: 'CNAME', name: 'www.bona.sa', content: 'azoz778.github.io', proxied: false });
  assert.deepEqual(recs.find((r) => r.name === 'api.bona.sa'), { type: 'CNAME', name: 'api.bona.sa', content: 'abc-123.cfargotunnel.com', proxied: true });
});

test('diffRecords: keeps matches, creates the rest, updates a wrong CNAME, deletes a foreign apex A', () => {
  const desired = desiredRecords('bona.sa', 'api', 'abc-123');
  const existing = [
    { id: '1', type: 'A', name: 'bona.sa', content: '185.199.108.153', proxied: false },
    { id: '2', type: 'A', name: 'bona.sa', content: '1.2.3.4', proxied: true },            // registrar parking page → delete
    { id: '3', type: 'CNAME', name: 'api.bona.sa', content: 'old.cfargotunnel.com', proxied: true }, // wrong tunnel → update
    { id: '4', type: 'CNAME', name: 'www.bona.sa', content: 'azoz778.github.io', proxied: true },     // right target, wrongly proxied → update
    { id: '5', type: 'MX', name: 'bona.sa', content: 'mail.example', proxied: false },     // untouched
  ];
  const d = diffRecords(existing, desired);
  assert.deepEqual(d.keep.map((k) => k.id), ['1']);
  assert.equal(d.create.length, 3 + 4, 'three more A and four AAAA');
  assert.deepEqual(d.update.map((u) => [u.id, u.content, u.proxied]), [['4', 'azoz778.github.io', false], ['3', 'abc-123.cfargotunnel.com', true]]);
  assert.deepEqual(d.remove.map((r) => r.id), ['2']);
  assert.deepEqual(diffRecords(desired.map((r, i) => ({ id: String(i), ...r })), desired).create, [], 'a complete zone needs nothing');
});

test('patchSiteJson rewrites url, futureDomain and apiBase in place and keeps the formatting', () => {
  const text = [
    '{',
    '  "name": "Bona",',
    '  "url": "https://bona.azoz.uk",',
    '  "futureDomain": "bona.com.sa",',
    '  "concierge": { "enabled": true, "apiBase": "https://bona-api.azoz.uk", "name": { "en": "Dana" } },',
    '  "analytics": { "ga4": null }',
    '}',
    '',
  ].join('\n');
  const out = patchSiteJson(text, 'bona.sa', 'api.bona.sa');
  const j = JSON.parse(out);
  assert.equal(j.url, 'https://bona.sa');
  assert.equal(j.futureDomain, 'bona.sa');
  assert.equal(j.concierge.apiBase, 'https://api.bona.sa');
  assert.ok(out.includes('"concierge": { "enabled": true, "apiBase": "https://api.bona.sa", "name": { "en": "Dana" } },'), 'one-line objects stay one line');
  assert.equal(patchSiteJson(out, 'bona.sa', 'api.bona.sa'), out, 'idempotent');
});

test('astro config, robots and CORS patches', () => {
  assert.equal(patchAstroConfig("export default defineConfig({\n  site: 'https://bona.azoz.uk',\n", 'bona.sa'), "export default defineConfig({\n  site: 'https://bona.sa',\n");
  const robots = '# Bona\n# https://bona.azoz.uk (future: https://bona.com.sa)\n\nSitemap: https://bona.azoz.uk/sitemap-index.xml\n';
  assert.equal(patchRobots(robots, 'bona.sa'), '# Bona\n# https://bona.sa\n\nSitemap: https://bona.sa/sitemap-index.xml\n');
  const cors = "export const DEFAULT_ORIGINS = [\n  'https://bona.azoz.uk',\n  'https://azoz778.github.io',\n];\n";
  const patched = patchCors(cors, 'bona.sa');
  assert.equal(patched, "export const DEFAULT_ORIGINS = [\n  'https://bona.azoz.uk',\n  'https://bona.sa',\n  'https://www.bona.sa',\n  'https://azoz778.github.io',\n];\n");
  assert.equal(patchCors(patched, 'bona.sa'), patched, 'idempotent');
});

test('tunnel config: the new host goes first, the old host stays, idempotent; tunnel id is parsed', () => {
  const yml = [
    '# Managed by services/deploy/install.sh',
    'tunnel: 9022fbec-de4f-44b9-805e-8fff285d6263',
    'credentials-file: /home/x/.cloudflared/9022fbec-de4f-44b9-805e-8fff285d6263.json',
    '',
    'ingress:',
    '  - hostname: bona-api.azoz.uk',
    '    service: http://localhost:4102',
    '    originRequest:',
    '      connectTimeout: 10s',
    '      noTLSVerify: false',
    '  - service: http_status:404',
    '',
  ].join('\n');
  assert.equal(tunnelIdFrom(yml), '9022fbec-de4f-44b9-805e-8fff285d6263');
  const out = patchTunnelConfig(yml, 'api.bona.sa');
  const hosts = [...out.matchAll(/- hostname: (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(hosts, ['api.bona.sa', 'bona-api.azoz.uk']);
  assert.equal((out.match(/service: http:\/\/localhost:4102/g) ?? []).length, 2);
  assert.ok(out.endsWith('  - service: http_status:404\n'), 'catch-all stays last');
  assert.equal(patchTunnelConfig(out, 'api.bona.sa'), out, 'idempotent');
  assert.throws(() => patchTunnelConfig('ingress:\n  - service: http_status:404\n', 'api.bona.sa'), /not found/);
});

test('redirect rule: 301 from the old host to the new domain, path and query preserved', () => {
  const r = redirectRule('bona.azoz.uk', 'bona.sa');
  assert.equal(r.expression, '(http.host eq "bona.azoz.uk")');
  assert.equal(r.action, 'redirect');
  assert.equal(r.action_parameters.from_value.status_code, 301);
  assert.equal(r.action_parameters.from_value.target_url.expression, 'concat("https://bona.sa", http.request.uri.path)');
  assert.equal(r.action_parameters.from_value.preserve_query_string, true);
});
