/** Bearer for AX :1319 — mint if missing (package-owned). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { AGENT_TOKEN_PATH, DOTTIE_DIR } from './paths.js';

export { AGENT_TOKEN_PATH };

/** Fresh read; mints a token when absent. */
export function readAgentToken() {
  try {
    const t = readFileSync(AGENT_TOKEN_PATH, 'utf-8').trim();
    if (t) return t;
  } catch { /* mint */ }
  mkdirSync(DOTTIE_DIR, { recursive: true });
  mkdirSync(dirname(AGENT_TOKEN_PATH), { recursive: true });
  const token = randomBytes(32).toString('hex');
  writeFileSync(AGENT_TOKEN_PATH, token, { mode: 0o600 });
  return token;
}

export function ensureAgentToken() {
  return readAgentToken();
}

export function hasAgentToken() {
  try {
    return existsSync(AGENT_TOKEN_PATH) && readFileSync(AGENT_TOKEN_PATH, 'utf-8').trim().length > 0;
  } catch {
    return false;
  }
}
