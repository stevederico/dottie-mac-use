/**
 * Safari tools — list open tabs and drive the user's actual Safari window
 * (not headless Chrome, which is what the agent-lib `browser_*` tools use).
 */

import { logToolUse, runCommandSafe, escapeAppleScript, runAppleScript, tagDomain, axFetch } from './shared.js';
import { createTool } from './shared.js';
import { isAllowedHubURL, openHubWebView } from './hub.js';

const SAFARI_BUNDLE_ID = 'com.apple.Safari';

/** Throws a clear, actionable error when Safari has no running process — the AX
 * snapshot miss ("No element matching...") would otherwise mislead the model. */
async function requireSafariRunning(toolName, input) {
  const running = await runCommandSafe('osascript', ['-e', 'tell application "System Events" to (exists process "Safari")']);
  if (String(running).trim() !== 'true') {
    const msg = 'Safari is not running. Use safari_open_url to open a page first.';
    logToolUse(toolName, input, msg);
    throw new Error(msg);
  }
}

// Multi-domain file: each tool self-tags its own `domain` above; tagDomain just
// carries those `_domain` tags through (the fallback arg is never applied).
export const safariTools = tagDomain([
  createTool({
    name: 'safari_open_url',
    description:
      "Open a URL in the user's Safari browser. Activates Safari and navigates the front tab (or opens a new tab when newTab is true). " +
      'Do NOT use for Grok Hub / hub.grok.me / *.grok.me — use hub_open (Dottie WebView). ' +
      'Use this to start any web flow — checking email in Gmail, opening an airline check-in page, looking up something on a site the user is already logged into. Prefer this over open_url when the next step is to interact with the page. Then interact via safari_click / safari_fill (or ax_tree / ax_wait_for on com.apple.Safari — WebKit exposes the page\'s accessibility tree).',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Absolute URL to open (must be http or https).',
        },
        newTab: {
          type: 'boolean',
          description: 'Open in a new tab instead of replacing the current tab. Default: false.',
        },
      },
      required: ['url'],
    },
    domain: 'computer_use',
    requiresPermission: 'safari.control',
    execute: async (input) => {
      const url = String(input?.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        const msg = 'safari_open_url requires an absolute http(s) URL';
        logToolUse('safari_open_url', input, msg);
        throw new Error(msg);
      }
      // Hub URLs always go to Dottie's sandboxed WebView.
      if (isAllowedHubURL(url)) {
        await openHubWebView(url);
        return `Opened ${url} in Dottie Grok Hub WebView (not Safari)`;
      }
      const newTab = input?.newTab === true;
      const script = newTab
        ? `tell application "Safari"
             activate
             if (count of windows) = 0 then make new document
             tell front window
               set newTabRef to make new tab with properties {URL:"${escapeAppleScript(url)}"}
               set current tab to newTabRef
             end tell
             return URL of current tab of front window
           end tell`
        : `tell application "Safari"
             activate
             open location "${escapeAppleScript(url)}"
             delay 0.2
             return URL of current tab of front window
           end tell`;
      try {
        const finalUrl = await runCommandSafe('osascript', ['-e', script]);
        const result = `Opened ${finalUrl || url} in Safari${newTab ? ' (new tab)' : ''}`;
        return result;
      } catch (error) {
        const msg = `Failed to open URL in Safari: ${error.message}`;
        logToolUse('safari_open_url', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'safari_click',
    description:
      'Click an element on the web page open in Safari (link, button, form control) via the WebKit accessibility tree. Identify the element EITHER by `ref` (e.g. "@e5" from ax_tree on com.apple.Safari) OR by `name` (its visible text, e.g. "Check In", "Sign In") — provide exactly one. Optionally pass `role` (e.g. "button", "link") to disambiguate a name. Use after safari_open_url; use ax_wait_for on com.apple.Safari to wait for the page to load. Destructive labels (Delete, Remove, etc.) ask for confirmation first.',
    parameters: {
      type: 'object',
      properties: {
        ref:  { type: 'string', description: 'Element ref like "@e5" from ax_tree on com.apple.Safari. Provide ref OR name, not both.' },
        name: { type: 'string', description: 'Visible text of the element to click, e.g. "Check In". Provide ref OR name, not both.' },
        role: { type: 'string', description: 'Optional role filter when using name, e.g. "button", "link".' },
        snapshotId: { type: 'string', description: 'Optional snapshot id from the "snapshot:" line of ax_tree. Omit to use the latest tree read.' },
      },
      required: [],
    },
    domain: 'computer_use',
    _internalParams: ['confirmed'],
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        await requireSafariRunning('safari_click', input);
        const body = { bundleId: SAFARI_BUNDLE_ID, mode: 'foreground', confirmed: input.confirmed };
        if (input.ref != null) body.ref = input.ref;
        if (input.name != null) body.name = input.name;
        if (input.role != null) body.role = input.role;
        if (input.snapshotId != null) body.snapshotId = input.snapshotId;
        return await axFetch('/ax/click', { method: 'POST', body: JSON.stringify(body) });
      } catch (error) {
        const msg = `Failed to click in Safari: ${error.message}`;
        logToolUse('safari_click', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'safari_fill',
    description:
      'Type a value into a form field on the web page open in Safari (search box, confirmation number, email field) via the WebKit accessibility tree. Identify the field EITHER by `ref` (from ax_tree on com.apple.Safari) OR by `name` (its visible label or placeholder, e.g. "Confirmation number") — provide exactly one. Use after safari_open_url; use ax_wait_for on com.apple.Safari to wait for the page to load, then safari_click to submit.',
    parameters: {
      type: 'object',
      properties: {
        ref:   { type: 'string', description: 'Element ref like "@e5" from ax_tree on com.apple.Safari. Provide ref OR name, not both.' },
        name:  { type: 'string', description: 'Visible label or placeholder of the field, e.g. "Confirmation number". Provide ref OR name, not both.' },
        role:  { type: 'string', description: 'Optional role filter when using name, e.g. "textfield".' },
        value: { type: 'string', description: 'Text to enter into the field.' },
        snapshotId: { type: 'string', description: 'Optional snapshot id from the "snapshot:" line of ax_tree. Omit to use the latest tree read.' },
      },
      required: ['value'],
    },
    domain: 'computer_use',
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        await requireSafariRunning('safari_fill', input);
        const body = { bundleId: SAFARI_BUNDLE_ID, value: input.value };
        if (input.ref != null) body.ref = input.ref;
        if (input.name != null) body.name = input.name;
        if (input.role != null) body.role = input.role;
        if (input.snapshotId != null) body.snapshotId = input.snapshotId;
        return await axFetch('/ax/fill', { method: 'POST', body: JSON.stringify(body) });
      } catch (error) {
        const msg = `Failed to fill in Safari: ${error.message}`;
        logToolUse('safari_fill', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'safari_tabs',
    description: 'List currently open Safari browser tabs with their URLs and titles. Use this when the user asks about their Safari tabs, open pages, what websites they have open, or wants to see their browsing session. For Chrome or Firefox tabs, suggest the browser_* tools instead.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    domain: 'info',
    execute: async (input, signal, context) => {
      try {
        const script = `
          tell application "Safari"
            set tabList to {}
            repeat with w in windows
              repeat with t in tabs of w
                set end of tabList to (URL of t) & " | " & (name of t)
              end repeat
            end repeat
            set AppleScript's text item delimiters to "\\n"
            if (count of tabList) > 0 then
              return tabList as text
            else
              return "No Safari tabs open"
            end if
          end tell
        `;
        const tabs = await runAppleScript(script);
        const result = tabs || 'No Safari tabs open';
        return result;
      } catch (error) {
        // Safari might not be running
        if (error.message.includes('not running')) {
          const result = 'Safari is not running';
          return result;
        }
        const result = `Failed to get Safari tabs: ${error.message}`;
        return result;
      }
    },
  }),
], 'info');
