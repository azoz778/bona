// Response shapes here are copied verbatim from the live instance `abdulaziz-personal`
// (verified 2026-09-05). If Evolution changes them, these tests fail before production does.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bareJid, createEvolutionClient, documentOf, fileLengthOf, isFromOwner, isOwnerGroup, textOf, unwrapMessage } from '../lib/evolution.mjs';

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
    assert.equal(groups[1].id, '120363999999999999@g.us');
    assert.equal(groups[1].subject, 'Bona Listings');
    assert.equal(groups[1].size, 1);
    // Finding 9: the owner fields must survive — the venue check needs them.
    assert.ok('owner' in groups[1] && 'subjectOwner' in groups[1]);
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

// Finding 9 — the venue. A message is only acted on when BOTH the group and the author are
// the owner's, and Baileys' wrappers must not be able to hide either from us.
describe('venue check — only the owner\'s own groups', () => {
  const OWNER = '966593296933@s.whatsapp.net';

  it('trusts a group the owner created', () => {
    assert.equal(isOwnerGroup({ id: 'g@g.us', subject: 'Bona Listings', owner: OWNER }, OWNER), true);
  });

  it('trusts a group whose subject the owner last set', () => {
    assert.equal(isOwnerGroup({ subject: 'Bona', owner: '966500000000@s.whatsapp.net', subjectOwner: '966593296933:7@s.whatsapp.net' }, OWNER), true);
  });

  it('refuses a stranger\'s group however it is named', () => {
    assert.equal(isOwnerGroup({ subject: 'Bona Listings', owner: '966500000000@s.whatsapp.net' }, OWNER), false);
  });

  it('fails closed when the API reports no owner at all', () => {
    assert.equal(isOwnerGroup({ subject: 'Bona Listings' }, OWNER), false);
    assert.equal(isOwnerGroup({ owner: null, subjectOwner: null }, OWNER), false);
    assert.equal(isOwnerGroup({ owner: OWNER }, ''), false);
  });

  it('compares the bare number, so a device suffix or a lid domain does not matter', () => {
    assert.equal(bareJid('966593296933:41@s.whatsapp.net'), '966593296933');
    assert.equal(bareJid('966593296933@lid'), '966593296933');
    assert.equal(bareJid(undefined), '');
  });
});

describe('message unwrapping — ephemeral and view-once', () => {
  const doc = { mimetype: 'application/pdf', fileName: 'villa.pdf', caption: 'rent' };

  it('sees a PDF inside an ephemeralMessage', () => {
    const record = { key: { id: '1', fromMe: true }, message: { ephemeralMessage: { message: { documentMessage: doc } } } };
    assert.equal(documentOf(record).fileName, 'villa.pdf');
    assert.equal(textOf(record), 'rent');
  });

  it('sees a PDF inside viewOnceMessageV2 wrapped in an ephemeralMessage', () => {
    const record = { key: { id: '1', fromMe: true }, message: { ephemeralMessage: { message: { viewOnceMessageV2: { message: { documentWithCaptionMessage: { message: { documentMessage: doc } } } } } } } };
    assert.equal(documentOf(record).mimetype, 'application/pdf');
    assert.equal(textOf(record), 'rent');
  });

  it('sees a command inside a disappearing text message', () => {
    const record = { message: { ephemeralMessage: { message: { extendedTextMessage: { text: 'remove BONA-W001' } } } } };
    assert.equal(textOf(record), 'remove BONA-W001');
  });

  it('does not loop on a self-referential wrapper', () => {
    const m = {};
    m.ephemeralMessage = { message: m };
    assert.doesNotThrow(() => unwrapMessage(m));
  });
});

describe('owner-only filter — LID groups', () => {
  const OWNER = '966593296933@s.whatsapp.net';

  it('accepts participantAlt when the participant is an opaque lid', () => {
    const record = { key: { id: '1', fromMe: false, participant: '18927349827349@lid', participantAlt: OWNER } };
    assert.equal(isFromOwner(record, OWNER), true);
  });

  it('accepts senderPn', () => {
    assert.equal(isFromOwner({ key: { id: '1' }, senderPn: '966593296933@s.whatsapp.net' }, OWNER), true);
  });

  it('still refuses a stranger in a lid group', () => {
    const record = { key: { id: '1', participant: '18927349827349@lid', participantAlt: '966500000000@s.whatsapp.net' } };
    assert.equal(isFromOwner(record, OWNER), false);
  });

  it('refuses when nothing identifies the sender', () => {
    assert.equal(isFromOwner({ key: { id: '1', participant: '18927349827349@lid' } }, OWNER), false);
  });
});
