/**
 * Grok Hub tools — open hub.grok.me / *.grok.me apps in Dottie's borderless WKWebView.
 * Voice path: "open Grok Hub" / "open Grok Theft Auto from the hub" → hub_open → POST :1319/web/open.
 */

import { createTool, axFetch, tagDomain, toolError } from './shared.js';

const HUB_HOME = 'https://hub.grok.me/';
const HUB_UA = 'Mozilla/5.0 Dottie/hub_open';

/** @type {{ at: number, apps: Array<{ id: string, name: string, url: string, subdomain: string }> }} */
let catalogCache = { at: 0, apps: [] };
const CATALOG_TTL_MS = 60 * 60 * 1000;

const HUB_SYNONYMS = new Set([
  '',
  'hub',
  'store',
  'app store',
  'appstore',
  'grok hub',
  'grok build hub',
  'grok build',
  'build hub',
  'the hub',
  'the grok hub',
  'the grok build hub',
  'open hub',
]);

/**
 * True when url is safe to open in the Hub WebView.
 * HTTPS only (matches Swift HubWebWindowManager) — Hub is TLS; block cleartext smuggling.
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowedHubURL(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'hub.grok.me') return true;
  if (host === 'grok.me' || host.endsWith('.grok.me')) return true;
  // Featured catalog outliers that publish outside *.grok.me
  if (host === 'grokfilm.app' || host === 'www.grokfilm.app') return true;
  return false;
}

/**
 * Normalize for fuzzy title match.
 * @param {string} s
 */
function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Parse hub SPA JS for `{id:\`…\`,name:\`…\`,…url:\`https://…\`}` app objects.
 * @param {string} js
 * @returns {Array<{ id: string, name: string, url: string, subdomain: string }>}
 */
