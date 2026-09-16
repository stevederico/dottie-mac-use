/**
 * Clock tools — countdown timers and alarms.
 *
 * Split out of scheduling.js (which merged calendar.js, reminders.js,
 * clock.js, timers.js). Behavior identical. Timers and alarms share the same
 * on-disk persistence + serialization lock, so they stay co-located here.
 */

import { runCommand, toolOk, confirmTool, parseTime, tagDomain } from './shared.js';
import { createTool } from './shared.js';
import { log } from '../logger.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { DOTTIE_DIR } from '../paths.js';

// ─── Timer/Alarm persistence ─────────────────────────────────────────────────

const TIMERS_FILE = join(DOTTIE_DIR, 'timers.json');

/** In-memory store for active timers (survives within process lifetime). */
const activeTimers = new Map();

/**
 * Serialize all timers.json read-modify-write cycles.
 * A firing timer's callback awaits a ~1s alarm sound before reloading and
 * rewriting the file; without this lock a concurrent timer_set/alarm_set can
 * land between that callback's load and save and get clobbered. Mutations are
 * chained on a single module-level promise so they never interleave.
 */
let persistChain = Promise.resolve();
function withTimerLock(fn) {
  const run = persistChain.then(fn, fn);
  // Keep the chain alive even if fn rejects; swallow here so one failure
  // doesn't poison every later mutation.
  persistChain = run.then(() => {}, () => {});
  return run;
}

/**
 * Load timers from disk.
 * @returns {Promise<Array>}
 */
