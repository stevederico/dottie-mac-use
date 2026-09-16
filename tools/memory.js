/**
 * User memory tools — read, update, and append to the user's personal context file.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { USER_MEMORY_PATH, DEFAULT_USER_MEMORY, tagDomain } from './shared.js';
import { createTool } from './shared.js';

export const memoryTools = tagDomain([
  createTool({
    name: 'user_memory_get',
    description: 'Recall user preferences.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        // Ensure .dottie directory exists
        const dottieDir = path.join(os.homedir(), '.dottie');
        await fs.mkdir(dottieDir, { recursive: true });

        // Check if file exists
        try {
          const content = await fs.readFile(USER_MEMORY_PATH, 'utf-8');
          const result = content || '[User memory is empty]';
          return result;
        } catch (err) {
          if (err.code === 'ENOENT') {
            // Create default file
            await fs.writeFile(USER_MEMORY_PATH, DEFAULT_USER_MEMORY, 'utf-8');
            const result = DEFAULT_USER_MEMORY;
            return result;
          }
          throw err;
        }
      } catch (error) {
        const result = `Failed to read user memory: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'user_memory_update',
    description: 'Update the user\'s personal memory/context file. Use this when the user asks you to remember something about themselves or their preferences.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'New content to append to user memory (markdown format)'
        },
        replace: {
          type: 'boolean',
          description: 'If true, replace entire file. If false (default), append to existing content.'
        },
      },
      required: ['content'],
    },
    execute: async (input, signal, context) => {
      try {
        // Ensure .dottie directory exists
        const dottieDir = path.join(os.homedir(), '.dottie');
        await fs.mkdir(dottieDir, { recursive: true });

        if (input.replace) {
          // Replace entire file
          await fs.writeFile(USER_MEMORY_PATH, input.content, 'utf-8');
          const result = 'User memory replaced';
          return result;
        } else {
          // Append to existing content
          let existing = '';
          try {
            existing = await fs.readFile(USER_MEMORY_PATH, 'utf-8');
          } catch (err) {
            if (err.code !== 'ENOENT') throw err;
            existing = DEFAULT_USER_MEMORY;
          }
          const newContent = existing.trim() + '\n\n' + input.content;
          await fs.writeFile(USER_MEMORY_PATH, newContent, 'utf-8');
          const result = 'User memory updated';
          return result;
        }
      } catch (error) {
        const result = `Failed to update user memory: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'user_memory_append',
    description: 'Store a user preference.',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'Note to append to the user memory'
        },
        section: {
          type: 'string',
          description: 'Optional section header to append under (e.g., "Notes", "Preferences")'
        },
      },
      required: ['note'],
    },
    execute: async (input, signal, context) => {
      try {
        const dottieDir = path.join(os.homedir(), '.dottie');
        await fs.mkdir(dottieDir, { recursive: true });

        let content;
        try {
          content = await fs.readFile(USER_MEMORY_PATH, 'utf-8');
        } catch {
          content = DEFAULT_USER_MEMORY;
        }

        const timestamp = new Date().toLocaleDateString();
        const noteWithDate = `- ${input.note} (${timestamp})`;

        if (input.section) {
          const sectionRegex = new RegExp(`(## ${input.section}[^#]*)`, 'i');
          if (sectionRegex.test(content)) {
            content = content.replace(sectionRegex, `$1\n${noteWithDate}`);
          } else {
            content += `\n\n## ${input.section}\n${noteWithDate}`;
          }
        } else {
          if (content.includes('## Notes')) {
            content = content.replace(/(## Notes[^#]*)/, `$1\n${noteWithDate}`);
          } else {
            content += `\n\n## Notes\n${noteWithDate}`;
          }
        }

        await fs.writeFile(USER_MEMORY_PATH, content, 'utf-8');
        const result = `Added to user memory: "${input.note.substring(0, 50)}${input.note.length > 50 ? '...' : ''}"`;
        return result;
      } catch (error) {
        const result = `Failed to append to user memory: ${error.message}`;
        return result;
      }
    },
  }),
], 'info');
