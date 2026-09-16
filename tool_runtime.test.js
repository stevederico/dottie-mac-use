/**
 * Hands tool_runtime — in-process, never :1317.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PORTS } from './ports.js';

vi.mock('./index.js', () => ({
  customTools: [
    {
      name: 'get_frontmost_app',
      description: 'Frontmost app',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'Finder',
    },
  ],
}));

vi.mock('./permissions.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    findScopeForTool: () => null,
    isScopeGranted: () => true,
    setPermissionReader: () => {},
  };
});

const { listTools, callTool } = await import('./tool_runtime.js');

describe('tool_runtime', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists Hands tools', () => {
    const tools = listTools();
    expect(tools.some((t) => t.name === 'get_frontmost_app')).toBe(true);
  });

  it('calls tool in-process without fetching :1317', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const result = await callTool('get_frontmost_app', {});
    expect(result).toEqual({ success: true, data: 'Finder' });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(String(PORTS.GATEWAY_PORT)).toBe('1317');
  });

  it('returns not found for unknown tool', async () => {
    const result = await callTool('no_such_tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });
});
