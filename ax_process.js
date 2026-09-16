/**
 * Supervise dottie-mac-use-ax (:1319) — spawn if down, reuse if up.
 * Package-owned; no Dottie.app required.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS } from './ports.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let child = null;
let ensurePromise = null;

export function axBaseUrl() {
  const port = Number(process.env.DOTTIE_AX_PORT) || PORTS.AX_PORT;
  return `http://127.0.0.1:${port}`;
}

/** Resolve CLI binary path. */
export function resolveAxBinary() {
  if (process.env.DOTTIE_MAC_USE_AX) return process.env.DOTTIE_MAC_USE_AX;
  const candidates = [
    path.join(__dirname, 'native', '.build', 'dottie-mac-use-ax'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch { /* continue */ }
  }
  return candidates[0];
}

async function healthOk(timeoutMs = 800) {
  try {
    const res = await fetch(`${axBaseUrl()}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnAx(bin) {
  if (!fs.existsSync(bin)) {
    throw new Error(
      `dottie-mac-use-ax not found at ${bin}. Run: npm run build:ax`,
    );
  }
  const env = { ...process.env };
  if (!env.DOTTIE_AX_PORT) env.DOTTIE_AX_PORT = String(PORTS.AX_PORT);
  const proc = spawn(bin, [], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  });
  proc.stderr?.on('data', (buf) => {
    const line = buf.toString().trim();
    if (line) log.debug('mac-use-ax', line);
  });
  proc.on('exit', (code, signal) => {
    if (child === proc) child = null;
    log.warn('mac-use-ax', `exited code=${code} signal=${signal}`);
  });
  proc.unref();
  child = proc;
  return proc;
}

/**
 * Ensure AX HTTP is up. Idempotent; concurrent callers share one promise.
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<boolean>}
 */
export async function ensureAxRunning({ timeoutMs = 15_000 } = {}) {
  if (await healthOk()) return true;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    try {
      if (await healthOk()) return true;
      const bin = resolveAxBinary();
      log.info('mac-use-ax', `starting ${bin}`);
      spawnAx(bin);
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await healthOk(500)) return true;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`dottie-mac-use-ax did not become healthy on ${axBaseUrl()} within ${timeoutMs}ms`);
    } finally {
      ensurePromise = null;
    }
  })();

  return ensurePromise;
}
