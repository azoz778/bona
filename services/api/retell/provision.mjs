#!/usr/bin/env node
/**
 * Idempotent provisioning of the Retell objects behind Dana (دانة).
 *
 * Creates — or updates in place — four things and records their ids in `ids.json`
 * (committed; ids are not secret):
 *
 *   1. Knowledge base "Bona site"   ← https://bona.azoz.uk/llms-full.txt + /llms.txt
 *   2. Retell LLM "Bona Dana"       ← prompt.md, begin message, KB, 3 custom tools
 *   3. Voice agent "Bona Dana (voice)"
 *   4. Chat agent  "Bona Dana (chat)"
 *
 * WHY A SEPARATE CHAT AGENT: Retell models chat agents as their own object. The API
 * has `POST /create-chat-agent` / `PATCH /update-chat-agent/{id}` distinct from
 * `POST /create-agent`, agents expose a read-only `channel` field ("voice" on the
 * existing "Lisa" agent), and `POST /create-chat` takes "the chat agent to use for
 * the chat". A voice agent id is therefore not valid for `create-chat`. Both agents
 * share ONE Retell LLM, so the persona and tools stay in a single place.
 * Set BONA_RETELL_SEPARATE_CHAT_AGENT=0 to reuse the voice agent instead (kept as an
 * escape hatch in case Retell later accepts any agent for chat).
 *
 * Usage:
 *   node services/api/retell/provision.mjs --dry-run     # print payloads, call nothing
 *   node services/api/retell/provision.mjs               # create/update for real
 *   node services/api/retell/provision.mjs --publish     # also publish both agents
 *   node services/api/retell/provision.mjs --ensure-env  # only create ~/.secrets/bona-services.env
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv, ensureServicesEnv, randomToken } from '../lib/env.mjs';
import { readIds, writeIds, IDS_FILE } from '../lib/config.mjs';
import { createRetellClient, isClientError } from '../lib/retell.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROMPT_FILE = path.join(HERE, 'prompt.md');

export const KB_NAME = 'Bona site';
export const LLM_NAME = 'Bona Dana';
export const VOICE_AGENT_NAME = 'Bona Dana (voice)';
export const CHAT_AGENT_NAME = 'Bona Dana (chat)';

export const BEGIN_MESSAGE =
  'مرحباً، أنا دانة من بونا. كيف أقدر أساعدك؟ Hello, I’m Dana from Bona — how can I help?';

/** Models Retell accepts (retell-sdk 5.64.0 `LlmCreateParams.model`). */
export const PREFERRED_MODEL = 'claude-4.6-sonnet';
export const FALLBACK_MODEL = 'gpt-4.1';

/* ------------------------------------------------------------------ */
/* Payload builders (pure — unit-testable, printable with --dry-run)   */
/* ------------------------------------------------------------------ */

export function knowledgeBasePayload({ siteUrl }) {
  const base = String(siteUrl).replace(/\/+$/, '');
  return {
    knowledge_base_name: KB_NAME,
    knowledge_base_urls: [`${base}/llms-full.txt`, `${base}/llms.txt`],
    enable_auto_refresh: true,
  };
}

