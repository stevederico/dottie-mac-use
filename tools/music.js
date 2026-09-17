/**
 * Media control tools — system-wide media key controls + Spotify play.
 */

import { runCommand, runCommandSafe, tagDomain } from './shared.js';
import { createTool } from './shared.js';

/** Extract spotify:track:ID from bare URI or open.spotify.com URL. */
function parseSpotifyTrackUri(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const bare = s.match(/^spotify:track:([A-Za-z0-9]+)$/i);
  if (bare) return `spotify:track:${bare[1]}`;
  const web = s.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/i);
  if (web) return `spotify:track:${web[1]}`;
  return null;
}

export const musicTools = tagDomain([
  createTool({
    name: 'mac_music_play',
    description:
      'Play a track in Spotify from the start. Prefer `uri` (spotify:track:… or open.spotify.com/track/…). ' +
      'With free-text `query` only (no URI), opens Spotify search — for reliable auto-play pass a track URI. ' +
      'Example: Nirvana Smells Like Teen Spirit → uri spotify:track:5ghIJDpPoe3CfHMGu71E6T.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        uri: {
          type: 'string',
          description: 'Spotify track URI (spotify:track:…) or open.spotify.com/track/… URL',
        },
        query: {
          type: 'string',
          description: 'Song/artist search text when URI is unknown (opens Spotify search)',
        },
      },
      required: [],
    },
    execute: async (input) => {
      try {
        const uri = parseSpotifyTrackUri(input.uri) || parseSpotifyTrackUri(input.query);
        if (uri) {
          const safeUri = uri.replace(/"/g, '');
          // Play first (must succeed even if metadata lags).
          await runCommandSafe('osascript', ['-e', `
            tell application "Spotify"
              activate
              play track "${safeUri}"
              set player position to 0
            end tell
          `]);
          // Speak title/artist only — never the spotify:track URI (directReturn → TTS).
          let label = '';
          try {
            label = (await runCommandSafe('osascript', ['-e', `
              tell application "Spotify"
                delay 0.4
                try
                  set trackName to name of current track
                  set artistName to artist of current track
                  return trackName & " by " & artistName
                on error
                  return ""
                end try
              end tell
            `])).trim();
          } catch {
            label = '';
          }
          if (label) return `Playing ${label}`;
          const hint = String(input.query || '').trim();
          if (hint && !parseSpotifyTrackUri(hint)) return `Playing ${hint}`;
          return 'Playing on Spotify';
        }
        const q = String(input.query || input.uri || '').trim();
        if (!q) {
          return 'Error: pass a song name or Spotify track link';
        }
        // Search only — no reliable AppleScript "play first result"
        const searchUri = `spotify:search:${encodeURIComponent(q)}`;
        await runCommandSafe('open', ['-a', 'Spotify', searchUri]);
        return `Opened Spotify search for ${q}`;
      } catch (error) {
        return `Failed to play: ${error.message}`;
      }
    },
  }),

  // System-wide media controls (work with ANY app - browsers, Spotify, Music, etc.)
  createTool({
    name: 'mac_media_play_pause',
    description: 'Pause or resume whatever is ALREADY playing (toggles the system play/pause key). Use ONLY when the user asks to pause/resume. Never use this to find out what is playing — that is mac_music_now_playing.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        const scriptPath = new URL('./mediakeys.swift', import.meta.url).pathname;
        const result = await runCommand(`swift "${scriptPath}" play`);
        return result;
      } catch (error) {
        const result = `Failed to toggle play/pause: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_media_next',
    description: 'Skip to next track.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        const scriptPath = new URL('./mediakeys.swift', import.meta.url).pathname;
        const result = await runCommand(`swift "${scriptPath}" next`);
        return result;
      } catch (error) {
        const result = `Failed to skip to next track: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_media_previous',
    description: 'Previous track.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        const scriptPath = new URL('./mediakeys.swift', import.meta.url).pathname;
        const result = await runCommand(`swift "${scriptPath}" prev`);
        return result;
      } catch (error) {
        const result = `Failed to go to previous track: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_music_now_playing',
    description: 'Get the currently playing track (name, artist, album) from Spotify or Apple Music. Use for any "what\'s playing / what song is this" question. Read-only — never changes playback.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        // Try Spotify first
        const spotifyScript = `
          tell application "System Events"
            if exists process "Spotify" then
              tell application "Spotify"
                if player state is playing then
                  set trackName to name of current track
                  set artistName to artist of current track
                  set albumName to album of current track
                  return "🎵 " & trackName & " by " & artistName & " (Album: " & albumName & ")"
                else
                  return "SPOTIFY_PAUSED"
                end if
              end tell
            else
              return "NO_SPOTIFY"
            end if
          end tell
        `;

        let result = await runCommandSafe('osascript', ['-e', spotifyScript]);

        if (result.includes('NO_SPOTIFY') || result.includes('SPOTIFY_PAUSED')) {
          // Try Apple Music
          const musicScript = `
            tell application "System Events"
              if exists process "Music" then
                tell application "Music"
                  if player state is playing then
                    set trackName to name of current track
                    set artistName to artist of current track
                    set albumName to album of current track
                    return "🎵 " & trackName & " by " & artistName & " (Album: " & albumName & ")"
                  else
                    return "MUSIC_PAUSED"
                  end if
                end tell
              else
                return "NO_MUSIC"
              end if
            end tell
          `;

          result = await runCommandSafe('osascript', ['-e', musicScript]);
        }

        // `result` holds the LAST script's output (Spotify, or Music if Spotify
        // was absent/paused), so it can only ever contain ONE sentinel — `&&`
        // could never fire and the raw NO_MUSIC sentinel leaked through to TTS.
        if (result.includes('NO_SPOTIFY') || result.includes('NO_MUSIC')) {
          result = 'No music app is currently running.';
        } else if (result.includes('PAUSED')) {
          result = 'Music is paused. Nothing currently playing.';
        }

        return result;
      } catch (error) {
        const result = `Failed to get now playing info: ${error.message}`;
        return result;
      }
    },
  }),
], 'media');
