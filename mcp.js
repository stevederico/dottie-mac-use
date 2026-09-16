#!/usr/bin/env node
/**
 * dottie-mac-use MCP stdio — named tools in-process (no :1317 rePOST).
 *
 *   node mcp.js
 */

import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { listTools, callTool } from './tool_runtime.js';
import { ensureAxRunning } from './ax_process.js';

const server = new Server(
  { name: 'dottie-mac-use', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: listTools(),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments || {};
  const envelope = await callTool(name, args);
  if (!envelope.success) {
    return {
      content: [{ type: 'text', text: envelope.error || 'failed' }],
      isError: true,
    };
  }
  const payload = envelope.data;
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof payload === 'object' && payload !== null ? payload : { result: payload },
  };
});

export { listTools, callTool };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await ensureAxRunning();
  } catch (err) {
    process.stderr.write(`[dottie-mac-use] AX warn: ${err.message}\n`);
  }
  await server.connect(new StdioServerTransport());
}
