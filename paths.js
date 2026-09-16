/** ~/.dottie paths — package-owned (standalone). */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DOTTIE_DIR = join(homedir(), '.dottie');
export const AGENT_DB_PATH = join(DOTTIE_DIR, 'agent.db');
export const CONFIG_PATH = join(DOTTIE_DIR, 'config.json');
export const AGENT_TOKEN_PATH = join(DOTTIE_DIR, 'agent_token');
export const API_TOKEN_PATH = join(DOTTIE_DIR, 'api_token');
