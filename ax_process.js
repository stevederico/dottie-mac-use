/**
 * Supervise dottie-mac-use-ax (:1319) — spawn if down, reuse if up.
 * Package-owned; no Dottie.app required.
 */

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORTS } from './ports.js';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN_NAME = 'dottie-mac-use-ax';

let child = null;
let ensurePromise = null;

export function axBaseUrl() {
  const port = Number(process.env.DOTTIE_AX_PORT) || PORTS.AX_PORT;
  return `http://127.0.0.1:${port}`;
}

function candidatePaths() {
  return [
    process.env.DOTTIE_MAC_USE_AX,
    path.join(__dirname, 'bin', BIN_NAME),
    path.join(__dirname, 'native', '.build', BIN_NAME),
  ].filter(Boolean);
}

/** Resolve CLI binary path (may not exist yet). */
export function resolveAxBinary() {
  for (const p of candidatePaths()) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch { /* continue */ }
  }
  return path.join(__dirname, 'bin', BIN_NAME);
}

/** Build AX CLI into bin/ when missing. */
export function ensureAxBinaryInstalled() {
  const existing = candidatePaths().find((p) => {
    try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
  });
  if (existing) return existing;
  if (process.env.DOTTIE_SKIP_AX_BUILD === '1') {
    throw new Error(`dottie-mac-use-ax missing — run: npm run build:ax (or unset DOTTIE_SKIP_AX_BUILD)`);
  }
  const script = path.join(__dirname, 'native', 'build.sh');
  if (!fs.existsSync(script)) {
    throw new Error(`dottie-mac-use-ax missing and native/build.sh not found`);
  }
  const out = path.join(__dirname, 'bin', BIN_NAME);
  log.info('mac-use-ax', `building ${out}`);
  execSync(`bash "${script}" "${out}"`, { stdio: 'inherit', env: process.env });
  if (!fs.existsSync(out)) {
    throw new Error(`build.sh finished but ${out} still missing`);
  }
  return out;
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
    throw new Error(`dottie-mac-use-ax not found at ${bin}. Run: npm run build:ax`);
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
      const bin = ensureAxBinaryInstalled();
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
