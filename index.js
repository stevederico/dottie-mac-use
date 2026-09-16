/**
 * dottie-mac-use — Mac hands tool catalog (JS half).
 *
 * AX / EventKit HTTP bridge lives in the app:
 *   client/Dottie/MacUseService.swift  (:1319)
 *
 * This package is the named tools (AX, AppleScript, shell, APIs) the agent
 * and (later) MCP expose. Gateway loads them via custom_tools.js re-export.
 */

export { createTool } from './tools/shared.js';

import { clipboardTools } from './tools/clipboard.js';
import { appsTools } from './tools/apps.js';
import { hubTools } from './tools/hub.js';
import { windowsTools } from './tools/windows.js';
import { schedulingTools } from './tools/scheduling.js';
import { contactsTools } from './tools/contacts.js';
import { mailTools } from './tools/mail.js';
import { notesTools } from './tools/notes.js';
import { safariTools } from './tools/safari.js';
import { filesTools } from './tools/files.js';
import { musicTools } from './tools/music.js';
import { memoryTools } from './tools/memory.js';
import { screenshotTools } from './tools/screenshot.js';
import { systemControlsTools } from './tools/system_controls.js';
import { systemTools } from './tools/system.js';
import { phoneTools } from './tools/phone.js';
import { imessageTools } from './tools/imessage.js';
import { workspaceTools } from './tools/workspace.js';
import { axTools } from './tools/ax.js';
import { inputTools } from './tools/input.js';
import { webTools } from './tools/web.js';
import { tasksTools } from './tools/tasks.js';
import { webReaderTools } from './tools/web_reader.js';
import { presentChoicesTools } from './tools/present_choices.js';

export const customTools = [
  ...clipboardTools,
  ...appsTools,
  ...hubTools,
  ...windowsTools,
  ...schedulingTools,
  ...contactsTools,
  ...mailTools,
  ...notesTools,
  ...safariTools,
  ...filesTools,
  ...musicTools,
  ...memoryTools,
  ...screenshotTools,
  ...systemControlsTools,
  ...systemTools,
  ...phoneTools,
  ...imessageTools,
  ...workspaceTools,
  ...axTools,
  ...inputTools,
  ...webTools,
  ...tasksTools,
  ...webReaderTools,
  ...presentChoicesTools,
];
