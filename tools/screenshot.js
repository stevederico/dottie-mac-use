/**
 * Screenshot tools — capture screen, window, or selection.
 * Vision analysis uses the calling chat agent (cloud), not local llama.
 */

import path from 'path';
import os from 'os';
import fs from 'fs';
import { logToolUse, runCommand, tagDomain } from './shared.js';
import { createTool } from './shared.js';
import { analyzeWithAgentVision } from '../vision_client.js';

export const screenshotTools = tagDomain([
  createTool({
    name: 'mac_screenshot',
    description: 'Capture the screen.',
    parameters: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Type: "screen" (full screen), "window" (frontmost window), "selection" (interactive). Default: screen'
        },
        filename: {
          type: 'string',
          description: 'Output filename (saved to Desktop by default). If not provided, uses timestamp.'
        },
      },
      required: [],
    },
    domain: 'media',
    execute: async (input, signal, context) => {
      try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const filename = input.filename || `screenshot-${timestamp}.png`;
        const filepath = path.join(os.homedir(), 'Desktop', filename);

        let command;
        switch (input.type) {
          case 'window':
            command = `screencapture -w "${filepath}"`;
            break;
          case 'selection':
            command = `screencapture -i "${filepath}"`;
            break;
          default:
            command = `screencapture -x "${filepath}"`;
        }

        await runCommand(command);
        const result = `Screenshot saved: ~/Desktop/${filename}`;
        return result;
      } catch (error) {
        const result = `Failed to take mac_screenshot: ${error.message}`;
        return result;
      }
    },
  }),
  createTool({
    name: 'mac_screenshot_and_analyze',
    description: 'Take a mac_screenshot and analyze the VISUAL CONTENT with AI vision. Use this when you need to actually SEE what is displayed — code, text, images, designs, errors, UI elements, charts, documents. This is different from mac_window_list which only shows window titles. Use mac_screenshot_and_analyze when the user asks to "look at", "see", "read", "review", "check", or "help with" something visible on screen, or when they reference "this" without providing content.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'What to analyze or look for in the mac_screenshot. Default: "Describe what you see on screen."'
        },
        type: {
          type: 'string',
          description: 'Capture type: "screen" (full screen), "window" (frontmost window). Default: window'
        },
      },
      required: [],
    },
    domain: 'computer_use',
    execute: async (input, signal, context) => {
      const question = input.question || 'Describe what you see on screen and help the user with whatever they appear to be working on.';
      const captureType = input.type || 'window';

      try {
        const tempFile = path.join(os.tmpdir(), `dottie-vision-${Date.now()}.png`);
        const captureCmd = captureType === 'window'
          ? `screencapture -w -x "${tempFile}"`
          : `screencapture -x "${tempFile}"`;

        await runCommand(captureCmd);

        let base64Image;
        try {
          const imageBuffer = fs.readFileSync(tempFile);
          base64Image = imageBuffer.toString('base64');
        } finally {
          try { fs.unlinkSync(tempFile); } catch { /* file may not exist */ }
        }

        const analysis = await analyzeWithAgentVision({ base64Image, question });
        logToolUse('mac_screenshot_and_analyze', { question, type: captureType }, analysis);
        return analysis;
      } catch (error) {
        const result = `Failed to analyze screen: ${error.message}`;
        logToolUse('mac_screenshot_and_analyze', input, result);
        return result;
      }
    },
  }),
], 'media');
