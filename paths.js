/**
 * Package data dir — standalone by default (~/.dottie-mac-use).
 * Override: DOTTIE_MAC_USE_DATA or DOTTIE_DIR (desktop sets these to ~/.dottie).
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const STANDALONE = join(HOME, '.dottie-mac-use');

function resolveDataDir() {
  if (process.env.DOTTIE_MAC_USE_DATA) return process.env.DOTTIE_MAC_USE_DATA;
  if (process.env.DOTTIE_DIR) return process.env.DOTTIE_DIR;
  return STANDALONE;
}

export const DOTTIE_DIR = resolveDataDir();
export const AGENT_DB_PATH = join(DOTTIE_DIR, 'agent.db');
export const CONFIG_PATH = join(DOTTIE_DIR, 'config.json');
export const AGENT_TOKEN_PATH = join(DOTTIE_DIR, 'agent_token');
export const API_TOKEN_PATH = join(DOTTIE_DIR, 'api_token');
export const WORKSPACE_DIR = join(DOTTIE_DIR, 'workspace');

mkdirSync(DOTTIE_DIR, { recursive: true });
