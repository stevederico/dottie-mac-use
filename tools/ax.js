/**
 * Accessibility (AX) tools — read and interact with macOS UI elements
 * via the AX service on port 1319.
 */

import { createTool } from './shared.js';
import { logToolUse, axFetch, tagDomain } from './shared.js';
import { locateAndClick } from './computer_vision.js';

export const axTools = tagDomain([
  createTool({
    name: 'mac_ax_apps',
    description:
      'List all running macOS applications with their bundle IDs, process IDs, and window count. Use this to find the bundleId needed for mac_ax_tree, mac_ax_click, and other ax_ tools.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    requiresPermission: 'accessibility.read',
    execute: async (input) => {
      try {
        const result = await axFetch('/ax/apps');
        return result;
      } catch (error) {
        const msg = `Failed to list apps: ${error.message}`;
        logToolUse('mac_ax_apps', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_tree',
    description:
      'Inspect the UI element tree of a Mac app. Returns an indented tree; each interactive element has a ref like "@e5". The FIRST line is "snapshot: snap-N" — pass that snapshotId to mac_ax_click/mac_ax_fill/etc. to bind an action to this exact tree read (refs are only valid within their snapshot). Prefer acting by element name with mac_ax_click; use refs/snapshotId when names are ambiguous.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: {
          type: 'string',
          description: 'App bundle identifier from mac_ax_apps',
        },
        depth: {
          type: 'integer',
          description: 'Max tree depth to traverse (default 6)',
        },
        interactiveOnly: {
          type: 'boolean',
          description: 'Only show interactive elements (buttons, inputs, links)',
        },
        maxElements: {
          type: 'integer',
          description: 'Maximum number of elements to return (default 500)',
        },
        windowIndex: {
          type: 'integer',
          description: 'Index of the window to traverse (0 = front window). Omit to traverse all windows.',
        },
      },
      required: ['bundleId'],
    },
    requiresPermission: 'accessibility.read',
    execute: async (input) => {
      try {
        const params = new URLSearchParams();
        params.set('bundleId', input.bundleId);
        if (input.depth != null) params.set('depth', String(input.depth));
        if (input.interactiveOnly != null) params.set('interactiveOnly', String(input.interactiveOnly));
        if (input.maxElements != null) params.set('maxElements', String(input.maxElements));
        if (input.windowIndex != null) params.set('windowIndex', String(input.windowIndex));
        const result = await axFetch(`/ax/tree?${params}`, { timeout: 15000 });
        return result;
      } catch (error) {
        const msg = `Failed to read UI tree: ${error.message}`;
        logToolUse('mac_ax_tree', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_focused',
    description:
      'Get the currently focused application and UI element. Shows what the user is currently interacting with, including the element\'s role, name, value, and its path in the UI hierarchy.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    requiresPermission: 'accessibility.read',
    execute: async (input) => {
      try {
        const result = await axFetch('/ax/focused');
        return result;
      } catch (error) {
        const msg = `Failed to get focused element: ${error.message}`;
        logToolUse('mac_ax_focused', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_click',
    description:
      'Click a UI element in a macOS app. Prefer this AX click over mac_screen_click — it is faster, more reliable, and does not steal focus. Identify the element EITHER by `ref` (e.g. "@e5" from the most recent mac_ax_tree) OR by `name` (the element\'s visible label, e.g. "Save", "Sign In") — provide exactly one. Optionally pass `role` (e.g. "button") to disambiguate a name, and `snapshotId` (from the "snapshot:" line of mac_ax_tree) to bind the click to a specific tree read. Clicks run in the background by default (no focus steal); set mode:"foreground" to bring the app frontmost first. Falls back automatically to a coordinate click if the AX press fails. Destructive actions (Delete, Remove, Trash, etc.) ask for confirmation first. Use mac_screen_click only for Chromium/Electron/CEF apps whose mac_ax_tree is empty.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: { type: 'string', description: 'App bundle identifier from mac_ax_apps' },
        ref:      { type: 'string', description: 'Element ref like "@e5" from mac_ax_tree. Provide ref OR name, not both.' },
        name:     { type: 'string', description: 'Visible label of the element to click, e.g. "Save". Provide ref OR name, not both.' },
        role:     { type: 'string', description: 'Optional role filter when using name, e.g. "button", "link".' },
        mode:     { type: 'string', enum: ['background', 'foreground'], description: 'background (default, no focus steal) or foreground (activate app first).' },
        snapshotId: { type: 'string', description: 'Optional snapshot id from the "snapshot:" line of mac_ax_tree. Omit to use the latest tree read.' },
      },
      required: ['bundleId'],
    },
    _internalParams: ['confirmed'],
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const body = {
          bundleId: input.bundleId,
          confirmed: input.confirmed,
        };
        if (input.ref != null) body.ref = input.ref;
        if (input.name != null) body.name = input.name;
        if (input.role != null) body.role = input.role;
        if (input.mode != null) body.mode = input.mode;
        if (input.snapshotId != null) body.snapshotId = input.snapshotId;
        const result = await axFetch('/ax/click', { method: 'POST', body: JSON.stringify(body) });
        return result;
      } catch (error) {
        const msg = `Failed to click element: ${error.message}`;
        logToolUse('mac_ax_click', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_screen_click',
    description:
      'LAST-RESORT visual click for Chromium/Electron/CEF apps (Spotify, Discord) whose mac_ax_tree is empty or unusable. Prefer mac_ax_click (by name or ref) for every native app — it is faster, focus-preserving, and more reliable. Only use mac_screen_click when mac_ax_tree returns no usable elements. Describe WHAT to click in plain language (e.g. "the play button", "the first search result") and the model finds it on screen and clicks it. Ideal for Chromium/Electron/CEF apps (Spotify, Discord) whose mac_ax_tree is empty/unusable. Set clickCount=2 to double-click (e.g. to play a Spotify track row).',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Natural-language description of what to click, e.g. "the play button", "the first search result"',
        },
        bundleId: {
          type: 'string',
          description: 'Bundle id of the CEF/Electron app to target (e.g. com.spotify.client). Uses the frontmost window if omitted.',
        },
        clickCount: {
          type: 'integer',
          description: '1 = single click (default), 2 = double-click',
        },
      },
      required: ['target'],
    },
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const result = await locateAndClick({
          bundleId: input.bundleId,
          appName: undefined,
          targetPrompt: input.target,
          clickCount: input.clickCount || 1,
        });
        return result;
      } catch (error) {
        const msg = `Failed to click "${input.target}": ${error.message}`;
        logToolUse('mac_screen_click', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_fill',
    description:
      'Set the text value of a text field or text area in a macOS app. Identify the element EITHER by `ref` (e.g. "@e5" from the most recent mac_ax_tree) OR by `name` (the field\'s visible label or placeholder, e.g. "Confirmation number") — provide exactly one. Optionally pass `role` to disambiguate a name, and `snapshotId` to bind to a specific tree read. For web pages in Safari, use bundleId com.apple.Safari (WebKit exposes the page into the accessibility tree) — or the mac_safari_fill shortcut.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: {
          type: 'string',
          description: 'App bundle identifier from mac_ax_apps',
        },
        ref: {
          type: 'string',
          description: 'Element ref like "@e5" from mac_ax_tree output. Provide ref OR name, not both.',
        },
        name: {
          type: 'string',
          description: 'Visible label of the field to fill, e.g. "Confirmation number". Provide ref OR name, not both.',
        },
        role: {
          type: 'string',
          description: 'Optional role filter when using name, e.g. "textfield".',
        },
        value: {
          type: 'string',
          description: 'Text to enter into the field',
        },
        snapshotId: {
          type: 'string',
          description: 'Optional snapshot id from the "snapshot:" line of mac_ax_tree. Omit to use the latest tree read.',
        },
      },
      required: ['bundleId', 'value'],
    },
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const body = {
          bundleId: input.bundleId,
          value: input.value,
        };
        if (input.ref != null) body.ref = input.ref;
        if (input.name != null) body.name = input.name;
        if (input.role != null) body.role = input.role;
        if (input.snapshotId != null) body.snapshotId = input.snapshotId;
        const result = await axFetch('/ax/fill', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return result;
      } catch (error) {
        const msg = `Failed to fill element: ${error.message}`;
        logToolUse('mac_ax_fill', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_press',
    description:
      'Send a keyboard shortcut to a macOS app. Activates the app first, then presses the key combination. Format: "cmd+shift+t", "cmd+c", "return", "tab". Destructive shortcuts (cmd+delete, cmd+q) will ask for confirmation first.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: {
          type: 'string',
          description: 'App bundle identifier from mac_ax_apps',
        },
        shortcut: {
          type: 'string',
          description: 'Key combination like "cmd+t", "cmd+shift+n", "return"',
        },
      },
      required: ['bundleId', 'shortcut'],
    },
    _internalParams: ['confirmed'],
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const result = await axFetch('/ax/press', {
          method: 'POST',
          body: JSON.stringify({
            bundleId: input.bundleId,
            shortcut: input.shortcut,
            confirmed: input.confirmed,
          }),
        });
        return result;
      } catch (error) {
        const msg = `Failed to press shortcut: ${error.message}`;
        logToolUse('mac_ax_press', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_menu',
    description:
      'Select a menu bar item in a macOS app. Use > to separate menu levels (e.g., "File>New Window", "Edit>Find>Find..."). Destructive menu items (Delete, Empty Trash) will ask for confirmation first.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: {
          type: 'string',
          description: 'App bundle identifier from mac_ax_apps',
        },
        menuPath: {
          type: 'string',
          description: 'Menu path like "File>New Tab"',
        },
      },
      required: ['bundleId', 'menuPath'],
    },
    _internalParams: ['confirmed'],
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const result = await axFetch('/ax/menu', {
          method: 'POST',
          body: JSON.stringify({
            bundleId: input.bundleId,
            menuPath: input.menuPath,
            confirmed: input.confirmed,
          }),
        });
        return result;
      } catch (error) {
        const msg = `Failed to select menu item: ${error.message}`;
        logToolUse('mac_ax_menu', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_scroll',
    description:
      'Scroll a scrollable UI element in a macOS app. Use this to scroll through lists, web pages, or any ScrollArea. Identify the scrollable element by its ref from mac_ax_tree.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: { type: 'string', description: 'App bundle identifier from mac_ax_apps' },
        ref: { type: 'string', description: 'Element ref like "@e5" from mac_ax_tree output' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'integer', description: 'Number of lines to scroll (default 3)' },
      },
      required: ['bundleId', 'ref', 'direction'],
    },
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const result = await axFetch('/ax/scroll', {
          method: 'POST',
          body: JSON.stringify({
            bundleId: input.bundleId,
            ref: input.ref,
            direction: input.direction,
            amount: input.amount ?? 3,
          }),
        });
        return result;
      } catch (error) {
        const msg = `Failed to scroll: ${error.message}`;
        logToolUse('mac_ax_scroll', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_read',
    description:
      'Read the current attributes of a single UI element (role, name, value, enabled, focused, selected). Use this to verify an action worked without re-reading the full tree.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: { type: 'string', description: 'App bundle identifier from mac_ax_apps' },
        ref: { type: 'string', description: 'Element ref like "@e5" from mac_ax_tree output' },
      },
      required: ['bundleId', 'ref'],
    },
    requiresPermission: 'accessibility.read',
    execute: async (input) => {
      try {
        const result = await axFetch('/ax/read', {
          method: 'POST',
          body: JSON.stringify({ bundleId: input.bundleId, ref: input.ref }),
        });
        return result;
      } catch (error) {
        const msg = `Failed to read element: ${error.message}`;
        logToolUse('mac_ax_read', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_set_value',
    description:
      'Set the value of a non-text UI element — sliders (number), checkboxes/switches (true/false), segmented controls. For text fields, use mac_ax_fill instead.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: { type: 'string', description: 'App bundle identifier from mac_ax_apps' },
        ref: { type: 'string', description: 'Element ref like "@e5" from mac_ax_tree output' },
        value: { description: 'New value — number for sliders, boolean for checkboxes, string for others' },
      },
      required: ['bundleId', 'ref', 'value'],
    },
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const result = await axFetch('/ax/set_value', {
          method: 'POST',
          body: JSON.stringify({ bundleId: input.bundleId, ref: input.ref, value: input.value }),
        });
        return result;
      } catch (error) {
        const msg = `Failed to set value: ${error.message}`;
        logToolUse('mac_ax_set_value', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_select',
    description:
      'Mark a UI element as selected — for tabs, list rows, and popup items where clicking does not trigger the right action. Use mac_ax_click first; fall back to this when click is a no-op.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: { type: 'string', description: 'App bundle identifier from mac_ax_apps' },
        ref: { type: 'string', description: 'Element ref like "@e5" from mac_ax_tree output' },
      },
      required: ['bundleId', 'ref'],
    },
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const result = await axFetch('/ax/select', {
          method: 'POST',
          body: JSON.stringify({ bundleId: input.bundleId, ref: input.ref }),
        });
        return result;
      } catch (error) {
        const msg = `Failed to select: ${error.message}`;
        logToolUse('mac_ax_select', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_show_menu',
    description:
      'Show the context menu (right-click menu) for a UI element. Use mac_ax_tree after to see the menu items, then mac_ax_click on the item you want.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: { type: 'string', description: 'App bundle identifier from mac_ax_apps' },
        ref: { type: 'string', description: 'Element ref like "@e5" from mac_ax_tree output' },
      },
      required: ['bundleId', 'ref'],
    },
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const result = await axFetch('/ax/show_menu', {
          method: 'POST',
          body: JSON.stringify({ bundleId: input.bundleId, ref: input.ref }),
        });
        return result;
      } catch (error) {
        const msg = `Failed to show context menu: ${error.message}`;
        logToolUse('mac_ax_show_menu', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_ax_wait_for',
    description:
      'Wait until a UI element matching the query appears in the app, then return its ref. Use this instead of repeatedly calling mac_ax_tree when waiting for a dialog, menu, or loaded content. Returns error on timeout.',
    parameters: {
      type: 'object',
      properties: {
        bundleId: { type: 'string', description: 'App bundle identifier from mac_ax_apps' },
        query: {
          type: 'object',
          description: 'Match criteria — at least one of role or name must be set',
          properties: {
            role: { type: 'string', description: 'Role to match, case-insensitive substring (e.g. "button")' },
            name: { type: 'string', description: 'Name/title to match, case-insensitive substring' },
          },
        },
        timeoutMs: { type: 'integer', description: 'Total wait budget in ms (default 3000)' },
      },
      required: ['bundleId', 'query'],
    },
    requiresPermission: 'accessibility.read',
    execute: async (input) => {
      try {
        const result = await axFetch('/ax/wait_for', {
          method: 'POST',
          body: JSON.stringify({
            bundleId: input.bundleId,
            query: input.query,
            timeoutMs: input.timeoutMs ?? 3000,
          }),
          timeout: Math.max(15000, (input.timeoutMs ?? 3000) + 2000),
        });
        return result;
      } catch (error) {
        const msg = `Failed to wait for element: ${error.message}`;
        logToolUse('mac_ax_wait_for', input, msg);
        throw new Error(msg);
      }
    },
  }),
], 'computer_use');
