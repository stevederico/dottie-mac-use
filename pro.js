/**
 * Dottie Pro relay helpers — package-owned (standalone vision path).
 */
import { readFileSync } from 'node:fs';
import { API_TOKEN_PATH } from './paths.js';

const DEFAULT_PRO_BASE = 'https://api.dottie.ai/api/pro';

export function resolveProBase(raw, fallback = DEFAULT_PRO_BASE) {
  if (!raw) return fallback;
  try {
    const url = new URL(raw);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return raw;
  } catch {
    // fall through
  }
  return fallback;
}

export const DOTTIE_PRO_BASE = resolveProBase(process.env.DOTTIE_PRO_URL);
export const PRO_USER_AGENT = `Mozilla/5.0 Dottie/${process.env.DOTTIE_APP_VERSION || 'dev'}`;

export function proHeaders(extra = {}) {
  return { 'User-Agent': PRO_USER_AGENT, ...extra };
}

export function readRegistrationToken() {
  try {
    return readFileSync(API_TOKEN_PATH, 'utf-8').trim();
  } catch {
    return '';
  }
}

/** Env / remote-config style string — env wins. */
export function configString(envKey, fallback) {
  const env = process.env[envKey];
  if (env) return env;
  return fallback;
}
