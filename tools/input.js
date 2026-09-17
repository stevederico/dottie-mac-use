/**
 * Raw input primitives — low-level mouse/keyboard control via the AX service.
 * These post real HID events: coordinates are GLOBAL SCREEN POINTS (top-left
 * origin) and keyboard events land in whatever app currently has focus. They
 * are the base layer under the AX tools — prefer mac_ax_click/mac_ax_fill (element-
 * targeted, focus-preserving) whenever the app has a usable mac_ax_tree.
 */

import { logToolUse, tagDomain, axFetch, createTool } from './shared.js';

const post = (route, body) => axFetch(route, { method: 'POST', body: JSON.stringify(body) });

export const inputTools = tagDomain([
  createTool({
    name: 'mac_mouse_move',
    description:
      'Move the mouse cursor. Absolute: pass x and y (global points, origin top-left of the main display). Relative: pass dx and/or dy to nudge from where the cursor is now — negative dx is left, negative dy is up. Relative is what voice commands like "move left a bit" need, since you are not told the current cursor position. Returns the resulting position and the main display size, so after one call you can aim at regions ("top-right" ≈ x: width-40, y: 40) without a mac_screenshot. Movement is clamped to the main display.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Absolute global X in points (requires y)' },
        y: { type: 'number', description: 'Absolute global Y in points (requires x)' },
        dx: { type: 'number', description: 'Relative horizontal points; negative is left' },
        dy: { type: 'number', description: 'Relative vertical points; negative is up' },
      },
      // No `required`: the pair is either/or, which JSON Schema can only express
      // with oneOf — and Gemma follows a plain description far more reliably
      // than it follows a schema combinator. The Swift side rejects a call that
      // supplies neither.
    },
    domain: 'computer_use',
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        return await post('/ax/mouse_move', { x: input.x, y: input.y, dx: input.dx, dy: input.dy });
      } catch (error) {
        const msg = `Failed to move mouse: ${error.message}`;
        logToolUse('mac_mouse_move', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_mouse_click',
    description:
      'Click at a global screen coordinate (points), or at the CURRENT cursor position when x/y are omitted (e.g. after mac_mouse_move). button: left (default), right (context menu), or middle. clickCount 2 = double-click. This is a real HID click on whatever is under the point — prefer mac_ax_click when the app has a usable mac_ax_tree.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Global X in points. Omit both x and y to click at the current cursor position.' },
        y: { type: 'number', description: 'Global Y in points.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button, default left.' },
        clickCount: { type: 'integer', description: '1 = single (default), 2 = double-click.' },
      },
      required: [],
    },
    domain: 'computer_use',
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const body = {};
        if (input.x != null) body.x = input.x;
        if (input.y != null) body.y = input.y;
        if (input.button != null) body.button = input.button;
        if (input.clickCount != null) body.clickCount = input.clickCount;
        return await post('/ax/mouse_click', body);
      } catch (error) {
        const msg = `Failed to click: ${error.message}`;
        logToolUse('mac_mouse_click', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_mouse_drag',
    description:
      'Drag with the left mouse button from one global screen coordinate to another (points) — for moving files, sliders, selections, or window edges. Posts a real HID drag with interpolated movement (~350ms).',
    parameters: {
      type: 'object',
      properties: {
        fromX: { type: 'number', description: 'Start X in points' },
        fromY: { type: 'number', description: 'Start Y in points' },
        toX: { type: 'number', description: 'End X in points' },
        toY: { type: 'number', description: 'End Y in points' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
    domain: 'computer_use',
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        return await post('/ax/mouse_drag', { fromX: input.fromX, fromY: input.fromY, toX: input.toX, toY: input.toY });
      } catch (error) {
        const msg = `Failed to drag: ${error.message}`;
        logToolUse('mac_mouse_drag', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_keyboard_type',
    description:
      'Type text into whatever app currently has keyboard focus (raw unicode injection — supports any characters, no modifier combos). Click or mac_mouse_click a field first to focus it. For a specific app in the background use mac_ax_fill; for shortcuts/chords use mac_key_event or mac_ax_press.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type into the focused app.' },
      },
      required: ['text'],
    },
    domain: 'computer_use',
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        return await post('/ax/keyboard_type', { text: input.text });
      } catch (error) {
        const msg = `Failed to type: ${error.message}`;
        logToolUse('mac_keyboard_type', input, msg);
        throw new Error(msg);
      }
    },
  }),
  createTool({
    name: 'mac_key_event',
    description:
      'Send a raw key event to the currently focused app. direction "press" (default) = down+up; "down"/"up" hold and release a key separately (e.g. hold shift while clicking). Supports modifiers (cmd, shift, opt, ctrl) and keys a-z, 0-9, return, tab, space, delete, escape, arrows, f1-f15. Destructive chords (cmd+q, cmd+w, cmd+delete) ask for confirmation. For app-targeted shortcuts that should not depend on focus, prefer mac_ax_press.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name, e.g. "a", "return", "escape", "left".' },
        modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifiers held with the key: cmd, shift, opt, ctrl.' },
        direction: { type: 'string', enum: ['press', 'down', 'up'], description: 'press (default) = down+up; down/up for held keys.' },
      },
      required: ['key'],
    },
    domain: 'computer_use',
    _internalParams: ['confirmed'],
    requiresPermission: 'accessibility.execute',
    execute: async (input) => {
      try {
        const body = { key: input.key, confirmed: input.confirmed };
        if (input.modifiers != null) body.modifiers = input.modifiers;
        if (input.direction != null) body.direction = input.direction;
        return await post('/ax/key_event', body);
      } catch (error) {
        const msg = `Failed to send key event: ${error.message}`;
        logToolUse('mac_key_event', input, msg);
        throw new Error(msg);
      }
    },
  }),
], 'computer_use');

/**
 * The raw primitives, by name. Replace-input mode preloads exactly this set
 * rather than the whole `computer_use` domain — that domain also carries the
 * browser tools (browser_navigate/click/type/…), which declare no scope and so
 * would load for a user who has granted nothing. Flipping "voice drives my
 * mouse" must not quietly hand the model a browser.
 */
export const INPUT_PRIMITIVE_NAMES = Object.freeze(inputTools.map((t) => t.name));
