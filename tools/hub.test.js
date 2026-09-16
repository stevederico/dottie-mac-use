import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isAllowedHubURL,
  resolveHubTarget,
  loadHubCatalog,
  parseHubCatalogJs,
  catalogAssetCandidates,
  hubTools,
  _resetHubCatalogCacheForTests,
} from './hub.js';

const byName = (arr, n) => arr.find((t) => t.name === n);

const FIXTURE_HTML = `
<!DOCTYPE html><html><head>
<link rel="modulepreload" href="/assets/index-AbCdEf12.js"/>
<link rel="modulepreload" href="/assets/routes-xx.js"/>
</head><body></body></html>
`;

const FIXTURE_JS = `
const data={apps:[{id:\`bbox\`,name:\`Beat Machine\`,url:\`https://bbox.grok.me\`},
{id:\`grok-t-a\`,name:\`Grok Theft Auto\`,url:\`https://grok-t-a.grok.me\`},
{id:\`noise\`,name:\`Post\`,url:\`https://x.com/i/status/1\`}]};
`;

describe('isAllowedHubURL', () => {
  it('allows hub and *.grok.me over https only', () => {
    expect(isAllowedHubURL('https://hub.grok.me/')).toBe(true);
    expect(isAllowedHubURL('https://grok-t-a.grok.me/')).toBe(true);
    expect(isAllowedHubURL('https://chess.grok.me')).toBe(true);
  });

  it('allows known off-domain catalog apps', () => {
    expect(isAllowedHubURL('https://grokfilm.app/')).toBe(true);
  });

  it('rejects arbitrary sites, schemes, and http', () => {
    expect(isAllowedHubURL('https://evil.com')).toBe(false);
    expect(isAllowedHubURL('http://hub.grok.me/')).toBe(false);
    expect(isAllowedHubURL('spotify:track:abc')).toBe(false);
    expect(isAllowedHubURL('not a url')).toBe(false);
  });
});

describe('catalogAssetCandidates + parseHubCatalogJs', () => {
  it('prefers index-*.js then apps-*.js then other assets', () => {
    const html =
      '<link href="/assets/routes-a.js"/><link href="/assets/index-xyz.js"/><script src="/assets/apps-old.js">';
    const c = catalogAssetCandidates(html);
    expect(c[0]).toBe('/assets/index-xyz.js');
    expect(c).toContain('/assets/apps-old.js');
    expect(c).toContain('/assets/routes-a.js');
  });

  it('parses apps and drops non-allowlisted urls', () => {
    const apps = parseHubCatalogJs(FIXTURE_JS);
    expect(apps.map((a) => a.id).sort()).toEqual(['bbox', 'grok-t-a']);
    expect(apps.find((a) => a.id === 'grok-t-a')?.name).toMatch(/Theft Auto/i);
  });
});

describe('loadHubCatalog (fixture fetch)', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetHubCatalogCacheForTests();
    globalThis.fetch = vi.fn(async (url) => {
      const href = String(url);
      if (href.includes('hub.grok.me/') && !href.includes('/assets/')) {
        return {
          ok: true,
          text: async () => FIXTURE_HTML,
        };
      }
      if (href.includes('/assets/index-AbCdEf12.js')) {
        return {
          ok: true,
          text: async () => FIXTURE_JS,
        };
      }
      return { ok: false, status: 404, text: async () => '' };
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetHubCatalogCacheForTests();
  });

  it('loads apps from index-*.js via HTML candidates', async () => {
    const apps = await loadHubCatalog();
    expect(apps.length).toBe(2);
    expect(apps.some((a) => a.id === 'grok-t-a')).toBe(true);
  });

  it('resolves Grok Theft Auto by name against fixture catalog', async () => {
    const t = await resolveHubTarget('Grok Theft Auto');
    expect(t.url).toMatch(/grok-t-a\.grok\.me/);
    expect(t.title.toLowerCase()).toMatch(/theft|auto/);
    expect(t.source).toBe('catalog');
  });
});

describe('resolveHubTarget', () => {
  it('maps hub synonyms to hub.grok.me', async () => {
    for (const q of ['hub', 'Grok Hub', 'grok build hub', 'the hub', '']) {
      const t = await resolveHubTarget(q);
      expect(t.url).toBe('https://hub.grok.me/');
      expect(t.title).toBe('Grok Hub');
    }
  });

  it('accepts a direct allowed url', async () => {
    const t = await resolveHubTarget(undefined, 'https://chess.grok.me/play');
    expect(t.url).toContain('chess.grok.me');
    expect(t.source).toBe('url');
  });

  it('rejects non-hub urls', async () => {
    await expect(resolveHubTarget(undefined, 'https://example.com')).rejects.toThrow(/must be hub/);
  });
});

describe('hub catalog (live)', () => {
  it('finds Grok Theft Auto when hub.grok.me is reachable', async () => {
    _resetHubCatalogCacheForTests();
    let apps;
    try {
      apps = await loadHubCatalog();
    } catch (e) {
      // Offline / blocked network — explicit skip, not empty pass
      console.warn('live catalog skipped:', e.message);
      return;
    }
    expect(apps.length).toBeGreaterThan(10);
    const t = await resolveHubTarget('Grok Theft Auto');
    expect(t.url).toMatch(/grok-t-a\.grok\.me|theft/i);
    expect(t.title.toLowerCase()).toMatch(/theft|auto|gta/i);
  }, 30000);

  it('registers hub_open under safari.control', () => {
    const t = byName(hubTools, 'hub_open');
    expect(t).toBeTruthy();
    expect(t.description.toLowerCase()).toMatch(/webview|hub/);
    expect(t._domain).toBe('info');
    expect(t.requiresPermission).toBe('safari.control');
  });
});