export function parseHubCatalogJs(js) {
  /** @type {Array<{ id: string, name: string, url: string, subdomain: string }>} */
  const apps = [];
  const re = /\{id:`([^`]+)`,name:`([^`]+)`[\s\S]*?url:`(https:\/\/[^`]+)`/g;
  let m;
  while ((m = re.exec(js)) !== null) {
    const id = m[1];
    const name = m[2].replace(/\s+/g, ' ').trim();
    const url = m[3];
    // Only allowlisted hosts (drops x.com posts and other noise the regex can hit).
    if (!isAllowedHubURL(url)) continue;
    apps.push({
      id,
      name,
      url,
      subdomain: id,
    });
  }
  const byId = new Map();
  for (const a of apps) {
    if (!byId.has(a.id)) byId.set(a.id, a);
  }
  return [...byId.values()];
}

/**
 * Candidate catalog asset paths from hub HTML (order = fetch priority).
 * Prefer index-*.js (current SPA dump); keep apps-*.js for older hub builds.
 * @param {string} html
 * @returns {string[]}
 */
export function catalogAssetCandidates(html) {
  const paths = [];
  const seen = new Set();
  const push = (p) => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    paths.push(p);
  };
  // Primary: SPA entry that embeds the apps array (2026.8+ hub.grok.me).
  for (const m of html.matchAll(/\/assets\/index-[A-Za-z0-9_-]+\.js/g)) {
    push(m[0]);
  }
  // Legacy dedicated catalog chunk.
  for (const m of html.matchAll(/\/assets\/apps-[A-Za-z0-9_-]+\.js/g)) {
    push(m[0]);
  }
  // Fallback: other modulepreload/script assets (stop at first non-empty parse later).
  for (const m of html.matchAll(/\/assets\/[A-Za-z0-9_.-]+\.js/g)) {
    push(m[0]);
  }
  return paths;
}

/**
 * Load app catalog from hub.grok.me SPA assets (same dump the storefront uses).
 * @returns {Promise<Array<{ id: string, name: string, url: string, subdomain: string }>>}
 */
export async function loadHubCatalog() {
  if (catalogCache.apps.length && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.apps;
  }
  const htmlRes = await fetch(HUB_HOME, {
    headers: { 'User-Agent': HUB_UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  if (!htmlRes.ok) {
    throw new Error(`hub.grok.me returned ${htmlRes.status}`);
  }
  const html = await htmlRes.text();
  const candidates = catalogAssetCandidates(html);
  if (!candidates.length) {
    throw new Error('could not find hub catalog asset');
  }

  let lastErr = null;
  for (const assetPath of candidates.slice(0, 12)) {
    try {
      const jsRes = await fetch(new URL(assetPath, HUB_HOME).href, {
        headers: { 'User-Agent': HUB_UA },
        signal: AbortSignal.timeout(20000),
      });
      if (!jsRes.ok) {
        lastErr = new Error(`hub catalog asset ${assetPath} returned ${jsRes.status}`);
        continue;
      }
      const apps = parseHubCatalogJs(await jsRes.text());
      if (apps.length > 0) {
        catalogCache = { at: Date.now(), apps };
        return catalogCache.apps;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : 'no parseable asset';
  throw new Error(`hub catalog parse returned 0 apps (${detail})`);
}

/**
 * Score how well query matches an app (higher is better; 0 = no match).
 * @param {string} queryNorm
 * @param {{ id: string, name: string, subdomain: string }} app
 */
function matchScore(queryNorm, app) {
  if (!queryNorm) return 0;
  const nameN = normalize(app.name);
  const idN = normalize(app.id);
  const subN = normalize(app.subdomain || '');
  if (nameN === queryNorm || idN === queryNorm || subN === queryNorm) return 100;
  if (nameN.startsWith(queryNorm) || idN.startsWith(queryNorm)) return 80;
  if (nameN.includes(queryNorm) || idN.includes(queryNorm) || subN.includes(queryNorm)) return 60;
  // token coverage: "theft auto" ⊆ "grok theft auto"
  const qTokens = queryNorm.split(' ').filter(Boolean);
  if (qTokens.length >= 2) {
    const hit = qTokens.every((t) => nameN.includes(t) || idN.includes(t));
    if (hit) return 50 + qTokens.length;
  }
  // single significant token
  if (qTokens.length === 1 && qTokens[0].length >= 4) {
    if (nameN.includes(qTokens[0]) || idN.includes(qTokens[0])) return 40;
  }
  return 0;
}

/**
 * Resolve a voice/query string to a hub URL + title.
 * @param {string} [query]
 * @param {string} [url]
 * @returns {Promise<{ url: string, title: string, source: string }>}
 */
export async function resolveHubTarget(query, url) {
  if (url && typeof url === 'string' && url.trim()) {
    const raw = url.trim();
    if (!isAllowedHubURL(raw)) {
      throw new Error('URL must be hub.grok.me or a *.grok.me (or catalog-listed) app');
    }
    return { url: raw, title: new URL(raw).hostname, source: 'url' };
  }

  const q = (query ?? '').trim();
  const qLower = q.toLowerCase();
  if (HUB_SYNONYMS.has(qLower) || HUB_SYNONYMS.has(normalize(q))) {
    return { url: HUB_HOME, title: 'Grok Hub', source: 'hub' };
  }

  // Direct URL pasted as query
  if (/^https?:\/\//i.test(q) && isAllowedHubURL(q)) {
    return { url: q, title: new URL(q).hostname, source: 'url' };
  }

  // Bare subdomain: "chess" / "grok-t-a" / "chess.grok.me"
  const subMatch = qLower.match(/^(?:https?:\/\/)?([a-z0-9][a-z0-9-]*)(?:\.grok\.me)?\/?$/i);
  if (subMatch && !q.includes(' ')) {
    const sub = subMatch[1];
    if (sub === 'hub') {
      return { url: HUB_HOME, title: 'Grok Hub', source: 'hub' };
    }
    const candidate = `https://${sub}.grok.me/`;
    if (isAllowedHubURL(candidate)) {
      // Prefer catalog title when available
      try {
        const apps = await loadHubCatalog();
        const hit = apps.find((a) => a.id === sub || a.subdomain === sub);
        if (hit) {
          return { url: hit.url.endsWith('/') ? hit.url : `${hit.url}`, title: hit.name, source: 'catalog-id' };
        }
      } catch {
        // fall through to subdomain open
      }
      return { url: candidate, title: sub, source: 'subdomain' };
    }
  }

  // Catalog search by name
  let apps;
  try {
    apps = await loadHubCatalog();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Name search unavailable (${why}). Try "hub", a subdomain (e.g. "grok-t-a"), or an exact https URL.`,
    );
  }
  const qn = normalize(q);
  let best = null;
  let bestScore = 0;
  for (const app of apps) {
    const s = matchScore(qn, app);
    if (s > bestScore) {
      bestScore = s;
      best = app;
    }
  }
  if (best && bestScore >= 40) {
    return { url: best.url, title: best.name, source: 'catalog' };
  }

  throw new Error(
    `No Grok Hub app matched "${q}". Try the exact name (e.g. "Grok Theft Auto") or subdomain (e.g. "grok-t-a").`,
  );
}

/**
 * Ask Swift to open a borderless WKWebView for the given URL.
 * Shared by hub_open and open_url/safari_open_url (hub URLs must never hit the browser).
 * @param {string} url
 * @param {string} [title]
 */
export async function openHubWebView(url, title) {
  const t = (title && String(title).trim()) || (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return 'Grok Hub';
    }
  })();
  return axFetch('/web/open', {
    method: 'POST',
    body: JSON.stringify({ url, title: t }),
    timeout: 10000,
  });
}

export const hubTools = tagDomain([
  createTool({
    name: 'hub_open',
    domain: 'info',
    requiresPermission: 'safari.control',
    description:
      'REQUIRED for Grok Hub: open hub.grok.me or a hub app/game in a borderless Dottie WebView (never the system browser). ' +
      'Use for: open Grok Hub, open the Grok Build Hub, open Grok Theft Auto / chess / any hub game. ' +
      'Prefer over open_url and safari_open_url for anything on hub.grok.me or *.grok.me. ' +
      'Pass query: "hub" for the store, or the app name. Requires Open URLs (safari.control) permission.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'What to open: "hub" / "Grok Hub" for the store, or an app/game name (e.g. "Grok Theft Auto", "chess"). Optional if url is set.',
        },
        url: {
          type: 'string',
          description: 'Optional direct https URL (must be hub.grok.me or *.grok.me).',
        },
      },
      required: [],
    },
    execute: async (input) => {
      try {
        const target = await resolveHubTarget(input.query, input.url);
        if (!isAllowedHubURL(target.url)) {
          return toolError('hub_open', 'VALIDATION', 'Resolved URL is not allowed in the Hub WebView');
        }
        await openHubWebView(target.url, target.title);
        return `Opened ${target.title} in Dottie WebView (${target.url})`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('AX service') || msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
          return toolError(
            'hub_open',
            'EXECUTION',
            'Could not reach the Dottie app WebView host (is Dottie running?). ' + msg,
          );
        }
        return toolError('hub_open', 'VALIDATION', msg);
      }
    },
  }),
], 'info');
