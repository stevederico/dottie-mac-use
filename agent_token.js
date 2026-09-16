/** Bearer for AX :1319 — package-owned (standalone). */
import { readFileSync } from 'node:fs';
import { AGENT_TOKEN_PATH } from './paths.js';

export { AGENT_TOKEN_PATH };

/** Fresh read; throws if missing. */
export function readAgentToken() {
  return readFileSync(AGENT_TOKEN_PATH, 'utf-8').trim();
}
