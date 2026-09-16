/**
 * dottie-mac-use vision via the calling chat agent (cloud-first).
 * Package-owned — no gateway imports. Inject chat config via setChatConfigGetter
 * (gateway does this) or env: DOTTIE_CHAT_PROVIDER / DOTTIE_CHAT_API_KEY / DOTTIE_CHAT_MODEL.
 */

import { DOTTIE_PRO_BASE, readRegistrationToken, proHeaders, configString } from './pro.js';

/** Legacy local llama-server origin. The engine is gone; the guard below keeps
 *  a stale config from silently pointing vision at a dead port. */
const LOCAL_LLM = 'http://127.0.0.1:1316';

/** @type {null|(() => Promise<object>|object)} */
let chatConfigGetter = null;

/** Gateway wires getLastChatConfig here for in-app Turns. */
export function setChatConfigGetter(fn) {
  chatConfigGetter = typeof fn === 'function' ? fn : null;
}

export function openaiVisionMessages(base64Image, question) {
  return [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Image}` } },
      { type: 'text', text: question },
    ],
  }];
}

function configFromEnv() {
  const provider = process.env.DOTTIE_CHAT_PROVIDER || process.env.DOTTIE_VISION_PROVIDER;
  if (!provider) return null;
  return {
    provider,
    model: process.env.DOTTIE_CHAT_MODEL || process.env.DOTTIE_VISION_MODEL,
    apiKey: process.env.DOTTIE_CHAT_API_KEY || process.env.DOTTIE_VISION_API_KEY || process.env.XAI_API_KEY,
  };
}

async function getChatConfig() {
  if (chatConfigGetter) {
    return await chatConfigGetter();
  }
  const fromEnv = configFromEnv();
  if (fromEnv) return fromEnv;
  return { provider: 'dottiepro' };
}

async function postChatCompletions({
  url, headers, model, messages, maxTokens = 1024, temperature, fetchFn = globalThis.fetch,
}) {
  if (typeof url === 'string' && url.startsWith(LOCAL_LLM)) {
    throw new Error('dottie-mac-use vision must not call local llama (:1316) on cloud-first path');
  }
  const body = { model, max_tokens: maxTokens, messages };
  if (temperature !== undefined) body.temperature = temperature;
  const response = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`vision ${response.status}: ${error.slice(0, 400)}`);
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content ?? data.content?.[0]?.text;
  if (typeof text !== 'string' || !text) {
    throw new Error('vision returned empty content');
  }
  return text;
}

async function callAnthropicVision(apiKey, base64Image, question, model, fetchFn) {
  const visionModel = model || 'claude-sonnet-4-20250514';
  const response = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: visionModel,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64Image },
          },
          { type: 'text', text: question },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} - ${(await response.text()).slice(0, 400)}`);
  }
  const data = await response.json();
  return data.content[0].text;
}

/**
 * Analyze / ground an image with the active chat provider.
 */
export async function analyzeWithAgentVision({
  base64Image,
  question,
  maxTokens = 1024,
  temperature,
  config: configOverride,
  fetchFn = globalThis.fetch,
} = {}) {
  if (!base64Image || typeof question !== 'string') {
    throw new Error('base64Image and question are required');
  }
  const config = configOverride ?? await getChatConfig();
  const provider = config?.provider || 'dottiepro';
  const model = config?.model;
  const apiKey = config?.apiKey;
  const messages = openaiVisionMessages(base64Image, question);
  const defaultVisionModel = configString('VISION_MODEL', 'grok-4.3');

  if (provider === 'local' || !provider) {
    throw new Error('Local vision paused — use Pro or your xAI key for dottie-mac-use vision');
  }

  if (provider === 'anthropic') {
    if (!apiKey) throw new Error('Anthropic API key required for dottie-mac-use vision');
    return callAnthropicVision(apiKey, base64Image, question, model, fetchFn);
  }

  if (provider === 'openai') {
    if (!apiKey) throw new Error('OpenAI API key required for dottie-mac-use vision');
    return postChatCompletions({
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      model: model || 'gpt-4o',
      messages,
      maxTokens,
      temperature,
      fetchFn,
    });
  }

  if (provider === 'xai') {
    if (!apiKey) throw new Error('xAI API key required for dottie-mac-use vision');
    return postChatCompletions({
      url: 'https://api.x.ai/v1/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      model: model || defaultVisionModel,
      messages,
      maxTokens,
      temperature,
      fetchFn,
    });
  }

  if (provider === 'dottiepro') {
    const token = readRegistrationToken();
    if (!token) throw new Error('Dottie Pro registration required for dottie-mac-use vision');
    return postChatCompletions({
      url: `${DOTTIE_PRO_BASE}/chat/completions`,
      headers: proHeaders({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      }),
      model: model || defaultVisionModel,
      messages,
      maxTokens,
      temperature,
      fetchFn,
    });
  }

  throw new Error(
    `dottie-mac-use vision unsupported for provider "${provider}" — switch to Pro or xAI (local llama not used)`
  );
}
