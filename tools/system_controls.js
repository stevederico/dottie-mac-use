/**
 * System controls: brightness and volume tools.
 *
 * Brightness posts HID media keys via dottie-mac-use-ax (`POST /ax/brightness`).
 * Volume uses AppleScript with Alexa-style 0-10 scale mapping to 0-100%.
 */

import { runCommandSafe, tagDomain, axFetch, createTool } from './shared.js';

// --- Brightness helpers ---

/**
 * Adjust brightness via AX HID media keys.
 *
 * @param {string} direction - "up" or "down"
 * @param {number} steps - Number of steps (1-16)
 */
async function adjustBrightness(direction, steps = 1) {
  const clampedSteps = Math.min(16, Math.max(1, steps));
  return axFetch('/ax/brightness', {
    method: 'POST',
    body: JSON.stringify({ direction, steps: clampedSteps }),
  });
}

// --- Volume helpers ---

/**
 * Get current system volume (0-100).
 *
 * @returns {Promise<number>} Current volume level
 */
async function getCurrentVolume() {
  const result = await runCommandSafe('osascript', ['-e', 'output volume of (get volume settings)']);
  return parseInt(result.trim(), 10) || 0;
}

/**
 * Set system volume (0-100).
 *
 * @param {number} level - Volume level 0-100
 */
async function setVolume(level) {
  const clamped = Math.max(0, Math.min(100, Math.round(level)));
  await runCommandSafe('osascript', ['-e', `set volume output volume ${clamped}`]);
  return clamped;
}

// --- Exported tools ---

export const systemControlsTools = tagDomain([
  // Brightness
  createTool({
    name: 'mac_brightness_up',
    description: 'Increase screen brightness.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'number',
          description: 'Number of steps to increase (default 1, max 16)',
        },
      },
    },
    execute: async (input, signal, context) => {
      try {
        const steps = input.steps || 1;
        await adjustBrightness('up', steps);
        const result = `Brightness increased by ${steps} step${steps > 1 ? 's' : ''}`;
        return result;
      } catch (err) {
        const result = `Error increasing brightness: ${err.message}`;
        return result;
      }
    },
  }),
  createTool({
    name: 'mac_brightness_down',
    description: 'Decrease screen brightness.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        steps: {
          type: 'number',
          description: 'Number of steps to decrease (default 1, max 16)',
        },
      },
    },
    execute: async (input, signal, context) => {
      try {
        const steps = input.steps || 1;
        await adjustBrightness('down', steps);
        const result = `Brightness decreased by ${steps} step${steps > 1 ? 's' : ''}`;
        return result;
      } catch (err) {
        const result = `Error decreasing brightness: ${err.message}`;
        return result;
      }
    },
  }),
  // Volume
  createTool({
    name: 'mac_volume_set',
    description: 'Set volume level.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        level: {
          type: 'number',
          description: 'Volume level: 0-10 (Alexa-style) or 0-100 (percentage). Values 0-10 are multiplied by 10 unless percent is true.',
        },
        percent: {
          type: 'boolean',
          description: 'If true, treat level as a direct 0-100 percentage (no 0-10 scaling). Use to reach the 1-10% band.',
        },
      },
      required: ['level'],
    },
    execute: async (input, signal, context) => {
      try {
        let { level, percent } = input;

        // Alexa-style: 0-10 maps to 0-100% (skipped when caller passes percent:true)
        if (!percent && level <= 10) {
          level = level * 10;
        }

        const newLevel = await setVolume(level);
        const result = `Volume set to ${newLevel}%`;
        return result;
      } catch (err) {
        const result = `Error setting volume: ${err.message}`;
        return result;
      }
    },
  }),
  createTool({
    name: 'mac_volume_up',
    description: 'Volume up.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        const current = await getCurrentVolume();
        const newLevel = await setVolume(current + 10);
        const result = `Volume increased to ${newLevel}%`;
        return result;
      } catch (err) {
        const result = `Error increasing volume: ${err.message}`;
        return result;
      }
    },
  }),
  createTool({
    name: 'mac_volume_down',
    description: 'Volume down.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        const current = await getCurrentVolume();
        const newLevel = await setVolume(current - 10);
        const result = `Volume decreased to ${newLevel}%`;
        return result;
      } catch (err) {
        const result = `Error decreasing volume: ${err.message}`;
        return result;
      }
    },
  }),
  createTool({
    name: 'mac_volume_mute',
    description: 'Toggle mute.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        mute: {
          type: 'boolean',
          description: 'true to mute, false to unmute. Omit to toggle.',
        },
      },
    },
    execute: async (input, signal, context) => {
      try {
        const { mute } = input;

        if (mute === undefined) {
          // Toggle
          const isMuted = await runCommandSafe('osascript', ['-e', 'output muted of (get volume settings)']);
          const newState = isMuted.trim() === 'true' ? 'without' : 'with';
          await runCommandSafe('osascript', ['-e', `set volume ${newState} output muted`]);
          const result = newState === 'with' ? 'Audio muted' : 'Audio unmuted';
          return result;
        }

        const state = mute ? 'with' : 'without';
        await runCommandSafe('osascript', ['-e', `set volume ${state} output muted`]);
        const result = mute ? 'Audio muted' : 'Audio unmuted';
        return result;
      } catch (err) {
        const result = `Error toggling mute: ${err.message}`;
        return result;
      }
    },
  }),
  createTool({
    name: 'mac_volume_get',
    description: 'Get volume level.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async (input, signal, context) => {
      try {
        const level = await getCurrentVolume();
        const isMuted = await runCommandSafe('osascript', ['-e', 'output muted of (get volume settings)']);
        const muted = isMuted.trim() === 'true';
        const result = muted ? `Volume: ${level}% (muted)` : `Volume: ${level}%`;
        return result;
      } catch (err) {
        const result = `Error getting volume: ${err.message}`;
        return result;
      }
    },
  }),
], 'system');
