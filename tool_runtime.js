/**
 * dottie-mac-use tool runtime — list/call customTools in-process (no :1317 rePOST).
 * Package-owned — no gateway imports.
 */

import { DatabaseSync } from 'node:sqlite';
import { customTools } from './index.js';
import {
  findScopeForTool,
  isScopeGranted,
  setPermissionReader,
  TOOL_PERMISSIONS,
} from './permissions.js';
import { AGENT_DB_PATH } from './paths.js';

let permissionsWired = false;

/** Wire Settings permissions from ~/.dottie/agent.db (same table as gateway). */
export function ensurePermissionReader() {
  if (permissionsWired) return;
  permissionsWired = true;
  setPermissionReader(() => {
    const result = {};
    for (const [scope, config] of Object.entries(TOOL_PERMISSIONS)) {
      result[scope] = config.defaultEnabled;
    }
    try {
      const db = new DatabaseSync(AGENT_DB_PATH, { readOnly: true });
      try {
        const rows = db.prepare(
          "SELECT key, value FROM config WHERE key LIKE 'permission.%'",
        ).all();
        for (const row of rows) {
          const scope = row.key.replace('permission.', '');
          if (scope in TOOL_PERMISSIONS) {
            result[scope] = row.value === 'true';
          }
        }
      } finally {
        db.close();
      }
    } catch {
      // DB missing / no config table — keep defaults
    }
    return result;
  });
}

/** MCP/HTTP tool descriptors from dottie-mac-use customTools. */
export function listTools() {
  ensurePermissionReader();
  return (customTools || []).map((t) => ({
    name: t.name,
    description: t.description || t.name,
    inputSchema: t.parameters && typeof t.parameters === 'object'
      ? t.parameters
      : { type: 'object', properties: {} },
    parameters: t.parameters && typeof t.parameters === 'object'
      ? t.parameters
      : { type: 'object', properties: {} },
    _domain: t._domain || null,
    _permission: t._permission || null,
    _internalParams: t._internalParams || undefined,
  }));
}

/**
 * Execute a dottie-mac-use tool by name.
 * @param {string} name
 * @param {object} [args]
 * @returns {Promise<{success:boolean, data?:*, error?:string, requiredScope?:string}>}
 */
export async function callTool(name, args = {}) {
  ensurePermissionReader();
  if (!name || typeof name !== 'string') {
    return { success: false, error: 'tool name is required' };
  }
  const tool = (customTools || []).find((t) => t.name === name);
  if (!tool) {
    return { success: false, error: `Tool not found: ${name}` };
  }
  const scope = findScopeForTool(name);
  if (scope && !isScopeGranted(scope)) {
    return { success: false, error: 'Permission denied', requiredScope: scope };
  }
  try {
    const data = await tool.execute(args && typeof args === 'object' ? args : {}, undefined, {});
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}
