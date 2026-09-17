/**
 * App management tools — open URLs, manage apps, get frontmost app, type text.
 */

import { spawn } from 'node:child_process';
import { runCommand, runCommandSafe, sanitizeShellArg, escapeAppleScript, tagDomain, axFetch, createTool } from './shared.js';
import { isAllowedHubURL, openHubWebView } from './hub.js';

export const appsTools = tagDomain([
  createTool({
    name: 'mac_open_url',
    // info domain: tool_search maps "url / browser / open website" → info.
    // When mac_open_url lived only under system, the model searched info, got zero
    // tools, saw safari.* in skipped_scopes, and told the user Open URLs was
    // disabled even with safari.control granted in Settings.
    domain: 'info',
    description:
      'Open a URL in a new browser window (default browser). Always a new window — not a new tab in an existing window. ' +
      'Do NOT use for Grok Hub / hub.grok.me / *.grok.me apps — use mac_hub_open (Dottie WebView) instead. ' +
      'Requires Open URLs (safari.control) permission.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'URL to open (must start with http:// or https://)'
        },
      },
      required: ['url'],
    },
    execute: async (input, signal, context) => {
      // Validate URL format
      if (!input.url.startsWith('http://') && !input.url.startsWith('https://')) {
        return 'Error: URL must start with http:// or https://';
      }

      const url = input.url;

      // Grok Hub / hub apps always open in Dottie's sandboxed WebView, never the browser.
      if (isAllowedHubURL(url)) {
        try {
          await openHubWebView(url);
          return `Opened ${url} in Dottie Grok Hub WebView (not the browser)`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Error: could not open Grok Hub WebView — ${msg}`;
        }
      }
      // Resolve default HTTP handler path (Launch Services via AppKit)
      let appPath = '';
      try {
        appPath = (await runCommandSafe('osascript', [
          '-e',
          'use framework "AppKit"',
          '-e',
          'set u to current application\'s NSURL\'s URLWithString:"https://example.com"',
          '-e',
          'set a to current application\'s NSWorkspace\'s sharedWorkspace()\'s URLForApplicationToOpenURL:u',
          '-e',
          'if a is missing value then return ""',
          '-e',
          'return (a\'s |path|() as text)',
        ])).trim();
      } catch {
        appPath = '';
      }

      const lower = appPath.toLowerCase();
      // Chromium family: --new-window opens a real window, not a tab
      if (
        lower.includes('google chrome') ||
        lower.includes('chromium') ||
        lower.includes('brave') ||
        lower.includes('microsoft edge') ||
        lower.includes('arc.app') ||
        lower.includes('opera') ||
        lower.includes('vivaldi') ||
        lower.includes('dia.app')
      ) {
        const appName = appPath.replace(/\.app\/?$/i, '').split('/').pop();
        // --new-window: real window. Hide crash-restore bubble ("Restore pages?") which
        // shows after kill -9 / unclean exit — demos must never force-kill Chromium.
        await runCommandSafe('open', [
          '-na',
          appName,
          '--args',
          '--new-window',
          '--hide-crash-restore-bubble',
          '--disable-session-crashed-bubble',
          url,
        ]);
        return `Opened ${url} in new ${appName} window`;
      }

      // Safari: new document = new window
      if (lower.includes('safari.app') || appPath === '') {
        // Prefer Safari AS when Safari is default; if path empty, still try Safari then fall back
        if (lower.includes('safari.app')) {
          await runCommandSafe('osascript', [
            '-e',
            `tell application "Safari"
               activate
               make new document with properties {URL:"${escapeAppleScript(url)}"}
             end tell`,
          ]);
          return `Opened ${url} in new Safari window`;
        }
      }

      // Unknown browser: best-effort new instance (-n); may still tab in some apps
      if (appPath) {
        const appName = appPath.replace(/\.app\/?$/i, '').split('/').pop();
        await runCommandSafe('open', ['-na', appName, url]);
        return `Opened ${url} in ${appName}`;
      }

      await runCommandSafe('open', [url]);
      return `Opened ${url} in default browser`;
    },
  }),

  createTool({
    name: 'mac_get_frontmost_app',
    description: 'Get the name of the currently active (frontmost) macOS application. Use this when the user asks what app they are using, what window is active, what application has focus, or which app is in front.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        // Try lsappinfo first (faster, no AppleScript)
        const frontPID = await runCommand('lsappinfo front');
        const appInfo = await runCommand(`lsappinfo info -only name ${frontPID}`);

        // Parse output: "LSDisplayName"="AppName" -> AppName
        const match = appInfo.match(/"LSDisplayName"="([^"]+)"/);
        if (match) {
          return `Frontmost app: ${match[1]}`;
        }
      } catch (error) {
        // Fallback: use ps to get process name. `lsappinfo front` returns an ASN
        // token (e.g. "ASN:0x0-0x1d01d:"), not a numeric PID, so resolve the PID
        // via `lsappinfo info -only pid` before handing it to `ps -p`.
        try {
          const frontASN = await runCommand('lsappinfo front');
          const pidInfo = await runCommand(`lsappinfo info -only pid ${frontASN}`);
          const pidMatch = pidInfo.match(/"pid"\s*=\s*(\d+)/);
          if (!pidMatch) throw new Error('could not resolve PID from ASN');
          const processName = await runCommand(`ps -p ${pidMatch[1]} -o comm=`);
          return `Frontmost app: ${processName}`;
        } catch (fallbackError) {
          return 'Unable to determine frontmost application';
        }
      }

      return 'Unable to determine frontmost application';
    },
  }),

  createTool({
    name: 'mac_type_text_at_cursor',
    description: 'Type text at the current cursor position (requires accessibility permission). Text will be typed into the frontmost application.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to type at cursor position'
        },
      },
      required: ['text'],
    },
    requiresPermission: 'accessibility.execute',
    execute: async (input, signal, context) => {
      // Same HID path as mac_keyboard_type (no Dottie.app deep link).
      await axFetch('/ax/keyboard_type', {
        method: 'POST',
        body: JSON.stringify({ text: input.text }),
      });
      return `Typed text at cursor: "${input.text.substring(0, 50)}${input.text.length > 50 ? '...' : ''}"`;
    },
  }),

  createTool({
    name: 'mac_get_selected_text',
    description: 'Get the currently selected text from the frontmost application (requires accessibility permission)',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        // Detect whether the clipboard currently holds plain text. `pbpaste`
        // only round-trips text — if the user has an image, file, or RTF on the
        // clipboard, snapshotting via pbpaste yields empty/garbled data, and
        // restoring it would silently wipe their original content. So only save
        // (and later restore) the clipboard when it actually holds text.
        let oldClipboard = null;
        try {
          const clipInfo = await runCommandSafe('osascript', ['-e', 'clipboard info']);
          // `clipboard info` lists pasteboard types, e.g. "«class utf8», 12".
          // Treat the clipboard as text only when a string/utf8 type is present.
          if (/«class utf8»|«class ut16»|string/i.test(clipInfo)) {
            oldClipboard = await runCommand('pbpaste');
          }
        } catch (clipError) {
          // Empty clipboard or info failure — leave oldClipboard null (no restore).
        }

        // Simulate Cmd+C to copy selection
        await runCommandSafe('osascript', ['-e', 'tell application "System Events" to keystroke "c" using command down']);

        // Wait for clipboard to update
        await new Promise(resolve => setTimeout(resolve, 200));

        // Read new clipboard
        const selectedText = await runCommand('pbpaste');

        // Restore old clipboard via spawn stdin (no shell interpolation), but
        // only when we captured genuine text above. Non-text clipboard content
        // is left as-is rather than overwritten with an empty pbpaste snapshot.
        if (oldClipboard !== null) {
          await new Promise((resolve, reject) => {
            const p = spawn('pbcopy');
            p.stdin.write(oldClipboard);
            p.stdin.end();
            p.on('close', resolve);
            p.on('error', reject);
          });
        }

        return selectedText || '[No text selected]';
      } catch (error) {
        return `Error getting selected text: ${error.message}`;
      }
    },
  }),

  createTool({
    name: 'mac_open_app',
    description: 'Open an app.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Application name (e.g., "Safari", "Finder", "Terminal")'
        },
      },
      required: ['name'],
    },
    execute: async (input, signal, context) => {
      try {
        await runCommandSafe('open', ['-a', input.name]);
        return `Opened ${input.name}`;
      } catch (error) {
        return `Failed to open ${input.name}: ${error.message}`;
      }
    },
  }),

  createTool({
    name: 'mac_close_app',
    description: 'Quit/close a running macOS application',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Application name to quit (e.g., "Safari", "Notes")'
        },
      },
      required: ['name'],
    },
    execute: async (input, signal, context) => {
      try {
        const safeName = escapeAppleScript(input.name);
        await runCommandSafe('osascript', ['-e', `quit app "${safeName}"`]);
        return `Closed ${input.name}`;
      } catch (error) {
        return `Failed to close ${input.name}: ${error.message}`;
      }
    },
  }),

  createTool({
    name: 'mac_app_list_open',
    description: 'List all currently running applications',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        const script = `
          tell application "System Events"
            set appList to name of every application process whose background only is false
            set AppleScript's text item delimiters to ", "
            return appList as text
          end tell
        `;
        const apps = await runCommandSafe('osascript', ['-e', script]);
        return `Running apps: ${apps}`;
      } catch (error) {
        return `Failed to list apps: ${error.message}`;
      }
    },
  }),

  createTool({
    name: 'mac_app_search',
    description: 'Search for installed applications using Spotlight',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query for application name'
        },
      },
      required: ['query'],
    },
    execute: async (input, signal, context) => {
      try {
        const results = await runCommand(
          `mdfind "kMDItemKind == 'Application'" -name "${sanitizeShellArg(input.query)}" | head -10`
        );
        if (!results) {
          return `No applications found matching "${input.query}"`;
        }
        // Extract just app names from paths
        const apps = results.split('\n').map(path => {
          const match = path.match(/([^/]+)\.app$/);
          return match ? match[1] : path;
        }).join(', ');
        return `Found: ${apps}`;
      } catch (error) {
        return `Search failed: ${error.message}`;
      }
    },
  }),
], 'system');
