/**
 * Reminder tools — list/create/update/delete macOS Reminders, plus the
 * parseDateTime due-date parser shared with the test suite.
 *
 * Split out of scheduling.js (which merged calendar.js, reminders.js,
 * clock.js, timers.js). Behavior identical.
 */

import { confirmTool, escapeAppleScript, runAppleScript, parseTime, tagDomain } from './shared.js';
import { createTool } from './shared.js';

/** @see escapeAppleScript — alias kept so the script interpolation sites read tersely. */
const escapeAS = escapeAppleScript;

/**
 * Parse a due-date string into a Date, or null if it can't be understood.
 * Handles, in order: "today"/"tomorrow [at] <time>", a bare time ("3pm",
 * "15:00") via parseTime, a date-only ISO string (YYYY-MM-DD, parsed as LOCAL
 * 9am to avoid the UTC-midnight-rolls-to-previous-day trap), and finally any
 * absolute datetime `new Date()` accepts (e.g. ISO 8601 "2026-06-19T15:00:00").
 * Relative phrases like "next Monday" are intentionally NOT supported — the
 * caller should surface an error rather than silently pick the wrong day.
 * @param {string} str
 * @returns {Date|null}
 */
export function parseDateTime(str) {
  if (!str) return null;
  const s = String(str).trim();
  const lower = s.toLowerCase();

  // "today"/"tomorrow", optionally followed by a time ("tomorrow at 3pm").
  const rel = lower.match(/^(today|tomorrow)\b(?:\s+at)?\s*(.*)$/);
  if (rel) {
    const base = new Date();
    if (rel[1] === 'tomorrow') base.setDate(base.getDate() + 1);
    const timePart = rel[2].trim();
    if (timePart) {
      const t = parseTime(timePart);
      if (!t) return null;
      base.setHours(t.getHours(), t.getMinutes(), 0, 0);
    } else {
      base.setHours(9, 0, 0, 0); // default to 9am when only a day is given
    }
    return base;
  }

  // Bare time ("3pm", "15:00") → next occurrence today/tomorrow.
  const bareTime = parseTime(s);
  if (bareTime) return bareTime;

  // Date-only ISO (YYYY-MM-DD): parse as LOCAL 9am, not UTC midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T09:00:00`);
    return isNaN(d.getTime()) ? null : d;
  }

  // Any absolute datetime new Date() accepts (ISO 8601 with time, etc.).
  const abs = new Date(s);
  return isNaN(abs.getTime()) ? null : abs;
}

