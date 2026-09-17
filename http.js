/**
 * dottie-mac-use HTTP — owns AX (:1319); tools run in this process.
 * Listen: DOTTIE_MAC_USE_HTTP_PORT=1321 node http.js
 */

import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { listTools, callTool } from './tool_runtime.js';
import { ensureAxRunning, axBaseUrl } from './ax_process.js';
import { PORTS } from './ports.js';

async function axHealthy() {
  try {
    const res = await fetch(`${axBaseUrl()}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function handleMacUseRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      const ax = await axHealthy();
      res.writeHead(ax ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: ax,
        service: 'dottie-mac-use',
        ax,
        axUrl: axBaseUrl(),
        port: PORTS.MAC_USE_HTTP_PORT || 1321,
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/v1/tools') {
      const tools = listTools();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tools, toolCount: tools.length }));
      return;
    }

    const callMatch = url.pathname.match(/^\/v1\/tools\/([^/]+)$/);
    if (req.method === 'POST' && callMatch) {
      const name = decodeURIComponent(callMatch[1]);
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let args = {};
      if (chunks.length) {
        try {
          args = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'invalid JSON body' }));
          return;
        }
      }
      const result = await callTool(name, args);
      const status = result.success ? 200 : (result.error === 'Permission denied' ? 403 : 404);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
}

export function createMacUseServer() {
  return http.createServer((req, res) => {
    handleMacUseRequest(req, res);
  });
}

const port = Number(process.env.DOTTIE_MAC_USE_HTTP_PORT || 0);
if (port > 0 && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  ensureAxRunning()
    .then(() => {
      const server = createMacUseServer();
      server.listen(port, '127.0.0.1', () => {
        process.stderr.write(`[dottie-mac-use] HTTP listening on 127.0.0.1:${port}\n`);
      });
    })
    .catch((err) => {
      process.stderr.write(`[dottie-mac-use] AX start failed: ${err.message}\n`);
      // Still listen — tools that don't need AX can work; /health will 503.
      createMacUseServer().listen(port, '127.0.0.1', () => {
        process.stderr.write(`[dottie-mac-use] HTTP listening (AX down) on 127.0.0.1:${port}\n`);
      });
    });
}
