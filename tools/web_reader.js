/**
 * web_reader — fetch a URL and return readable text.
 * Built for the stream-studio co-host so it can "pull up a site and read it"
 * during a livestream. Keeps it dependency-free: native fetch + a small
 * HTML-to-text stripper.
 *
 * SSRF defense: blocks private/loopback IPs at the URL hostname AND at every
 * redirect hop (manual redirect follow). Hostnames are DNS-resolved so a
 * public name pointing at 127.0.0.1 is rejected before fetch is issued.
 * Stream-capped read: aborts mid-stream once MAX_BYTES is exceeded so a
 * hostile server can't OOM the gateway by sending an unbounded body.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { logToolUse, tagDomain } from './shared.js';
import { createTool } from './shared.js';

const MAX_BYTES = 1_500_000; // 1.5MB ceiling on response
export { MAX_BYTES };
const MAX_CHARS = 20_000;    // truncate text output
const MAX_REDIRECTS = 5;

export const webReaderTools = tagDomain([
  createTool({
    name: 'web_reader',
    description: 'Fetch a web page and return its readable text content. Use when the user asks you to read, summarize, look at, or pull up a website. Returns the page title and main text body, stripped of HTML, scripts, and styles.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL to fetch (must start with http:// or https://).',
        },
        max_chars: {
          type: 'number',
          description: 'Optional maximum characters of text to return. Defaults to 20000.',
        },
      },
      required: ['url'],
    },
    execute: async (input, signal) => {
      const url = String(input?.url || '').trim();
      const maxChars = Number(input?.max_chars) > 0 ? Number(input.max_chars) : MAX_CHARS;

      if (!/^https?:\/\//i.test(url)) {
        return 'Invalid URL — must start with http:// or https://';
      }

      try {
        const { res, finalUrl } = await safeFetch(url, signal);
        if (!res.ok) {
          return `HTTP ${res.status} ${res.statusText} for ${finalUrl}`;
        }
        const ctype = res.headers.get('content-type') || '';
        if (!/text\/|application\/(xhtml|xml|json)/i.test(ctype)) {
          return `Unsupported content-type: ${ctype}`;
        }

        const bytes = await readWithCap(res, MAX_BYTES);
        const html = new TextDecoder().decode(bytes);
        const { title, text } = htmlToText(html);
        const truncated = text.length > maxChars;
        const body = truncated ? text.slice(0, maxChars) + '\n…[truncated]' : text;
        const result = [
          title ? `# ${title}` : '',
          `Source: ${finalUrl}`,
          '',
          body,
        ].filter(Boolean).join('\n');
        logToolUse('web_reader', input, `${title || '(no title)'} — ${body.length} chars`);
        return result;
      } catch (err) {
        const msg = err?.name === 'AbortError' ? 'Fetch aborted' : (err?.message || String(err));
        return `Failed to read ${url}: ${msg}`;
      }
    },
  }),
], 'info');

/**
 * Manual redirect follow. Re-validates the hostname at every hop so a public
 * URL can't 302 us to 127.0.0.1.
 */
export async function safeFetch(initialUrl, signal) {
  let url = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(new URL(url).hostname);
    const res = await fetch(url, {
      signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Dottie-WebReader/1.0',
        'Accept': 'text/html,text/plain;q=0.9,*/*;q=0.5',
      },
    });
    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.get('location');
    if (!isRedirect) return { res, finalUrl: url };
    url = new URL(res.headers.get('location'), url).toString();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`Redirect to non-http(s) scheme: ${url}`);
    }
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
}

async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) throw new Error('Empty hostname');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Blocked private/loopback host: ${host}`);
  }
  let ips;
  if (isIP(host)) {
    ips = [host];
  } else {
    try {
      const results = await lookup(host, { all: true });
      ips = results.map((r) => r.address);
    } catch (err) {
      throw new Error(`DNS resolution failed for ${host}: ${err.message}`);
    }
  }
  for (const ip of ips) {
    if (isPrivateIP(ip)) {
      throw new Error(`Blocked private/loopback host: ${host} -> ${ip}`);
    }
  }
}

function isPrivateIP(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // 127.0.0.0/8
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 (incl. AWS metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a >= 224) return true;                         // multicast + reserved
    return false;
  }
  if (v === 6) {
    const lc = ip.toLowerCase();
    if (lc === '::1' || lc === '::') return true;
    const mapped = lc.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIP(mapped[1]);
    if (lc.startsWith('fe80:')) return true;           // link-local
    if (lc.startsWith('fc') || lc.startsWith('fd')) return true; // unique-local
    return false;
  }
  return false;
}

/**
 * Read response body chunk-by-chunk, aborting once we exceed maxBytes.
 * Prevents OOM from a hostile server streaming an unbounded body.
 */
export async function readWithCap(res, maxBytes) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch {}
        throw new Error(`Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
}

/**
 * Minimal HTML → plain text. No deps, good enough for read-aloud use cases.
 * Strips script/style, decodes common entities, collapses whitespace.
 */
export function htmlToText(html) {
  // Title
  const tMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = tMatch ? decodeEntities(tMatch[1]).trim() : '';

  let s = html;
  // Drop script, style, noscript, svg, head
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  // Block-level → newlines
  s = s.replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)\s*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, ' ');
  // Entities + whitespace
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return { title, text: s };
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
