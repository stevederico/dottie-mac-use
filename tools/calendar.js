/**
 * Calendar tools — list/create/update/delete macOS Calendar events.
 *
 * Split out of scheduling.js (which merged calendar.js, reminders.js,
 * clock.js, timers.js). Behavior identical.
 */

import { confirmTool, escapeAppleScript, runAppleScript, axFetch, tagDomain } from './shared.js';
import { createTool } from './shared.js';

/** @see escapeAppleScript — alias kept so the script interpolation sites read tersely. */
const escapeAS = escapeAppleScript;

export const calendarTools = tagDomain([

  createTool({
    name: 'mac_calendar_list',
    // No directReturn: conversational Q&A ("who's speaking?") needs a second
    // LLM turn over the event list. Fallback text includes titles for that turn
    // (agent_bridge strips `_ui` to fallback for the model).
    description: 'List upcoming calendar events. Pick `days` based on the question: "today" → 1, "tomorrow" → 2, "this week" → 7, "next two weeks" → 14, "this month" → 30. Default 7. After the list returns, answer the user\'s question from the titles (do not dump the whole list).',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to look ahead. Use 1 for "today", 2 for "tomorrow", 7 for "this week", 14 for "next two weeks", 30 for "this month". Default 7.'
        },
        calendar: {
          type: 'string',
          description: 'Specific calendar name (default: all calendars)'
        },
      },
      required: [],
    },
    execute: async (input, signal, context) => {
      // Coerce: `days` is interpolated raw into the MacUseService query string
      // (unlike `calendar`, which is encodeURIComponent'd), so a non-numeric
      // value could smuggle extra query params.
      const days = Math.min(Number(input.days) || 7, 365);
      try {
        const path = `/calendar/list?days=${days}${input.calendar ? `&calendar=${encodeURIComponent(input.calendar)}` : ''}`;
        // First call may block briefly on the EventKit TCC prompt; subsequent
        // calls are <50ms. 30s is overkill for normal flow but keeps us from
        // failing if the user is slow to click "OK" on the first prompt.
        const body = await axFetch(path, { timeout: 30000 });
        const data = JSON.parse(body);
        if (data.error) {
          const result = data.message || `Calendar error: ${data.error}`;
          return result;
        }

        const events = (data.events || []).map(e => ({
          title: e.title,
          startDate: e.startDate,
          endDate: e.endDate,
          calendar: e.calendar,
          location: e.location,
          isAllDay: e.isAllDay,
        }));

        const result = events.length > 0
          ? `${events.length} event(s) in the next ${days} days. Titles: ` + events
            .slice(0, 40)
            .map((e) => e.title)
            .filter(Boolean)
            .join(' · ')
          : `No events in the next ${days} days`;
        return result;
      } catch (error) {
        const result = `Failed to list calendar: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_calendar_create',
    description: 'Create a calendar event.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Event title'
        },
        date: {
          type: 'string',
          description: 'Date (e.g., "tomorrow", "Friday", "2024-12-25")'
        },
        time: {
          type: 'string',
          description: 'Time (e.g., "3pm", "14:00")'
        },
        duration: {
          type: 'number',
          description: 'Duration in minutes (default: 60)'
        },
        calendar: {
          type: 'string',
          description: 'Calendar name (default: first calendar)'
        },
      },
      required: ['title'],
    },
    execute: async (input, signal, context) => {
      // Coerce, don't trust the schema: `duration` is interpolated raw into the
      // AppleScript below, and AppleScript can `do shell script`. Number()
      // turns a hostile string into NaN (inert text), never source.
      const duration = Math.min(Number(input.duration) || 60, 1440);
      try {
        // Parse date and time
        const [year, month, day] = input.date.split('-').map(Number);
        const [hours, minutes] = input.time.split(':').map(Number);

        const script = `
          tell application "Calendar"
            ${input.calendar ? `set targetCal to calendar "${escapeAS(input.calendar)}"` : 'set targetCal to first calendar'}

            set startDate to current date
            set year of startDate to ${year}
            set month of startDate to ${month}
            set day of startDate to ${day}
            set hours of startDate to ${hours}
            set minutes of startDate to ${minutes}
            set seconds of startDate to 0

            set endDate to startDate + (${duration} * minutes)

            tell targetCal
              make new event with properties {summary:"${escapeAS(input.title)}", start date:startDate, end date:endDate}
            end tell

            return "Created event: ${escapeAS(input.title)}"
          end tell
        `;
        await runAppleScript(script);
        const result = `Created event: "${input.title}" on ${input.date} at ${input.time}`;
        return result;
      } catch (error) {
        const result = `Failed to create event: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_calendar_update',
    description: 'Update a calendar event.',
    requiresPermission: 'calendar.destructive',
    requiresConfirmation: true,
    _internalParams: ['confirmed'],
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Current event title to find'
        },
        date: {
          type: 'string',
          description: 'Event date to search (e.g., "2024-12-25")'
        },
        calendar: {
          type: 'string',
          description: 'Calendar name (default: searches all calendars)'
        },
        newTitle: {
          type: 'string',
          description: 'New event title (optional)'
        },
        newDate: {
          type: 'string',
          description: 'New date (e.g., "2024-12-26") (optional)'
        },
        newTime: {
          type: 'string',
          description: 'New start time in 24h format (e.g., "15:00") (optional)'
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to confirm the update'
        },
      },
      required: ['title', 'date'],
    },
    execute: async (input, signal, context) => {
      if (!input.confirmed) {
        const changes = [];
        if (input.newTitle) changes.push(`rename to "${input.newTitle}"`);
        if (input.newDate) changes.push(`move to ${input.newDate}`);
        if (input.newTime) changes.push(`reschedule to ${input.newTime}`);
        return confirmTool({
          toolName: 'mac_calendar_update',
          input,
          title: `Update event "${input.title}" on ${input.date}?`,
          message: `Changes: ${changes.join(', ') || 'none specified'}`,
          confirmLabel: 'Update',
        });
      }

      try {
        const [year, month, day] = input.date.split('-').map(Number);

        // Build update statements
        const updates = [];
        if (input.newTitle) {
          updates.push(`set summary of targetEvent to "${escapeAS(input.newTitle)}"`);
        }
        if (input.newDate || input.newTime) {
          const newDateParts = input.newDate ? input.newDate.split('-').map(Number) : [year, month, day];
          const timeParts = input.newTime ? input.newTime.split(':').map(Number) : null;

          updates.push(`
            set newStart to start date of targetEvent
            set year of newStart to ${newDateParts[0]}
            set month of newStart to ${newDateParts[1]}
            set day of newStart to ${newDateParts[2]}
            ${timeParts ? `set hours of newStart to ${timeParts[0]}` : ''}
            ${timeParts ? `set minutes of newStart to ${timeParts[1]}` : ''}
            set start date of targetEvent to newStart
          `);
        }

        const script = `
          tell application "Calendar"
            ${input.calendar ? `set targetCal to calendar "${escapeAS(input.calendar)}"` : 'set targetCal to first calendar'}

            set searchDate to current date
            set year of searchDate to ${year}
            set month of searchDate to ${month}
            set day of searchDate to ${day}
            set hours of searchDate to 0
            set minutes of searchDate to 0

            set endSearchDate to searchDate + (1 * days)

            set matchingEvents to (events of targetCal whose summary is "${escapeAS(input.title)}" and start date >= searchDate and start date < endSearchDate)

            if (count of matchingEvents) = 0 then
              return "Event not found: ${escapeAS(input.title)} on ${input.date}"
            end if

            set targetEvent to first item of matchingEvents
            ${updates.join('\n            ')}

            return "Updated event"
          end tell
        `;
        await runAppleScript(script);
        const result = `Updated event: "${input.title}"`;
        return result;
      } catch (error) {
        const result = `Failed to update event: ${error.message}`;
        return result;
      }
    },
  }),

  createTool({
    name: 'mac_calendar_delete',
    description: 'Delete a calendar event.',
    requiresPermission: 'calendar.destructive',
    requiresConfirmation: true,
    _internalParams: ['confirmed'],
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Event title to delete'
        },
        date: {
          type: 'string',
          description: 'Event date (e.g., "2024-12-25")'
        },
        calendar: {
          type: 'string',
          description: 'Calendar name (default: searches all calendars)'
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true to confirm deletion'
        },
      },
      required: ['title', 'date'],
    },
    execute: async (input, signal, context) => {
      if (!input.confirmed) {
        return confirmTool({
          toolName: 'mac_calendar_delete',
          input,
          title: `Delete event "${input.title}" on ${input.date}?`,
          message: 'This cannot be undone.',
          confirmLabel: 'Delete',
          destructive: true,
        });
      }

      try {
        const [year, month, day] = input.date.split('-').map(Number);

        const script = `
          tell application "Calendar"
            ${input.calendar ? `set targetCal to calendar "${escapeAS(input.calendar)}"` : 'set targetCal to first calendar'}

            set searchDate to current date
            set year of searchDate to ${year}
            set month of searchDate to ${month}
            set day of searchDate to ${day}
            set hours of searchDate to 0
            set minutes of searchDate to 0

            set endSearchDate to searchDate + (1 * days)

            set matchingEvents to (events of targetCal whose summary is "${escapeAS(input.title)}" and start date >= searchDate and start date < endSearchDate)

            if (count of matchingEvents) = 0 then
              return "Event not found: ${escapeAS(input.title)} on ${input.date}"
            end if

            delete first item of matchingEvents
            return "Deleted event"
          end tell
        `;
        await runAppleScript(script);
        const result = `Deleted event: "${input.title}" on ${input.date}`;
        return result;
      } catch (error) {
        const result = `Failed to delete event: ${error.message}`;
        return result;
      }
    },
  }),
], 'schedule');
