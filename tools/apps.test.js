import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appsTools } from './apps.js';
import { musicTools } from './music.js';
import * as hub from './hub.js';

const byName = (arr, n) => arr.find((t) => t.name === n);

/**
 * Research 2026-07-28 (Spotify track URI): play-by-URI needs AppleScript /
 * open -a Spotify with a validated spotify:track id. open_url is http(s)-only
 * so it cannot launch spotify: schemes; music.js has no play-by-name tool.
 * These tests pin the shipped constraints that research relies on.
 */
describe('open_url scheme guard (Spotify URI research)', () => {
  const openUrl = () => byName(appsTools, 'open_url');

  it('rejects spotify:track URIs (http/https only)', async () => {
    const res = await openUrl().execute(
      { url: 'spotify:track:08mG3Y1vljYA6bvDt4Wqkj' },
      null,
      null,
    );
    expect(res).toBe('Error: URL must start with http:// or https://');
  });

  it('rejects bare spotify:album URIs the same way', async () => {
    const res = await openUrl().execute(
      { url: 'spotify:album:6mUdeDZCsExyJLMdAfDuwh' },
      null,
      null,
    );
    expect(res).toMatch(/^Error: URL must start with http/);
  });

  it('describes itself as opening a new window (not a tab)', () => {
    expect(openUrl().description.toLowerCase()).toMatch(/new (browser )?window/);
  });

  it('tells the model to use hub_open for Grok Hub', () => {
    expect(openUrl().description.toLowerCase()).toMatch(/hub_open/);
    expect(openUrl().description.toLowerCase()).toMatch(/grok hub|hub\.grok\.me/);
  });
});

describe('open_url redirects hub URLs to WebView', () => {
  const openUrl = () => byName(appsTools, 'open_url');
  let spy;

  beforeEach(() => {
    spy = vi.spyOn(hub, 'openHubWebView').mockResolvedValue('{"ok":true}');
  });
  afterEach(() => {
    spy?.mockRestore();
  });

  it('opens hub.grok.me via openHubWebView, not the browser', async () => {
    const res = await openUrl().execute({ url: 'https://hub.grok.me/' }, null, null);
    expect(spy).toHaveBeenCalledWith('https://hub.grok.me/');
    expect(String(res).toLowerCase()).toMatch(/webview/);
    expect(String(res).toLowerCase()).not.toMatch(/safari|chrome|browser window/);
  });
});

describe('music tools surface', () => {
  it('exposes media keys, now_playing, and music_play', () => {
    const names = musicTools.map((t) => t.name).sort();
    expect(names).toEqual([
      'media_next',
      'media_play_pause',
      'media_previous',
      'music_now_playing',
      'music_play',
    ]);
  });

  it('registers music_play for Spotify track URIs', () => {
    expect(musicTools.find((t) => t.name === 'music_play')).toBeTruthy();
  });
});
