/**
 * dottie-mac-use vision_client — calling-agent vision, never local :1316 on cloud paths.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { analyzeWithAgentVision } from './vision_client.js';
import { DOTTIE_PRO_BASE } from './pro.js';
import { PORTS } from './ports.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LOCAL = `http://127.0.0.1:${PORTS.LLM_PORT}`;

function okJson(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  };
}

describe('analyzeWithAgentVision', () => {
  const tokenPath = path.join(os.homedir(), '.dottie', 'api_token');
  let prevToken;

  beforeEach(() => {
    try { prevToken = fs.readFileSync(tokenPath, 'utf8'); } catch { prevToken = null; }
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, 'test-reg-token\n');
  });

  afterEach(() => {
    if (prevToken === null) {
      try { fs.unlinkSync(tokenPath); } catch { /* ok */ }
    } else {
      fs.writeFileSync(tokenPath, prevToken);
    }
  });

  it('routes dottiepro to Pro relay, never :1316', async () => {
    const urls = [];
    const fetchFn = vi.fn(async (url) => {
      urls.push(String(url));
      return okJson('a calendar');
    });
    const text = await analyzeWithAgentVision({
      base64Image: 'aaa',
      question: 'what?',
      config: { provider: 'dottiepro', model: 'grok-4.3' },
      fetchFn,
    });
    expect(text).toBe('a calendar');
    expect(urls[0]).toBe(`${DOTTIE_PRO_BASE}/chat/completions`);
    expect(urls.every((u) => !u.includes(`:${PORTS.LLM_PORT}`))).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('routes xai to api.x.ai, never :1316', async () => {
    const urls = [];
    const fetchFn = vi.fn(async (url) => {
      urls.push(String(url));
      return okJson('ok');
    });
    await analyzeWithAgentVision({
      base64Image: 'bbb',
      question: 'see?',
      config: { provider: 'xai', model: 'grok-4.3', apiKey: 'xai-key' },
      fetchFn,
    });
    expect(urls[0]).toBe('https://api.x.ai/v1/chat/completions');
    expect(urls.some((u) => u.startsWith(LOCAL))).toBe(false);
  });

  it('rejects local provider without calling fetch', async () => {
    const fetchFn = vi.fn();
    await expect(analyzeWithAgentVision({
      base64Image: 'ccc',
      question: 'x',
      config: { provider: 'local' },
      fetchFn,
    })).rejects.toThrow(/Local vision paused/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects unknown provider without spawning llama', async () => {
    const fetchFn = vi.fn();
    await expect(analyzeWithAgentVision({
      base64Image: 'ddd',
      question: 'x',
      config: { provider: 'cerebras', apiKey: 'k' },
      fetchFn,
    })).rejects.toThrow(/unsupported for provider "cerebras"/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