export function toolsPayload({ publicApi, toolToken }) {
  const url = (name) => `${String(publicApi).replace(/\/+$/, '')}/v1/tools/${name}?token=${toolToken}`;
  return [
    {
      type: 'custom',
      name: 'search_properties',
      url: url('search_properties'),
      description:
        "Search Bona's live inventory. Call this BEFORE answering anything about what is available, in which district, at what price, or how many bedrooms. Returns up to 5 real listings with their asking prices. If it returns nothing, say so honestly — never invent a property and never estimate a price.",
      speak_during_execution: true,
      speak_after_execution: true,
      execution_message_type: 'prompt',
      execution_message_description:
        "Say one short line that you are checking the portfolio, in the visitor's language, e.g. 'لحظة أشوف لك المتاح عندنا' or 'One moment — let me check what we have.'",
      timeout_ms: 10_000,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free text of what the visitor asked, in their own words (Arabic or English).' },
          kind: { type: 'string', enum: ['house', 'apartment', 'land', 'building'], description: 'Section of the site.' },
          district: { type: 'string', description: 'Neighbourhood or city, e.g. Al Khalidiyah, Al Shati, Obhur, الروضة, Jeddah, Riyadh.' },
          category: { type: 'string', enum: ['buy', 'rent', 'off-plan', 'international'], description: 'buy = for sale, rent = rental, off-plan = under construction, international = outside Saudi Arabia.' },
          minPrice: { type: 'string', description: 'Lowest budget as the visitor said it, e.g. "2m", "٣ ملايين", "1500000".' },
          maxPrice: { type: 'string', description: 'Highest budget as the visitor said it.' },
          beds: { type: 'integer', description: 'Minimum number of bedrooms.' },
        },
        required: [],
      },
    },
    {
      type: 'custom',
      name: 'show_property',
      url: url('show_property'),
      description:
        'Put one specific property on the visitor’s screen. Call this every time you name a property, using the id (e.g. BONA-005) or slug returned by search_properties. Call it once per property.',
      speak_during_execution: false,
      speak_after_execution: true,
      execution_message_type: 'prompt',
      timeout_ms: 10_000,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Listing id from search_properties, e.g. BONA-005.' },
          slug: { type: 'string', description: 'Listing slug from search_properties, if the id is not to hand.' },
        },
        required: [],
      },
    },
    {
      type: 'custom',
      name: 'create_lead',
      url: url('create_lead'),
      description:
        'Register the visitor as an enquiry for Bona. Call this as soon as they give a name or phone number, ask for a viewing, or ask to speak to someone. Confirm the phone number back to them once before calling.',
      speak_during_execution: false,
      speak_after_execution: true,
      timeout_ms: 15_000,
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Phone number in international form, e.g. +9665XXXXXXXX.' },
          name: { type: 'string', description: 'How the visitor introduced themselves.' },
          interest: { type: 'string', description: 'What they want: buy a villa in Al Shati, rent an apartment, sell their home, book a viewing…' },
          budget: { type: 'string', description: 'Budget exactly as they said it — never a number you inferred.' },
          timeline: { type: 'string', description: 'When they want to move or transact.' },
          district: { type: 'string', description: 'Preferred area.' },
          listing_id: { type: 'string', description: 'Listing id they asked about, if any.' },
          notes: { type: 'string', description: 'Anything else worth passing to the principal.' },
          language: { type: 'string', enum: ['ar', 'en'], description: 'Language to reply in.' },
        },
        required: ['phone'],
      },
    },
  ];
}

export function llmPayload({ prompt, model, knowledgeBaseIds, publicApi, toolToken }) {
  return {
    model,
    model_temperature: 0.3,
    general_prompt: prompt,
    begin_message: BEGIN_MESSAGE,
    start_speaker: 'agent',
    general_tools: toolsPayload({ publicApi, toolToken }),
    ...(knowledgeBaseIds?.length ? { knowledge_base_ids: knowledgeBaseIds } : {}),
    default_dynamic_variables: { locale: 'en', page_url: 'https://bona.azoz.uk/', page_title: 'Bona' },
  };
}

export function voiceAgentPayload({ llmId, publicApi, toolToken, voiceId = '11labs-Nyla' }) {
  return {
    agent_name: VOICE_AGENT_NAME,
    response_engine: { type: 'retell-llm', llm_id: llmId },
    voice_id: voiceId,
    voice_model: 'eleven_flash_v2_5',
    language: ['ar-SA', 'en-US'],
    responsiveness: 1,
    interruption_sensitivity: 0.8,
    enable_backchannel: true,
    end_call_after_silence_ms: 30_000,
    max_call_duration_ms: 900_000,
    webhook_url: `${String(publicApi).replace(/\/+$/, '')}/v1/retell/webhook?token=${toolToken}`,
    webhook_events: ['call_started', 'call_ended', 'call_analyzed'],
    post_call_analysis_model: 'gpt-4.1-mini',
  };
}

export function chatAgentPayload({ llmId, publicApi, toolToken }) {
  return {
    agent_name: CHAT_AGENT_NAME,
    response_engine: { type: 'retell-llm', llm_id: llmId },
    language: ['ar-SA', 'en-US'],
    end_chat_after_silence_ms: 3_600_000,
    webhook_url: `${String(publicApi).replace(/\/+$/, '')}/v1/retell/webhook?token=${toolToken}`,
    webhook_events: ['chat_started', 'chat_ended', 'chat_analyzed'],
    post_chat_analysis_model: 'gpt-4.1-mini',
  };
}

/** Replace the tool token with a placeholder so payloads can be printed safely. */
export function redactPayload(value, token) {
  if (!token) return value;
  return JSON.parse(JSON.stringify(value).split(token).join('<BONA_TOOL_TOKEN>'));
}

/* ------------------------------------------------------------------ */
/* Provisioning                                                        */
/* ------------------------------------------------------------------ */

const truthy = (v, fallback = false) => (v == null || v === '' ? fallback : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));

/** Create ~/.secrets/bona-services.env (or top up missing keys). Never prints values. */
export function ensureEnvFile({ home = os.homedir(), env = process.env } = {}) {
  const defaults = {
    BONA_WA_INSTANCE: 'abdulaziz-personal',
    BONA_OWNER_JID: '966593296933@s.whatsapp.net',
    BONA_WA_GROUP_MATCH: 'bona',
    BONA_REPO: path.join(home, 'bona-bot'),
    BONA_DATA: path.join(home, 'bona-data'),
    BONA_POLL_MS: '20000',
    BONA_CLAUDE_MODEL: 'sonnet',
    BONA_SITE: 'https://bona.azoz.uk',
    BONA_API_PORT: '4102',
    BONA_PUBLIC_API: 'https://api.bona.azoz.uk',
    BONA_TOOL_TOKEN: randomToken(16),
  };
  const result = ensureServicesEnv(defaults, { home });
  return { ...result, keys: Object.keys(defaults) };
}

