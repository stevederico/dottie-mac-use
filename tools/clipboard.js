/**
 * Clipboard tools — read/write macOS pasteboard.
 */

import { execFile } from 'node:child_process';
import { runCommand, tagDomain } from './shared.js';
import { createTool } from './shared.js';

/**
 * Write text to clipboard via pbcopy using stdin pipe (no shell interpolation).
 *
 * @param {string} text - Text to copy to clipboard
 * @returns {Promise<void>}
 */
function writeClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = execFile('pbcopy', [], (err) => {
      if (err) reject(err);
      else resolve();
    });
    child.stdin.write(text);
    child.stdin.end();
  });
}

export const clipboardTools = tagDomain([
  createTool({
    name: 'mac_get_clipboard',
    description: 'Read the current clipboard contents (text only)',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (input, signal, context) => {
      const content = await runCommand('pbpaste');
      const result = content || '[Clipboard is empty]';
      return result;
    },
  }),

  createTool({
    name: 'mac_set_clipboard',
    description: 'Set the clipboard to specified text',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to copy to clipboard'
        },
      },
      required: ['text'],
    },
    execute: async (input, signal, context) => {
      // Use execFile with stdin pipe to avoid shell injection
      await writeClipboard(input.text);
      const result = `Clipboard set to: "${input.text.substring(0, 50)}${input.text.length > 50 ? '...' : ''}"`;
      return result;
    },
  }),
], 'system');
