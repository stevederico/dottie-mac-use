/**
 * Window management tools — list, focus, and close macOS windows.
 */

import { logToolUse, runCommandSafe, sanitizeShellArg, tagDomain } from './shared.js';
import { createTool } from './shared.js';

export const windowsTools = tagDomain([
  createTool({
    name: 'window_list',
    description: 'List all visible windows on screen right now. Only use when the user asks to see or show their open windows, not for general questions about window management.',
    parameters: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Filter by app name (optional)'
        },
      },
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        // Use JXA (JavaScript for Automation) for better window info
        const script = `
          const se = Application('System Events');
          const results = [];
          const procs = se.applicationProcesses.whose({ backgroundOnly: false });

          for (let i = 0; i < procs.length; i++) {
            const proc = procs[i];
            const appName = proc.name();
            ${input.app ? `if (!appName.toLowerCase().includes('${sanitizeShellArg(input.app.toLowerCase())}')) continue;` : ''}
            try {
              const windows = proc.windows();
              for (let j = 0; j < windows.length; j++) {
                const win = windows[j];
                const title = win.name() || '(untitled)';
                const pos = win.position();
                const size = win.size();
                results.push(appName + ' | ' + title + ' | pos:' + pos[0] + ',' + pos[1] + ' size:' + size[0] + 'x' + size[1]);
              }
            } catch (e) {}
          }
          results.join('\\n');
        `;

        const output = await runCommandSafe('osascript', ['-l', 'JavaScript', '-e', script.replace(/\n/g, ' ')]);

        if (!output || output.trim() === '') {
          const result = input.app
            ? `No windows found for "${input.app}"`
            : 'No visible windows found';
          logToolUse('window_list', input, result);
          return result;
        }

        const result = `Windows:\n${output}`;
        logToolUse('window_list', input, result);
        return result;
      } catch (error) {
        let errorMsg;
        if (error.message.includes('-1743') || error.message.includes('not allowed')) {
          errorMsg = `Permission denied: Enable "Dottie" in System Settings > Privacy & Security > Automation`;
        } else {
          errorMsg = `Failed to list windows: ${error.message}`;
        }
        logToolUse('window_list', input, errorMsg);
        throw new Error(errorMsg);
      }
    },
  }),

  createTool({
    name: 'window_focus',
    description: 'Bring a specific macOS window to the front by app name and optional window title. Use this when the user wants to switch to a particular window, focus an app, or bring a window forward.',
    parameters: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Application name (e.g., "Safari", "Terminal")'
        },
        title: {
          type: 'string',
          description: 'Window title to match (optional, partial match supported)'
        },
      },
      required: ['app'],
    },
    execute: async (input, signal, context) => {
      try {
        let script;
        if (input.title) {
          // Focus specific window by title
          const safeApp = sanitizeShellArg(input.app);
          const safeTitle = sanitizeShellArg(input.title.toLowerCase());
          script = `
            const se = Application('System Events');
            const proc = se.applicationProcesses.byName('${safeApp}');
            const windows = proc.windows();
            let isFound = false;
            for (let i = 0; i < windows.length; i++) {
              const win = windows[i];
              if (win.name().toLowerCase().includes('${safeTitle}')) {
                Application('${safeApp}').activate();
                win.actions['AXRaise'].perform();
                isFound = true;
                break;
              }
            }
            isFound ? 'focused' : 'not_found';
          `;
        } else {
          // Just activate the app (brings frontmost window forward)
          script = `
            Application('${sanitizeShellArg(input.app)}').activate();
            'focused';
          `;
        }

        const output = await runCommandSafe('osascript', ['-l', 'JavaScript', '-e', script.replace(/\n/g, ' ')]);

        if (output.includes('not_found')) {
          const result = `No window found matching "${input.title}" in ${input.app}`;
          logToolUse('window_focus', input, result);
          return result;
        }

        const result = input.title
          ? `Focused window "${input.title}" in ${input.app}`
          : `Focused ${input.app}`;
        logToolUse('window_focus', input, result);
        return result;
      } catch (error) {
        let errorMsg;
        if (error.message.includes('-1743') || error.message.includes('not allowed')) {
          errorMsg = `Permission denied: Enable "Dottie" in System Settings > Privacy & Security > Automation > ${input.app}`;
        } else {
          errorMsg = `Failed to focus window: ${error.message}`;
        }
        logToolUse('window_focus', input, errorMsg);
        throw new Error(errorMsg);
      }
    },
  }),

  createTool({
    name: 'window_close',
    description: 'Close a specific macOS window by app name and optional window title. Use this when the user wants to close a window, dismiss a dialog, or close the frontmost window of an app.',
    parameters: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'Application name (e.g., "Safari", "Terminal")'
        },
        title: {
          type: 'string',
          description: 'Window title to match (optional, partial match supported). If omitted, closes frontmost window.'
        },
      },
      required: ['app'],
    },
    execute: async (input, signal, context) => {
      try {
        let script;
        if (input.title) {
          // Close specific window by title
          const safeApp = sanitizeShellArg(input.app);
          const safeTitle = sanitizeShellArg(input.title.toLowerCase());
          script = `
            const se = Application('System Events');
            const proc = se.applicationProcesses.byName('${safeApp}');
            const windows = proc.windows();
            let isClosed = false;
            for (let i = 0; i < windows.length; i++) {
              const win = windows[i];
              if (win.name().toLowerCase().includes('${safeTitle}')) {
                const closeBtn = win.buttons().find(b => b.subrole() === 'AXCloseButton');
                if (closeBtn) {
                  closeBtn.click();
                  isClosed = true;
                  break;
                }
              }
            }
            isClosed ? 'closed' : 'not_found';
          `;
        } else {
          // Close frontmost window of the app
          script = `
            const se = Application('System Events');
            const proc = se.applicationProcesses.byName('${sanitizeShellArg(input.app)}');
            const win = proc.windows[0];
            if (win) {
              const closeBtn = win.buttons().find(b => b.subrole() === 'AXCloseButton');
              if (closeBtn) {
                closeBtn.click();
                'closed';
              } else {
                'no_button';
              }
            } else {
              'no_window';
            }
          `;
        }

        const output = await runCommandSafe('osascript', ['-l', 'JavaScript', '-e', script.replace(/\n/g, ' ')]);

        if (output.includes('not_found')) {
          const result = `No window found matching "${input.title}" in ${input.app}`;
          logToolUse('window_close', input, result);
          return result;
        }
        if (output.includes('no_window')) {
          const result = `No windows open in ${input.app}`;
          logToolUse('window_close', input, result);
          return result;
        }
        if (output.includes('no_button')) {
          const result = `Could not find close button for ${input.app} window`;
          logToolUse('window_close', input, result);
          return result;
        }

        const result = input.title
          ? `Closed window "${input.title}" in ${input.app}`
          : `Closed frontmost ${input.app} window`;
        logToolUse('window_close', input, result);
        return result;
      } catch (error) {
        let errorMsg;
        if (error.message.includes('-1743') || error.message.includes('not allowed')) {
          errorMsg = `Permission denied: Enable "Dottie" in System Settings > Privacy & Security > Automation > ${input.app}`;
        } else {
          errorMsg = `Failed to close window: ${error.message}`;
        }
        logToolUse('window_close', input, errorMsg);
        throw new Error(errorMsg);
      }
    },
  }),
], 'system');
