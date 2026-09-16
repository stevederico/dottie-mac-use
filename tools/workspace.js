/**
 * Workspace file tools for Dottie desktop agent.
 * Provides read/write access to ~/.dottie/workspace/ folder.
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { toolOk, tagDomain } from './shared.js';

const WORKSPACE_DIR = path.join(os.homedir(), '.dottie', 'workspace');

/**
 * Ensure workspace directory exists.
 */
function ensureWorkspace() {
  if (!existsSync(WORKSPACE_DIR)) {
    mkdirSync(WORKSPACE_DIR, { recursive: true });
  }
}

/**
 * Resolve a relative path to absolute workspace path.
 * Prevents directory traversal attacks.
 */
function resolvePath(relativePath) {
  const normalized = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, '');
  const absolute = path.join(WORKSPACE_DIR, normalized);
  if (!absolute.startsWith(WORKSPACE_DIR)) {
    throw new Error('Path must be within workspace');
  }
  return absolute;
}

export const workspaceTools = tagDomain([
  {
    name: 'workspace_write',
    description: 'Write a raw text file to the agent workspace (~/.dottie/workspace/). ' +
      'Use ONLY for generated code, scripts, drafts, or files the user explicitly asked to be saved as a file. ' +
      'DO NOT use for tasks/todos (use task_create), notes (use notes_create), reminders (use reminder_create), ' +
      'calendar events (use calendar_create), or memory (use user_memory_append). ' +
      'If the user says "create a task / note / reminder / event", load the right domain via tool_search instead.',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename or relative path within workspace (e.g., "script.py", "notes/todo.md")',
        },
        content: {
          type: 'string',
          description: 'Content to write to the file',
        },
      },
      required: ['filename', 'content'],
    },
    execute: async (input) => {
      try {
        ensureWorkspace();
        const filePath = resolvePath(input.filename);
        const dir = path.dirname(filePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(filePath, input.content, 'utf-8');
        return `Saved ${input.filename} (${input.content.length} chars) to workspace`;
      } catch (err) {
        return `Error writing file: ${err.message}`;
      }
    },
  },

  {
    name: 'workspace_read',
    description: 'Read a raw text file from the agent workspace (~/.dottie/workspace/). ' +
      'Use ONLY to review files previously saved with workspace_write. ' +
      'DO NOT use to look up tasks (use task_list), notes (use notes_list), reminders (use reminder_list), or events (use calendar_list).',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename or relative path within workspace',
        },
      },
      required: ['filename'],
    },
    execute: async (input) => {
      try {
        ensureWorkspace();
        const filePath = resolvePath(input.filename);
        if (!existsSync(filePath)) {
          return `File not found: ${input.filename}`;
        }
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          return `${input.filename} is a directory, use workspace_list instead`;
        }
        const content = readFileSync(filePath, 'utf-8');
        const maxChars = 50000;
        if (content.length > maxChars) {
          return content.slice(0, maxChars) + `\n\n... [truncated, file is ${content.length} chars]`;
        }
        return content || '(empty file)';
      } catch (err) {
        return `Error reading file: ${err.message}`;
      }
    },
  },

  {
    name: 'workspace_list',
    description: 'List files and folders in the agent workspace (~/.dottie/workspace/). Use this to see what files are available.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Subdirectory to list (optional, defaults to root of workspace)',
        },
      },
    },
    execute: async (input) => {
      try {
        ensureWorkspace();
        const dirPath = input.path ? resolvePath(input.path) : WORKSPACE_DIR;
        if (!existsSync(dirPath)) {
          return `Directory not found: ${input.path || '/'}`;
        }
        const entries = readdirSync(dirPath, { withFileTypes: true });
        if (entries.length === 0) {
          return 'Workspace is empty';
        }
        const lines = entries.map(entry => {
          const icon = entry.isDirectory() ? '📁' : '📄';
          if (entry.isFile()) {
            const stat = statSync(path.join(dirPath, entry.name));
            return `${icon} ${entry.name} (${stat.size} bytes)`;
          }
          return `${icon} ${entry.name}/`;
        });
        return lines.join('\n');
      } catch (err) {
        return `Error listing workspace: ${err.message}`;
      }
    },
  },

  {
    name: 'workspace_delete',
    description: 'Delete a file from the agent workspace (~/.dottie/workspace/). Shows a confirmation dialog before deleting. Do NOT pass confirmed parameter - the user must confirm via the dialog.',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename or relative path to delete',
        },
      },
      required: ['filename'],
    },
    // Internal: 'confirmed' is passed by UIActionHandler callback, not by LLM
    _internalParams: ['confirmed'],
    execute: async (input) => {
      ensureWorkspace();
      const filePath = resolvePath(input.filename);

      if (!existsSync(filePath)) {
        return `File not found: ${input.filename}`;
      }
      const stat = statSync(filePath);
      if (stat.isDirectory()) {
        return `Cannot delete directory: ${input.filename}. Only files can be deleted.`;
      }

      // If confirmed, perform the delete
      if (input.confirmed) {
        try {
          unlinkSync(filePath);
          return `Deleted ${input.filename}`;
        } catch (err) {
          return `Error deleting file: ${err.message}`;
        }
      }

      // Show confirmation dialog
      const fileSize = stat.size;
      return toolOk(`Delete "${input.filename}" (${fileSize} bytes) from workspace?`, {
        component: 'confirmation_dialog',
        version: 1,
        id: `workspace_delete_${Date.now()}`,
        data: {
          title: 'Delete File?',
          message: `Delete "${input.filename}" (${fileSize} bytes) from workspace?`,
          destructive: true
        },
        actions: [
          { id: 'confirm', label: 'Delete', style: 'destructive', tool: 'workspace_delete', input: { filename: input.filename, confirmed: true } },
          { id: 'cancel', label: 'Cancel' }
        ]
      });
    },
  },

  {
    name: 'workspace_path',
    description: 'Get the full path to the agent workspace folder. Use this when you need to tell the user where files are saved.',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => {
      ensureWorkspace();
      return WORKSPACE_DIR;
    },
  },
], 'dev');
