/**
 * Scheduling tools — barrel that recombines the per-domain splits.
 *
 * The implementations now live in calendar.js, reminders.js, and timer.js
 * (the latter holding world clock + timers/alarms + shopping list, which share
 * one on-disk persistence lock). This file preserves the original
 * `schedulingTools` aggregate and `parseDateTime` re-export so existing
 * importers (custom_tools.js, the test suite) need no changes.
 */

import { calendarTools } from './calendar.js';
import { reminderTools, parseDateTime } from './reminders.js';
import { timerTools } from './timer.js';

export { parseDateTime };

export const schedulingTools = [
  ...calendarTools,
  ...reminderTools,
  ...timerTools,
];