async function loadTimers() {
  try {
    const data = await fs.readFile(TIMERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * Save timers to disk.
 * @param {Array} timers
 */
async function saveTimers(timers) {
  await fs.mkdir(DOTTIE_DIR, { recursive: true });
  await fs.writeFile(TIMERS_FILE, JSON.stringify(timers, null, 2));
}

/**
 * Play the alarm sound when a timer/alarm fires (repeats 3 times).
 * Sound-only — native macOS notification banners were removed.
 */
async function playAlarmSound() {
  const alarmSound = '/System/Library/Sounds/Ping.aiff';
  await runCommand(`afplay "${alarmSound}" && sleep 0.3 && afplay "${alarmSound}" && sleep 0.3 && afplay "${alarmSound}"`);
}

/**
 * Restore timers from disk on module load.
 * Called once when the module is imported.
 */
async function restoreTimers() {
  try {
    await withTimerLock(async () => {
    const timers = await loadTimers();
    const now = Date.now();
    const active = [];

    for (const timer of timers) {
      const endsAt = new Date(timer.endsAt).getTime();
      const remaining = endsAt - now;

      if (remaining > 0) {
        // Re-schedule the timer
        const timeoutId = setTimeout(async () => {
          await playAlarmSound();
          await withTimerLock(async () => {
            const current = await loadTimers();
            await saveTimers(current.filter(t => t.id !== timer.id));
            activeTimers.delete(timer.id);
          });
        }, remaining);

        activeTimers.set(timer.id, timeoutId);
        active.push(timer);
      }
    }

    // Clean up expired timers
    if (active.length !== timers.length) {
      await saveTimers(active);
    }

    if (active.length > 0) {
      log.info('timers', `Restored ${active.length} timer(s) from disk`);
    }
    });
  } catch (err) {
    log.error('timers', 'Failed to restore timers', err, { category: 'TOOL' });
  }
}

// Restore timers on module load
restoreTimers();

/**
 * Parse duration string to milliseconds.
 * Supports: "5 minutes", "30 seconds", "1 hour", "90 min", "2h 30m"
 * @param {string} duration
 * @returns {number} milliseconds
 */
function parseDuration(duration) {
  const str = duration.toLowerCase().trim();
  let totalMs = 0;

  // Match patterns like "5 minutes", "30 sec", "1 hour", "2h", "30m", "45s"
  const patterns = [
    { regex: /(\d+)\s*h(?:ours?)?/g, multiplier: 60 * 60 * 1000 },
    { regex: /(\d+)\s*m(?:in(?:utes?)?)?/g, multiplier: 60 * 1000 },
    { regex: /(\d+)\s*s(?:ec(?:onds?)?)?/g, multiplier: 1000 },
  ];

  for (const { regex, multiplier } of patterns) {
    let match;
    while ((match = regex.exec(str)) !== null) {
      totalMs += parseInt(match[1], 10) * multiplier;
    }
  }

  // If no pattern matched, try parsing as just a number (assume minutes)
  if (totalMs === 0) {
    const num = parseInt(str, 10);
    if (!isNaN(num)) {
      totalMs = num * 60 * 1000;
    }
  }

  return totalMs;
}

/**
 * Format milliseconds as human-readable duration.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours} hour${hours > 1 ? 's' : ''}`;
  }
  if (minutes > 0) {
    return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  }
  return `${seconds} second${seconds > 1 ? 's' : ''}`;
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export const timerTools = tagDomain([

  // ── Timers & Alarms ────────────────────────────────────────────────────────

  createTool({
    name: 'timer_set',
    description: 'Set a countdown timer.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        duration: {
          type: 'string',
          description: 'How long the timer should run (e.g., "5 minutes", "30 seconds", "1h 30m")'
        },
        label: {
          type: 'string',
          description: 'Optional label for the timer (e.g., "pasta", "laundry")'
        },
      },
      required: ['duration'],
    },
    execute: async (input) => {
      const ms = parseDuration(input.duration);
      if (ms <= 0) {
        const result = `Could not parse duration: "${input.duration}". Try "5 minutes", "30 seconds", or "1 hour".`;
        return result;
      }

      return withTimerLock(async () => {
      // Deduplication: skip if same duration timer was set in last 5 seconds
      const timers = await loadTimers();
      const now = Date.now();
      const recentDupe = timers.find(t => {
        const createdAt = new Date(t.endsAt).getTime() - parseDuration(t.duration);
        return t.duration === input.duration && (now - createdAt) < 5000;
      });
      if (recentDupe) {
        const endsAt = new Date(recentDupe.endsAt);
        const result = `Timer already running for ${formatDuration(ms)}. Ends at ${endsAt.toLocaleTimeString()}.`;
        return result;
      }

      const id = `timer_${Date.now()}`;
      const label = input.label || 'Timer';
      const endsAt = new Date(Date.now() + ms);
      timers.push({ id, label, endsAt: endsAt.toISOString(), duration: input.duration });
      await saveTimers(timers);

      // Set the actual timeout
      const timeoutId = setTimeout(async () => {
        await playAlarmSound();
        // Remove from stored timers
        await withTimerLock(async () => {
          const current = await loadTimers();
          await saveTimers(current.filter(t => t.id !== id));
          activeTimers.delete(id);
        });
      }, ms);

      activeTimers.set(id, timeoutId);

      const fallback = `Timer set for ${formatDuration(ms)}${input.label ? ` (${input.label})` : ''}. Ends at ${endsAt.toLocaleTimeString()}.`;
      const result = toolOk(fallback, {
        component: "timer",
        version: 1,
        data: {
          id: id,
          label: label,
          duration: formatDuration(ms),
          endsAt: endsAt.toISOString(),
          isAlarm: false
        },
        fallback
      });
      return result;
      });
    },
  }),

  createTool({
    name: 'timer_list',
    description: 'List active timers.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
    execute: async (input) => {
      return withTimerLock(async () => {
      const timers = await loadTimers();
      const now = Date.now();

      // Filter out expired timers
      const active = timers.filter(t => new Date(t.endsAt).getTime() > now);
      await saveTimers(active);

      if (active.length === 0) {
        const result = 'No active timers.';
        return result;
      }

      const lines = active.map(t => {
        const remaining = new Date(t.endsAt).getTime() - now;
        return `- ${t.label}: ${formatDuration(remaining)} remaining (ends ${new Date(t.endsAt).toLocaleTimeString()})`;
      });

      const result = `Active timers:\n${lines.join('\n')}`;
      return result;
      });
    },
  }),

  createTool({
    name: 'timer_cancel',
    description: 'Cancel a timer.',
    _internalParams: ['confirmed'],
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Timer label to cancel (omit to cancel all)'
        },
      },
      required: [],
    },
    execute: async (input) => {
      return withTimerLock(async () => {
      const timers = await loadTimers();

      if (input.label) {
        const timer = timers.find(t => t.label.toLowerCase() === input.label.toLowerCase());
        if (!timer) {
          const result = `No timer found with label "${input.label}".`;
          return result;
        }

        // Clear the timeout if it's in memory
        if (activeTimers.has(timer.id)) {
          clearTimeout(activeTimers.get(timer.id));
          activeTimers.delete(timer.id);
        }

        await saveTimers(timers.filter(t => t.id !== timer.id));
        const result = `Cancelled timer: ${timer.label}`;
        return result;
      }

      // Cancel all — gate behind a confirmation dialog. Previously this
      // wiped every active timer on a single LLM call, with no user check.
      if (!input.confirmed) {
        if (timers.length === 0) {
          const result = 'No timers to cancel.';
          return result;
        }
        const result = confirmTool({
          toolName: 'timer_cancel',
          input,
          title: 'Cancel all timers?',
          message: `This will cancel all ${timers.length} active timer${timers.length === 1 ? '' : 's'}.`,
          confirmLabel: 'Cancel All',
          destructive: true,
        });
        return result;
      }

      for (const [id, timeoutId] of activeTimers) {
        clearTimeout(timeoutId);
      }
      activeTimers.clear();
      await saveTimers([]);

      const result = `Cancelled ${timers.length} timer(s).`;
      return result;
      });
    },
  }),

  createTool({
    name: 'alarm_set',
    description: 'Set an alarm.',
    directReturn: true,
    parameters: {
      type: 'object',
      properties: {
        time: {
          type: 'string',
          description: 'Time for the alarm (e.g., "7am", "3:30pm", "15:00")'
        },
        label: {
          type: 'string',
          description: 'Optional label for the alarm (e.g., "Wake up", "Meeting")'
        },
      },
      required: ['time'],
    },
    execute: async (input) => {
      const target = parseTime(input.time);
      if (!target) {
        const result = `Could not parse time: "${input.time}". Try "7am", "3:30pm", or "15:00".`;
        return result;
      }

      return withTimerLock(async () => {
      // Deduplication: skip if same time alarm was set in last 5 seconds
      const timers = await loadTimers();
      const now = Date.now();
      const recentDupe = timers.find(t => {
        if (t.type !== 'alarm') return false;
        const createdAt = parseInt(t.id.split('_')[1], 10);
        return t.time === input.time && (now - createdAt) < 5000;
      });
      if (recentDupe) {
        const result = `Alarm already set for ${target.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
        return result;
      }

      const ms = target.getTime() - Date.now();
      const id = `alarm_${Date.now()}`;
      const label = input.label || 'Alarm';
      timers.push({ id, label, endsAt: target.toISOString(), type: 'alarm', time: input.time });
      await saveTimers(timers);

      // Set the timeout
      const timeoutId = setTimeout(async () => {
        await playAlarmSound();
        await withTimerLock(async () => {
          const current = await loadTimers();
          await saveTimers(current.filter(t => t.id !== id));
          activeTimers.delete(id);
        });
      }, ms);

      activeTimers.set(id, timeoutId);

      const dayStr = target.toDateString() === new Date().toDateString() ? 'today' : 'tomorrow';
      const fallback = `Alarm set for ${target.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} ${dayStr}${input.label ? ` (${input.label})` : ''}.`;
      const result = toolOk(fallback, {
        component: "timer",
        version: 1,
        data: {
          id: id,
          label: label,
          duration: formatDuration(ms),
          endsAt: target.toISOString(),
          isAlarm: true
        },
        fallback
      });
      return result;
      });
    },
  }),

  createTool({
    name: 'alarm_cancel',
    description: 'Cancel an alarm.',
    _internalParams: ['confirmed'],
    parameters: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Alarm label to cancel (omit to cancel all alarms)'
        },
      },
      required: [],
    },
    execute: async (input) => {
      return withTimerLock(async () => {
      const timers = await loadTimers();
      const alarms = timers.filter(t => t.type === 'alarm');

      if (input.label) {
        const alarm = alarms.find(t => t.label.toLowerCase() === input.label.toLowerCase());
        if (!alarm) {
          const result = `No alarm found with label "${input.label}".`;
          return result;
        }

        if (activeTimers.has(alarm.id)) {
          clearTimeout(activeTimers.get(alarm.id));
          activeTimers.delete(alarm.id);
        }

        await saveTimers(timers.filter(t => t.id !== alarm.id));
        const result = `Cancelled alarm: ${alarm.label}`;
        return result;
      }

      // Cancel all alarms — gate behind a confirmation dialog.
      if (!input.confirmed) {
        if (alarms.length === 0) {
          const result = 'No alarms to cancel.';
          return result;
        }
        const result = confirmTool({
          toolName: 'alarm_cancel',
          input,
          title: 'Cancel all alarms?',
          message: `This will cancel all ${alarms.length} active alarm${alarms.length === 1 ? '' : 's'}.`,
          confirmLabel: 'Cancel All',
          destructive: true,
        });
        return result;
      }

      for (const alarm of alarms) {
        if (activeTimers.has(alarm.id)) {
          clearTimeout(activeTimers.get(alarm.id));
          activeTimers.delete(alarm.id);
        }
      }
      await saveTimers(timers.filter(t => t.type !== 'alarm'));

      const result = `Cancelled ${alarms.length} alarm(s).`;
      return result;
      });
    },
  }),
], 'schedule');
