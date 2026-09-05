// Response shapes here are copied verbatim from the live instance `abdulaziz-personal`
// (verified 2026-09-05). If Evolution changes them, these tests fail before production does.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEvolutionClient, documentOf, fileLengthOf, isFromOwner, textOf } from '../lib/evolution.mjs';

const OWNER = '966593296933@s.whatsapp.net';

const FIND_MESSAGES_RESPONSE = {
  messages: {
    total: 2,
    pages: 1,
    currentPage: 1,
    records: [
      {
        id: 'row-1',
        key: { id: 'ACE66B16B75CB0E144926A2D4B91EE3D', fromMe: true, remoteJid: '120363143519616993@g.us' },
        pushName: 'Owner',
        messageType: 'documentMessage',
        message: {
          documentMessage: {
            url: 'https://mmg.whatsapp.net/…',
            fileName: 'Kian-Residence-K.pdf',
            mimetype: 'application/pdf',
            pageCount: 27,
            fileLength: { low: 916537, high: 0, unsigned: true },
            caption: 'SAR 990,000 #brochure',
          },
          messageContextInfo: {},
        },
        messageTimestamp: 1788318317,
      },
      {
        id: 'row-2',
        key: { id: 'AC28789702AA1443F46BE5E14BBD1586', fromMe: true, remoteJid: '120363143519616993@g.us' },
        pushName: 'Owner',
        messageType: 'conversation',
        message: { conversation: 'hero BONA-W001 3', messageContextInfo: {} },
        messageTimestamp: 1788318145,
      },
    ],
  },
};

const FETCH_GROUPS_RESPONSE = [
  { id: '120363135705763548@g.us', subject: 'PDF', size: 1 },
  { id: '120363999999999999@g.us', subject: 'Bona Listings', size: 1 },
  { id: '120363407639570389@g.us', subject: 'Tk pdf', size: 3 },
];

const GET_BASE64_RESPONSE = {
  mediaType: 'documentMessage',
  fileName: 'Kian-Residence-K.pdf',
  size: { fileLength: { low: 9, high: 0, unsigned: true } },
  mimetype: 'application/pdf',
  base64: Buffer.from('%PDF-1.7\n').toString('base64'),
  buffer: null,
};

function stubFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    for (const [match, res] of routes) {
      if (url.includes(match)) {
        return { ok: res.status < 300, status: res.status, text: async () => JSON.stringify(res.body) };
      }
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
  return { impl, calls };
}

const client = (routes) => {
  const { impl, calls } = stubFetch(routes);
  return {
    calls,
    evo: createEvolutionClient({ baseUrl: 'https://wa-api.example/', apiKey: 'k', instance: 'abdulaziz-personal', fetchImpl: impl, retries: 1 }),
  };
};

describe('fetchAllGroups', () => {
  it('flattens the array shape the API returns', async () => {
    const { evo, calls } = client([['/group/fetchAllGroups/', { status: 200, body: FETCH_GROUPS_RESPONSE }]]);
    const groups = await evo.fetchAllGroups();
    assert.equal(groups.length, 3);
    assert.deepEqual(groups[1], { id: '120363999999999999@g.us', subject: 'Bona Listings', size: 1 });
    assert.match(calls[0].url, /getParticipants=false/);
    assert.equal(calls[0].method, 'GET');
  });
});

describe('findMessages', () => {
  it('unwraps { messages: { total, pages, records } } and sends the verified body', async () => {
    const { evo, calls } = client([['/chat/findMessages/', { status: 200, body: FIND_MESSAGES_RESPONSE }]]);
    const res = await evo.findMessages('120363143519616993@g.us', { pageSize: 30 });
    assert.equal(res.total, 2);
    assert.equal(res.records.length, 2);
    assert.deepEqual(calls[0].body, { where: { key: { remoteJid: '120363143519616993@g.us' } }, page: 1, offset: 30 });
  });
});

describe('downloadMedia', () => {
  it('accepts the 201 the API answers with and decodes base64', async () => {
    const { evo, calls } = client([['/chat/getBase64FromMediaMessage/', { status: 201, body: GET_BASE64_RESPONSE }]]);
    const media = await evo.downloadMedia({ id: 'ABC', remoteJid: 'x@g.us', fromMe: true });
    assert.equal(media.mimetype, 'application/pdf');
    assert.equal(media.buffer.subarray(0, 5).toString(), '%PDF-');
    assert.deepEqual(calls[0].body, { message: { key: { id: 'ABC', remoteJid: 'x@g.us', fromMe: true } }, convertToMp4: false });
  });

  it('fails loudly when there is no base64', async () => {
    const { evo } = client([['/chat/getBase64FromMediaMessage/', { status: 201, body: { mediaType: 'documentMessage' } }]]);
    await assert.rejects(() => evo.downloadMedia({ id: 'ABC' }), /no base64/);
  });
});

describe('sendText — the only write', () => {
  it('posts number + text', async () => {
    const { evo, calls } = client([['/message/sendText/', { status: 201, body: { key: { id: 'X' } } }]]);
    await evo.sendText('120363999999999999@g.us', 'hello');
    assert.deepEqual(calls[0].body, { number: '120363999999999999@g.us', text: 'hello', linkPreview: false, delay: 0 });
  });
});

describe('record helpers', () => {
  const [docRecord, textRecord] = FIND_MESSAGES_RESPONSE.messages.records;

  it('finds the document in both wrappers', () => {
    assert.equal(documentOf(docRecord).fileName, 'Kian-Residence-K.pdf');
    const wrapped = { message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: 'a.pdf' } } } } };
    assert.equal(documentOf(wrapped).fileName, 'a.pdf');
    assert.equal(documentOf({ message: { imageMessage: {} } }), null);
  });

  it('reads caption and conversation text', () => {
    assert.equal(textOf(docRecord), 'SAR 990,000 #brochure');
    assert.equal(textOf(textRecord), 'hero BONA-W001 3');
    assert.equal(textOf({ message: { extendedTextMessage: { text: 'help' } } }), 'help');
    assert.equal(textOf({}), '');
  });

  it('decodes the Baileys long fileLength', () => {
    assert.equal(fileLengthOf({ fileLength: { low: 916537, high: 0, unsigned: true } }), 916537);
    assert.equal(fileLengthOf({ fileLength: '4096' }), 4096);
    assert.equal(fileLengthOf({}), null);
  });
});

describe('owner-only filter', () => {
  it('accepts the owner\'s own messages', () => {
    assert.equal(isFromOwner({ key: { fromMe: true } }, OWNER), true);
    assert.equal(isFromOwner({ key: { fromMe: false, participant: OWNER } }, OWNER), true);
    assert.equal(isFromOwner({ key: { fromMe: false, participant: '966593296933:12@s.whatsapp.net' } }, OWNER), true, 'device suffix');
    assert.equal(isFromOwner({ key: { fromMe: false }, participant: OWNER }, OWNER), true);
  });

  it('refuses everyone else — a group member must never be able to publish', () => {
    assert.equal(isFromOwner({ key: { fromMe: false, participant: '966555555555@s.whatsapp.net' } }, OWNER), false);
    assert.equal(isFromOwner({ key: { fromMe: false } }, OWNER), false);
    assert.equal(isFromOwner({}, OWNER), false);
    assert.equal(isFromOwner({ key: { fromMe: 'true' } }, OWNER), false, 'only a real boolean counts');
  });
});
