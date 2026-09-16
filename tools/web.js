/**
 * Custom web_search — local fetch of DuckDuckGo HTML (no browser / no ★dotbot).
 * Top result pages fetched with the same SSRF-safe helpers as web_reader.
 */

import { logToolUse, tagDomain, createTool } from './shared.js';
import { htmlToText, safeFetch, readWithCap, MAX_BYTES } from './web_reader.js';

const PAGE_CHARS = 3500;
const TOP_TO_FETCH = 2;

export const webTools = tagDomain([
  createTool({
    name: 'web_search',
    description:
      'Search the web for current information — flight status, news, prices, scores, anything that changes. Returns a concise summary plus the top result links. Runs entirely on this device. Use this for any "what is", "how much", "when does", or "today/now/current" question that the model does not already know the answer to.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query, plain English (e.g., "Delta flight status SFO to LAS today").',
        },
      },
      required: ['query'],
    },
    execute: async (input, signal) => {
      const query = String(input?.query ?? '').trim();
      if (!query) {
        const msg = 'web_search requires a non-empty query';
        logToolUse('web_search', input, msg);
        throw new Error(msg);
      }
      try {
        const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const { res, finalUrl } = await safeFetch(searchUrl, signal);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} for ${finalUrl}`);
        }
        const html = new TextDecoder().decode(await readWithCap(res, MAX_BYTES));
        const results = parseDdgResults(html);

        let result;
        if (results.length > 0) {
          for (let i = 0; i < Math.min(TOP_TO_FETCH, results.length); i++) {
            const link = results[i]?.link;
            if (!link || !/^https?:\/\//i.test(link)) continue;
            try {
              const page = await fetchPageText(link, signal);
              if (page) results[i].page = page.slice(0, PAGE_CHARS);
            } catch {
              /* best-effort */
            }
          }
          result = results.map((r, i) => {
            const lines = [`${i + 1}. ${r.title || r.link}`];
            if (r.snippet) lines.push(r.snippet);
            if (r.link) lines.push(r.link);
            if (r.page) lines.push(`Page content: ${r.page}`);
            return lines.join('\n');
          }).join('\n\n');
        } else {
          const { text } = htmlToText(html);
          result = text.slice(0, 4000).trim() || 'No results returned.';
        }
        logToolUse('web_search', input, `${result.slice(0, 200)}…`);
        return result;
      } catch (error) {
        const msg = `web_search failed: ${error.message}`;
        logToolUse('web_search', input, msg);
        throw new Error(msg);
      }
    },
  }),
], 'info');

/** Parse DuckDuckGo HTML result cards without a DOM. */
function parseDdgResults(html) {
  const out = [];
  const blocks = html.split(/class="[^"]*result(?:__body)?[^"]*"/i);
  for (const block of blocks) {
    if (out.length >= 6) break;
    const aMatch = block.match(/class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/href="([^"]*)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    if (!aMatch) continue;
    let href = aMatch[1] || '';
    const title = stripTags(aMatch[2] || '').trim();
    const snipMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div)/i);
    const snippet = stripTags(snipMatch?.[1] || '').replace(/\s+/g, ' ').trim();

    let link = '';
    const m = href.match(/[?&]uddg=([^&]+)/);
    if (m) {
      try { link = decodeURIComponent(m[1]); } catch { /* keep empty */ }
    }
    if (!link) {
      const disp = block.match(/class="result__url"[^>]*>([\s\S]*?)<\//i);
      const d = stripTags(disp?.[1] || '').trim();
      if (d) link = 'https://' + d.replace(/^https?:\/\//, '');
    }
    if (!link && /^https?:\/\//i.test(href)) link = href;

    if (title || snippet) out.push({ title, snippet, link });
  }
  return out;
}

function stripTags(s) {
  return String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
}

async function fetchPageText(url, signal) {
  const { res } = await safeFetch(url, signal);
  if (!res.ok) return '';
  const ctype = res.headers.get('content-type') || '';
  if (!/text\/|application\/(xhtml|xml|json)/i.test(ctype)) return '';
  const html = new TextDecoder().decode(await readWithCap(res, MAX_BYTES));
  return htmlToText(html).text.trim();
}
