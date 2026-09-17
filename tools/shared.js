/**
 * Shared utilities and constants for custom macOS tools.
 */

import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { readAgentToken } from '../agent_token.js';
import { DOTTIE_DIR } from '../paths.js';
import { log } from '../logger.js';
import { ensureAxRunning, axBaseUrl } from '../ax_process.js';

export const execAsync = promisify(exec);
export const execFileAsync = promisify(execFile);

/** Base URL of the AX HTTP service (standalone CLI or prior spawn). */
export const AX_BASE = axBaseUrl();

/**
 * Make an authenticated request to the AX service (port 1319).
 * Ensures dottie-mac-use-ax is running, then Bearer-auths.
 * @param {string} path - URL path (e.g., '/ax/apps')
 * @param {object} [options] - fetch options override (method, body, headers, timeout)
 * @returns {Promise<string>} Response body text
 */
export async function axFetch(path, options = {}) {
  await ensureAxRunning();
  const token = readAgentToken();
  const res = await fetch(`${axBaseUrl()}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeout || 10000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || `AX service returned ${res.status}`);
  }
  return res.text();
}

/** Path to dottie-memory.md file */
export const USER_MEMORY_PATH = path.join(DOTTIE_DIR, 'dottie-memory.md');

/** Default content for new dottie-memory.md file */
export const DEFAULT_USER_MEMORY = `# User Memory

This is your personal context file. Add information about yourself that you want Dottie to remember across all conversations.

## About Me
- Name:
- Location:
- Occupation:

## Preferences
- Communication style:
- Favorite topics:

## Notes
Add any other context here...
`;

/**
 * Log a tool invocation with timestamp, name, and I/O snippet.
 *
 * @param {string} toolName - Name of the tool being called
 * @param {object} input - Tool input parameters
 * @param {string} result - Tool result (will be truncated to 100 chars)
 */
export function logToolUse(toolName, input, result) {
  const timestamp = new Date().toISOString();
  const resultSnippet = typeof result === 'string'
    ? result.substring(0, 100) + (result.length > 100 ? '...' : '')
    : JSON.stringify(result).substring(0, 100);
  console.log(`[TOOL] ${timestamp} - ${toolName}`, { input, result: resultSnippet });
}

/**
 * Sanitize a string for safe inclusion in shell arguments.
 * Strips every character that can break out of a shell command or alter
 * its control flow: backticks, $, \, !, ", ', the command/redirect
 * metacharacters ; | & ( ) < >, and any control character (newline, CR,
 * etc.). This makes the value safe to splice into a command string whether
 * or not the call site wraps it in quotes — the previous version left
 * ; | & ( ) and newlines intact, so a value like `a; reboot` stayed
 * injectable outside a quoted context.
 *
 * @param {string} str - Untrusted input
 * @returns {string} Sanitized string
 */
export function sanitizeShellArg(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/[`$\\!"';|&()<>\x00-\x1f]/g, '');
}

/**
 * Execute a shell command and return stdout.
 *
 * @param {string} command - Shell command to execute
 * @returns {Promise<string>} Command output
 */
export async function runCommand(command) {
  try {
    const { stdout } = await execAsync(command);
    return stdout.trim();
  } catch (error) {
    const details = error.stderr || error.message;
    throw new Error(`Command failed: ${details}`);
  }
}

/**
 * Execute a command safely using execFile (no shell interpolation).
 *
 * @param {string} file - Executable path
 * @param {string[]} args - Array of arguments (not shell-interpreted)
 * @returns {Promise<string>} Command stdout
 */
export async function runCommandSafe(file, args) {
  try {
    const { stdout } = await execFileAsync(file, args);
    return stdout.trim();
  } catch (error) {
    const details = error.stderr || error.message;
    throw new Error(`Command failed: ${details}`);
  }
}

/**
 * Standard success envelope for a tool result. Returns a JSON string so
 * existing callers (which pass raw strings to the LLM) keep working while
 * clients that parse `_ui` can find it. For plain text use `toolOk(text)`
 * — the returned value is just `text`. The `_ui` path returns a JSON
 * envelope the frontend recognizes.
 *
 * @param {string} text - Human-readable result for the LLM
 * @param {object} [ui] - Optional _ui component payload
 * @returns {string}
 */
export function toolOk(text, ui) {
  if (!ui) return text;
  return JSON.stringify({ _ui: ui, text });
}

/**
 * Tag a tool array with its lazy-load domain *at the source file*. This is the
 * single source of truth for "which tool belongs to which domain" — tool_config
 * builds its TOOL_DOMAINS map by reading these `_domain` tags off the registry
 * instead of re-listing every tool name by hand.
 *
 * Per-tool wins: a tool that already declares its own `_domain` (e.g. a
 * multi-domain file that tagged individual tools inline) keeps it. Everything
 * else in the array inherits `domain`.
 *
 * @param {Array} tools - tool configs/objects exported by a tools/*.js file
 * @param {string} domain - 'core' or one of the TOOL_SEARCH_DOMAINS buckets
 * @returns {Array} the same tools, each carrying a `_domain`
 */
export function tagDomain(tools, domain) {
  return tools.map(t => (t._domain ? t : { ...t, _domain: domain }));
}

/**
 * Standard failure envelope for a tool result. Returns a human-readable
 * string prefixed with the tool name and failure code so the LLM can
 * reason about the error. Use instead of throwing from execute(): thrown
 * errors leak stack traces into the model context and make failures
 * indistinguishable from crashes.
 *
 * @param {string} name - Tool name (e.g. 'mac_mail_send')
 * @param {string} code - Short uppercase code (e.g. 'VALIDATION', 'EXECUTION', 'PERMISSION')
 * @param {string} message - Human-readable detail
 * @returns {string}
 */
export function toolError(name, code, message) {
  return `[${name}] ${code}: ${message}`;
}

/**
 * Wraps a tool config in a standard contract:
 *   - runs optional `validate(input)` before execute
 *   - catches thrown errors and converts them to toolError() strings
 *   - carries metadata (_permissions, _formatter, _internal, requiresConfirmation)
 *     through to tool_config / registry consumers
 *
 * Lives in shared.js (not custom_tools.js) so the per-subsystem tool files can
 * import it without forming an import cycle with the custom_tools.js barrel,
 * which imports every tool file. custom_tools.js re-exports it for compat.
 *
 * @param {object} config
 * @param {string} config.name
 * @param {string} config.description
 * @param {object} config.parameters - JSON Schema
 * @param {(input: object, signal?: AbortSignal, context?: object) => Promise<any>} config.execute
 * @param {(input: object) => Promise<[boolean, string?]>|[boolean, string?]} [config.validate]
 * @param {string[]} [config.permissions] - scope names from tool_config.TOOL_PERMISSIONS
 * @param {'text'|'ui'|'json'} [config.formatter]
 * @param {string[]} [config._internalParams]
 * @param {boolean} [config.requiresConfirmation]
 */
export function createTool(config) {
  return {
    name: config.name,
    description: config.description,
    parameters: config.parameters,
    execute: wrapExecute(config),
    _permissions: config.permissions || [],
    _formatter: config.formatter || 'text',
    _internalParams: config._internalParams || [],
    requiresConfirmation: config.requiresConfirmation || false,
    ...(config.directReturn !== undefined ? { directReturn: config.directReturn } : {}),
    ...(config.requiresPermission !== undefined ? { requiresPermission: config.requiresPermission } : {}),
    ...(config.domain !== undefined ? { _domain: config.domain } : {}),
  };
}

function wrapExecute(config) {
  return async (input, signal, context) => {
    if (config.validate) {
      const result = await config.validate(input);
      const [ok, err] = Array.isArray(result) ? result : [result, ''];
      if (!ok) {
        // Validation rejections are user-input errors, not faults — log at debug
        // so a tool returning VALIDATION is traceable under DEBUG_AGENT without
        // flooding gateway.log on every malformed call.
        log.debug('tool', `${config.name} validation rejected:`, err || 'Invalid input');
        return toolError(config.name, 'VALIDATION', err || 'Invalid input');
      }
    }
    try {
      const result = await config.execute(input, signal, context);
      logToolUse(config.name, input, result);
      return result;
    } catch (err) {
      // Single choke point for ALL tool execution — every custom + core tool is
      // wrapped here, so this is the one place that turns a thrown tool fault into
      // a diagnostic log. Without it, failures surfaced only as the client-facing
      // toolError() string and were invisible in gateway.log / the error buffer.
      const error = err instanceof Error ? err : null;
      log.error('tool', `${config.name} execution failed:`, error || String(err), { category: 'TOOL', tool: config.name });
      return toolError(config.name, 'EXECUTION', err?.message || String(err));
    }
  };
}

/**
 * Escape a user-supplied value for safe interpolation inside an AppleScript
 * double-quoted string literal. Order matters: backslash first, then quote, so
 * an escaped quote's leading backslash isn't itself re-escaped. This is the
 * single audited home for the chain that was hand-copied across ~20 tool sites
 * (a single divergent copy is an AppleScript-injection hole).
 *
 * @param {string} s - Untrusted value
 * @returns {string}
 */
export function escapeAppleScript(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/**
 * Run an AppleScript via `osascript -e`, returning trimmed stdout. Wraps the
 * script in a single-quoted shell arg using the classic `'\''` escape idiom
 * (written `'"'"'` here) so a `'` inside the script can't break out of the shell
 * quoting. This is the single home for the wrap copy-pasted across ~25 sites.
 * NOTE: only escapes the SHELL layer — interpolate user values into the script
 * with escapeAppleScript() first.
 *
 * @param {string} script - AppleScript source
 * @returns {Promise<string>} Trimmed stdout
 */
export async function runAppleScript(script) {
  return runCommand(`osascript -e '${String(script).replace(/'/g, "'\"'\"'")}'`);
}

/**
 * Run an AppleScript via `osascript` (execFile, no shell) and hand its trimmed
 * stdout to `parseFn` to produce the tool's result. This is the single home for
 * the run-osascript-then-shape-the-output pattern repeated across the
 * Contacts / Notes / Mail tools, each of which runs a script that emits
 * delimiter-joined records and then maps the raw text to a final string.
 *
 * Execution uses runCommandSafe (execFile, no shell interpolation), so user
 * values must already be escaped into the script with escapeAppleScript().
 *
 * @param {string} script - AppleScript source
 * @param {(raw: string) => string} parseFn - Maps trimmed stdout to the result
 * @returns {Promise<string>} The value returned by parseFn
 */
export async function listAppleScriptRecords(script, parseFn) {
  const raw = await runCommandSafe('osascript', ['-e', script]);
  return parseFn(raw);
}

/**
 * Build a confirmation_dialog `_ui` envelope for a destructive/sensitive tool.
 *
 * This is the ONLY correct way to gate a tool behind user confirmation. The
 * older "return a plain string and tell the LLM to call again with
 * confirmed:true" pattern is broken two ways: if `confirmed` is NOT stripped
 * via `_internalParams` the LLM can self-confirm and bypass the user entirely
 * (a security hole); if it IS stripped the LLM can never re-supply it, so the
 * action can never run. Returning this envelope instead makes the gateway
 * (agent_loop.js) render a dialog, register the `actions`, and — when the user
 * taps Confirm — re-execute the tool against `allToolsRaw` (unwrapped) with
 * `confirmed:true`, so the user, not the model, holds the gate.
 *
 * The tool MUST declare `_internalParams: ['confirmed']` so the LLM-visible
 * input is stripped, and should declare `requiresConfirmation: true` so the
 * startup validator (tool_config.js) enforces the pairing.
 *
 * @param {object}  opts
 * @param {string}  opts.toolName     - Tool to re-call on confirm (this tool)
 * @param {object}  [opts.input]      - Original tool input; re-supplied verbatim
 *                                       on confirm with `confirmed:true` added
 * @param {string}  opts.title        - Dialog title
 * @param {string}  [opts.message]    - Dialog body
 * @param {string}  [opts.confirmLabel='Confirm'] - Confirm button label
 * @param {boolean} [opts.destructive=false]       - Red/destructive styling
 * @returns {string} JSON `_ui` envelope (via toolOk)
 */
export function confirmTool({ toolName, input = {}, title, message = '', confirmLabel = 'Confirm', destructive = false }) {
  const fallback = `⚠️ ${title}${message ? `\n\n${message}` : ''}\n\nConfirm to proceed.`;
  return toolOk(fallback, {
    component: 'confirmation_dialog',
    version: 1,
    id: `${toolName}_${Date.now()}`,
    data: { title, message, destructive },
    actions: [
      { id: 'confirm', label: confirmLabel, style: destructive ? 'destructive' : 'default', tool: toolName, input: { ...input, confirmed: true } },
      { id: 'cancel', label: 'Cancel' },
    ],
    fallback,
  });
}

/**
 * Fold a 12-hour clock hour to 24-hour given a meridiem.
 *
 * Uses `hour !== 12` (not `< 12`) for the pm branch: callers that pre-validate
 * hour to 1-12 get identical results, while callers that don't keep their
 * existing unguarded behavior for hour > 12.
 *
 * @param {number} hour - Hour (1-12 with meridiem, or 0-23 when meridiem is undefined)
 * @param {string|undefined} meridiem - "am" or "pm" (lowercased), or undefined for 24h
 * @returns {number} The 24-hour hour
 */
export function to24Hour(hour, meridiem) {
  if (meridiem === 'pm' && hour !== 12) return hour + 12;
  if (meridiem === 'am' && hour === 12) return 0;
  return hour;
}

/**
 * Parse a clock time ("7am", "3:30pm", "15:00") into the next future Date that
 * matches it — today if still ahead, otherwise tomorrow. Returns null on an
 * unparseable or out-of-range value rather than letting setHours roll over.
 * Shared by reminders (parseDateTime) and the alarm tool (mac_alarm_set).
 * @param {string} timeStr
 * @returns {Date|null}
 */
export function parseTime(timeStr) {
  const now = new Date();
  const str = timeStr.toLowerCase().trim();

  // Try parsing "7am", "3pm", "7:30am", "3:30pm"
  const match = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (match) {
    let hours = parseInt(match[1], 10);
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    const period = match[3]?.toLowerCase();

    // Reject out-of-range values instead of letting setHours roll them over.
    // With a period the hour must be 1-12; without one (e.g. "15") allow 0-23.
    if (minutes > 59) return null;
    if (period) {
      if (hours < 1 || hours > 12) return null;
    } else if (hours > 23) {
      return null;
    }

    hours = to24Hour(hours, period);

    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);

    // If the time has already passed today, set it for tomorrow
    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    return target;
  }

  // Try parsing 24-hour format "15:00"
  const match24 = str.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const hours = parseInt(match24[1], 10);
    const minutes = parseInt(match24[2], 10);

    // Reject out-of-range 24h values (e.g. "25:00", "7:99") instead of rolling over.
    if (hours > 23 || minutes > 59) return null;

    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);

    if (target <= now) {
      target.setDate(target.getDate() + 1);
    }

    return target;
  }

  return null;
}