export const reminderTools = tagDomain([

  createTool({
    name: 'mac_reminder_update',
    description: 'Update a reminder.',
    requiresPermission: 'reminders.destructive',
    requiresConfirmation: true,
    _internalParams: ['confirmed'],
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Current reminder title to find'
        },
        list: {
          type: 'string',
          description: 'Reminders list name (default: "Reminders")'
        },
        newTitle: {
          type: 'string',
          description: 'New title (optional)'
        },
        completed: {
          type: 'boolean',
          description: 'Mark as completed (optional)'
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to confirm the update'
        },
      },
      required: ['title'],
    },
    execute: async (input, signal, context) => {
      if (!input.confirmed) {
        const changes = [];
        if (input.newTitle) changes.push(`rename to "${input.newTitle}"`);
        if (input.completed !== undefined) changes.push(input.completed ? 'mark complete' : 'mark incomplete');
        return confirmTool({
          toolName: 'mac_reminder_update',
          input,
          title: `Update reminder "${input.title}"?`,
          message: `Changes: ${changes.join(', ') || 'none specified'}`,
          confirmLabel: 'Update',
        });
      }

      const listName = input.list || 'Reminders';
      try {
        const updates = [];
        if (input.newTitle) updates.push(`set name of targetReminder to "${escapeAS(input.newTitle)}"`);
        // Ternary, not raw interpolation: the schema says `boolean` but nothing
        // enforces it, and a string would land as AppleScript source (which can
        // `do shell script`). Matches mac_reminder_list's `whose completed is` site.
        if (input.completed !== undefined) updates.push(`set completed of targetReminder to ${input.completed ? 'true' : 'false'}`);

        const script = `
          tell application "Reminders"
            set targetList to list "${escapeAS(listName)}"
            set targetReminder to first reminder of targetList whose name is "${escapeAS(input.title)}"
            ${updates.join('\n            ')}
            return "Updated reminder"
          end tell
        `;
        await runAppleScript(script);
        const result = `Updated reminder: "${input.title}"`;
        return result;
      } catch (error) {
        const result = `Failed to update reminder: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_reminder_delete',
    description: 'Delete a reminder.',
    requiresPermission: 'reminders.destructive',
    requiresConfirmation: true,
    _internalParams: ['confirmed'],
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Reminder title to delete'
        },
        list: {
          type: 'string',
          description: 'Reminders list name (default: "Reminders")'
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to confirm deletion'
        },
      },
      required: ['title'],
    },
    execute: async (input, signal, context) => {
      if (!input.confirmed) {
        return confirmTool({
          toolName: 'mac_reminder_delete',
          input,
          title: `Delete reminder "${input.title}"?`,
          message: 'This cannot be undone.',
          confirmLabel: 'Delete',
          destructive: true,
        });
      }

      const listName = input.list || 'Reminders';
      try {
        const script = `
          tell application "Reminders"
            set targetList to list "${escapeAS(listName)}"
            set targetReminder to first reminder of targetList whose name is "${escapeAS(input.title)}"
            delete targetReminder
            return "Deleted reminder"
          end tell
        `;
        await runAppleScript(script);
        const result = `Deleted reminder: "${input.title}"`;
        return result;
      } catch (error) {
        const result = `Failed to delete reminder: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_reminder_create',
    description: 'Create a reminder.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Reminder title/description'
        },
        list: {
          type: 'string',
          description: 'Reminders list name (default: "Reminders")'
        },
        dueDate: {
          type: 'string',
          description: 'Due date/time. Prefer absolute ISO 8601 (e.g. "2026-06-19T15:00:00"). Also accepts "today"/"tomorrow [at] <time>" and bare times like "3pm". Relative phrases like "next Monday" are not supported — resolve to an absolute date first.'
        },
      },
      required: ['title'],
    },
    execute: async (input, signal, context) => {
      const listName = input.list || 'Reminders';

      // Resolve the due date up front. A prior version hardcoded `current date`
      // inside the script and ignored input.dueDate entirely, so every reminder
      // was due "now". Parse it here and fail loudly rather than silently wrong.
      let due = null;
      if (input.dueDate) {
        due = parseDateTime(input.dueDate);
        if (!due) {
          const result = `Couldn't understand the due date "${input.dueDate}". Use an absolute date/time like "2026-06-19T15:00:00", or "tomorrow at 3pm".`;
          return result;
        }
      }

      try {
        let script;
        if (due) {
          // Set the due-date components explicitly (locale-safe; mirrors
          // mac_calendar_create) instead of relying on AppleScript to parse a
          // natural-language string.
          script = `
            tell application "Reminders"
              set targetList to list "${escapeAS(listName)}"
              set dueTime to current date
              set year of dueTime to ${due.getFullYear()}
              set month of dueTime to ${due.getMonth() + 1}
              set day of dueTime to ${due.getDate()}
              set hours of dueTime to ${due.getHours()}
              set minutes of dueTime to ${due.getMinutes()}
              set seconds of dueTime to 0
              tell targetList
                set newReminder to make new reminder with properties {name:"${escapeAS(input.title)}", due date:dueTime}
              end tell
              return "Created reminder: ${escapeAS(input.title)}"
            end tell
          `;
        } else {
          script = `
            tell application "Reminders"
              set targetList to list "${escapeAS(listName)}"
              tell targetList
                make new reminder with properties {name:"${escapeAS(input.title)}"}
              end tell
              return "Created reminder: ${escapeAS(input.title)}"
            end tell
          `;
        }
        await runAppleScript(script);
        const result = `Created reminder: "${input.title}" in ${listName}`;
        return result;
      } catch (error) {
        const result = `Failed to create reminder: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_reminder_list',
    description: 'List reminders.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        list: {
          type: 'string',
          description: 'Reminders list name (default: shows all lists)'
        },
        showCompleted: {
          type: 'boolean',
          description: 'Include completed reminders (default: false)'
        },
      },
      required: [],
    },
    execute: async (input, signal, context) => {
      try {
        let script;
        if (input.list) {
          script = `
            tell application "Reminders"
              set targetList to list "${escapeAS(input.list)}"
              set reminderNames to {}
              repeat with r in (reminders of targetList whose completed is ${input.showCompleted ? 'true' : 'false'})
                set end of reminderNames to name of r
              end repeat
              set AppleScript's text item delimiters to "\\n- "
              if (count of reminderNames) > 0 then
                return "- " & (reminderNames as text)
              else
                return "No reminders found"
              end if
            end tell
          `;
        } else {
          script = `
            tell application "Reminders"
              set allReminders to {}
              repeat with reminderList in lists
                repeat with r in (reminders of reminderList whose completed is false)
                  set end of allReminders to (name of reminderList) & ": " & (name of r)
                end repeat
              end repeat
              set AppleScript's text item delimiters to "\\n- "
              if (count of allReminders) > 0 then
                return "- " & (allReminders as text)
              else
                return "No incomplete reminders"
              end if
            end tell
          `;
        }
        const reminders = await runAppleScript(script);
        const result = reminders || 'No reminders found';
        return result;
      } catch (error) {
        const result = `Failed to list reminders: ${error.message}`;
        return result;
      }
    },
  }),
], 'schedule');
