// services/api/test/wa.test.mjs: the owner identity and the instance's own number (2026-11-19, design §11)
import test from 'node:test';
import assert from 'node:assert/strict';
import { waConfig, sendText, DEFAULT_OWNER_JID } from '../lib/wa.mjs';

const OWNER = '966593296933@s.whatsapp.net';
const BONA = '966576267694@s.whatsapp.net';

test('unset or blank BONA_WA_INSTANCE_JID: the instance is the owner\'s own number, as before the split', () => {
  for (const env of [{}, { BONA_WA_INSTANCE_JID: '' }, { BONA_WA_INSTANCE_JID: '   ' }, { BONA_OWNER_JID: OWNER }]) {
    const cfg = waConfig(env);
    assert.equal(cfg.ownerJid, env.BONA_OWNER_JID ?? DEFAULT_OWNER_JID);
    assert.equal(cfg.instanceJid, cfg.ownerJid);
    assert.equal(cfg.ownNumberFrom, 'owner');
  }
});

test('set: the instance has its own number and the owner keeps his', () => {
  const cfg = waConfig({ BONA_WA_INSTANCE: 'bona', BONA_OWNER_JID: OWNER, BONA_WA_INSTANCE_JID: ` ${BONA} ` });
  assert.equal(cfg.instance, 'bona');
  assert.equal(cfg.ownerJid, OWNER);
  assert.equal(cfg.instanceJid, BONA, 'trimmed');
  assert.equal(cfg.ownNumberFrom, 'instance');
});

test('a lead note still goes to the owner\'s personal number, now sent from the Bona instance', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 201 }; };
  const env = { EVOLUTION_API_URL: 'http://evo.test/', EVOLUTION_API_KEY: 'k', BONA_WA_INSTANCE: 'bona', BONA_OWNER_JID: OWNER, BONA_WA_INSTANCE_JID: BONA };
  const res = await sendText('*Bona — new enquiry*', { env, fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://evo.test/message/sendText/bona');
  assert.equal(calls[0].body.number, '966593296933');
});