async function findKnowledgeBase(client, name) {
  const list = await client.listKnowledgeBases();
  return (Array.isArray(list) ? list : []).find((kb) => kb.knowledge_base_name === name) ?? null;
}

/**
 * Create the LLM, retrying once with the fallback model if Retell rejects the
 * preferred one (4xx). Also used for updates.
 */
async function withModelFallback(fn, { preferred, fallback, log }) {
  try {
    return { result: await fn(preferred), model: preferred };
  } catch (err) {
    if (!isClientError(err) || preferred === fallback) throw err;
    log(`  ! model "${preferred}" rejected (${err.status}) — retrying with "${fallback}"`);
    return { result: await fn(fallback), model: fallback };
  }
}

export async function provision({ argv = [], env = loadEnv(), idsFile = IDS_FILE, log = console.log, clientFactory = createRetellClient } = {}) {
  const dryRun = argv.includes('--dry-run');
  const publish = argv.includes('--publish') || truthy(env.BONA_RETELL_PUBLISH, false);
  const separateChatAgent = truthy(env.BONA_RETELL_SEPARATE_CHAT_AGENT, true);

  const envInfo = ensureEnvFile({ env });
  if (envInfo.created) log(`~ created ${envInfo.file} (${envInfo.keys.length} keys, 0600) — values not printed`);
  else if (envInfo.added.length) log(`~ topped up ${envInfo.file} with: ${envInfo.added.join(', ')}`);

  // Re-read: the file may have just been created with a fresh BONA_TOOL_TOKEN.
  const merged = { ...loadEnv(), ...(env === process.env ? {} : env) };
  const siteUrl = String(merged.BONA_SITE ?? 'https://bona.azoz.uk').replace(/\/+$/, '');
  const publicApi = String(merged.BONA_PUBLIC_API ?? 'https://api.bona.azoz.uk').replace(/\/+$/, '');
  const toolToken = merged.BONA_TOOL_TOKEN ?? '';
  const preferred = merged.BONA_RETELL_MODEL ?? PREFERRED_MODEL;
  const fallback = merged.BONA_RETELL_MODEL_FALLBACK ?? FALLBACK_MODEL;
  const voiceId = merged.BONA_RETELL_VOICE_ID ?? '11labs-Nyla';

  if (argv.includes('--ensure-env')) return { ensuredEnvOnly: true, file: envInfo.file };
  if (!toolToken) throw new Error('BONA_TOOL_TOKEN is empty — set it in ~/.secrets/bona-services.env');

  const prompt = fs.readFileSync(PROMPT_FILE, 'utf8');
  const ids = readIds(idsFile);
  const client = clientFactory({ apiKey: merged.RETELL_API_KEY, mock: dryRun && !merged.RETELL_API_KEY });

  const kbBody = knowledgeBasePayload({ siteUrl });
  const llmBody = (model, kbIds) => llmPayload({ prompt, model, knowledgeBaseIds: kbIds, publicApi, toolToken });

  if (dryRun) {
    log('--- DRY RUN — nothing is sent to Retell. Tool token shown as <BONA_TOOL_TOKEN>. ---\n');
    log(`# POST /create-knowledge-base  (multipart/form-data)\n${JSON.stringify(redactPayload(kbBody, toolToken), null, 2)}\n`);
    log(`# POST /create-retell-llm  (model: "${preferred}", fallback on 4xx: "${fallback}")\n${JSON.stringify(redactPayload({ ...llmBody(preferred, ['<knowledge_base_id>']), general_prompt: `<prompt.md — ${prompt.length} chars>` }, toolToken), null, 2)}\n`);
    log(`# POST /create-agent\n${JSON.stringify(redactPayload(voiceAgentPayload({ llmId: '<llm_id>', publicApi, toolToken, voiceId }), toolToken), null, 2)}\n`);
    if (separateChatAgent) log(`# POST /create-chat-agent\n${JSON.stringify(redactPayload(chatAgentPayload({ llmId: '<llm_id>', publicApi, toolToken }), toolToken), null, 2)}\n`);
    else log('# chat agent: disabled (BONA_RETELL_SEPARATE_CHAT_AGENT=0) — /create-chat would reuse the voice agent id\n');
    log(`# publish step: ${publish ? 'POST /publish-agent-version/{agent_id}' : 'skipped (drafts work for create-web-call / create-chat; pass --publish to force)'}`);
    log(`# ids file: ${idsFile}`);
    return { dryRun: true, ids, model: preferred };
  }

  if (!merged.RETELL_API_KEY) throw new Error('RETELL_API_KEY is missing — expected in ~/.secrets/retell.env');

  /* 1. Knowledge base ------------------------------------------------ */
  let knowledgeBaseId = ids.knowledgeBaseId ?? null;
  let kb = null;
  if (knowledgeBaseId) {
    try { kb = await client.getKnowledgeBase(knowledgeBaseId); } catch { kb = null; knowledgeBaseId = null; }
  }
  if (!kb) kb = await findKnowledgeBase(client, KB_NAME);
  if (kb) {
    knowledgeBaseId = kb.knowledge_base_id;
    log(`= knowledge base "${KB_NAME}" exists (${knowledgeBaseId}, status ${kb.status})`);
  } else {
    kb = await client.createKnowledgeBase(kbBody);
    knowledgeBaseId = kb.knowledge_base_id;
    log(`+ knowledge base "${KB_NAME}" created (${knowledgeBaseId})`);
  }

  /* 2. Retell LLM ---------------------------------------------------- */
  let llmId = ids.llmId ?? null;
  let existingLlm = null;
  if (llmId) {
    try { existingLlm = await client.getLlm(llmId); } catch { existingLlm = null; llmId = null; }
  }
  let model;
  if (existingLlm) {
    const updated = await withModelFallback((m) => client.updateLlm(llmId, llmBody(m, [knowledgeBaseId])), { preferred, fallback, log });
    model = updated.model;
    log(`= Retell LLM "${LLM_NAME}" updated (${llmId}, model ${model})`);
  } else {
    const created = await withModelFallback((m) => client.createLlm(llmBody(m, [knowledgeBaseId])), { preferred, fallback, log });
    llmId = created.result.llm_id;
    model = created.model;
    log(`+ Retell LLM "${LLM_NAME}" created (${llmId}, model ${model})`);
  }

  /* 3. Voice agent --------------------------------------------------- */
  let voiceAgentId = ids.voiceAgentId ?? null;
  const voiceBody = voiceAgentPayload({ llmId, publicApi, toolToken, voiceId });
  if (voiceAgentId) {
    try {
      await client.getAgent(voiceAgentId);
      await client.updateAgent(voiceAgentId, voiceBody);
      log(`= voice agent updated (${voiceAgentId})`);
    } catch { voiceAgentId = null; }
  }
  if (!voiceAgentId) {
    const agent = await client.createAgent(voiceBody);
    voiceAgentId = agent.agent_id;
    log(`+ voice agent "${VOICE_AGENT_NAME}" created (${voiceAgentId})`);
  }

  /* 4. Chat agent ---------------------------------------------------- */
  let chatAgentId = ids.chatAgentId ?? null;
  if (separateChatAgent) {
    const chatBody = chatAgentPayload({ llmId, publicApi, toolToken });
    if (chatAgentId) {
      try {
        await client.getChatAgent(chatAgentId);
        await client.updateChatAgent(chatAgentId, chatBody);
        log(`= chat agent updated (${chatAgentId})`);
      } catch { chatAgentId = null; }
    }
    if (!chatAgentId) {
      const agent = await client.createChatAgent(chatBody);
      chatAgentId = agent.agent_id;
      log(`+ chat agent "${CHAT_AGENT_NAME}" created (${chatAgentId})`);
    }
  } else {
    chatAgentId = voiceAgentId;
    log('~ chat agent disabled — /create-chat will be given the voice agent id');
  }

  /* 5. Publish (optional) -------------------------------------------- */
  if (publish) {
    for (const [label, id] of [['voice', voiceAgentId], ['chat', chatAgentId]]) {
      if (!id || (label === 'chat' && !separateChatAgent)) continue;
      try {
        await client.publishAgent(id);
        log(`+ published ${label} agent (${id})`);
      } catch (err) {
        log(`  ! publish ${label} agent failed: ${err.message}`);
      }
    }
  }

  const record = {
    knowledgeBaseId, llmId, voiceAgentId, chatAgentId, model,
    voiceId, publicApi, siteUrl, separateChatAgent, published: publish,
    note: 'Ids are not secrets. Regenerate with: node services/api/retell/provision.mjs',
  };
  writeIds(record, idsFile);
  log(`\nwrote ${idsFile}`);
  log('Add to ~/.secrets/bona-services.env (or leave to ids.json):');
  log(`  BONA_RETELL_VOICE_AGENT_ID=${voiceAgentId}`);
  log(`  BONA_RETELL_CHAT_AGENT_ID=${chatAgentId}`);
  return record;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  provision({ argv: process.argv.slice(2) }).catch((err) => {
    console.error(`provision failed: ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
