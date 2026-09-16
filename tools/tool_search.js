/**
 * Tool router — lazy-loads domain tools so the LLM only sees ~15 always-on
 * core tools each turn instead of all 168 (~14.7K → ~1.5K tokens).
 *
 * The LLM calls `tool_search({domain})` when its current tool list is
 * insufficient. agent_bridge.js wires up the actual execute closure with
 * access to the live tools array (which dotbot's agentLoop re-reads on each
 * iteration — see lib/agent-lib/core/agent.js). Pushing
 * onto that array makes the new tools visible to the *next* LLM turn within
 * the same chat() invocation. Loaded names also persist across turns of the
 * same conversationId via the session cache in agent_bridge.js.
 *
 * Definition lives here (no execute) so it can be exported as static metadata.
 * Execute is wired up at chat() time in agent_bridge.js to avoid the circular
 * import (tool_search → tool_config → tools — tool_config wouldn't be loadable).
 */

import { TOOL_SEARCH_DOMAINS } from '../domains.js';

/**
 * Tools that only work when the model can actually see an image. On a text-only
 * local model (no mmproj) these send image content the engine can't decode, so
 * they're skipped entirely — the model never learns the capability exists,
 * instead of offering it and failing. Cloud vision providers keep them.
 */
export const VISION_TOOL_NAMES = new Set(['screenshot_and_analyze']);

/**
 * Static definition (LLM-visible schema). Execute is added by agent_bridge.js
 * at chat() time as a closure over the live tools array + session cache.
 */
export const toolSearchDefinition = {
  name: 'tool_search',
  description:
    'Router for all tools. This is the ONLY tool you have until you call it — every action ' +
    '(send a message, read clipboard, take a screenshot, list tasks, set the volume, etc.) ' +
    'requires loading the right domain first. ALWAYS call this on the first turn whenever the ' +
    'user asks you to do anything; never reply "I don\'t have a tool for that" without searching first. ' +
    'Domains and example user phrases: ' +
    'comms (text someone, imessage, sms, email, mail, contacts, phone), ' +
    'schedule (calendar, event, meeting, what\'s on my calendar, reminder, todo, timer, alarm), ' +
    'media (music, spotify, play song, pause, photo, camera, screenshot, take a picture), ' +
    'info (open a website/URL/link, open stripe/github/docs in the browser, open Grok Hub / hub.grok.me / Grok Theft Auto / hub apps via hub_open not the browser, note, file, folder, safari tabs, chrome, what url is open, current page, map, location, weather, web search, google), ' +
    'system (dark mode, light mode, toggle theme, volume, brightness, wifi, bluetooth, sleep, lock screen, hide windows, show desktop, open an app, frontmost app, what app, switch app), ' +
    'computer_use (click button, type into other app, keystroke, automate, move mouse, scroll, fill form), ' +
    'dev (code, file edit, repo, git, terminal, shell command), ' +
    'automation (scheduled job, cron, task, trigger, and anything recurring — "every day", "every morning", ' +
    '"repeat weekly" — as opposed to a one-off calendar event or reminder, which is schedule). ' +
    'After calling, the loaded tools are callable on your next turn — call the most relevant one immediately.',
  parameters: {
    type: 'object',
    properties: {
      domain: {
        type: 'string',
        enum: TOOL_SEARCH_DOMAINS,
        description: 'Which domain to load tools from.',
      },
      query: {
        type: 'string',
        description: 'Optional keyword to filter within the domain (matches tool name and description).',
      },
    },
    required: ['domain'],
  },
};

/**
 * Build the tool_search instance for a given chat() invocation.
 * The execute closure mutates the live `liveTools` array so the next dotbot
 * agentLoop iteration includes the loaded tools in its toolDefs build (see
 * dotbot/core/agent.js:71). Loaded tool names are also added to
 * `sessionLoadedSet` so the next user message in the same conversation
 * pre-loads them without a second tool_search hop.
 *
 * Permission model: ungranted tools are simply SKIPPED (never loaded). No
 * stubs, no side-channel callbacks, no canned messages. If the user hasn't
 * pre-granted the scope in Settings, the LLM sees fewer tools and tells the
 * user it can't help with that — they grant in Settings and ask again.
 * Keeps the tool schema stable within a conversation, so the KV cache
 * doesn't thrash on retries.
 *
 * @param {Object} deps
 * @param {Function} deps.getDomainTools - (domain, query) => Tool[]
 * @param {Function} deps.scopeForTool - (toolName) => permissionScope|null
 * @param {Object} deps.permissions - granted permission map { 'calendar.read': true, ... }
 * @param {Array} deps.liveTools - the array passed to dotbot.chatRaw, mutated in place
 * @param {Set<string>} deps.sessionLoadedSet - per-conversation cache of loaded tool names
 * @param {Function} [deps.onLoaded] - optional callback fired with ({domain, query, loadedNames, skippedScopes}) for telemetry/dev overlay
 */
export function buildToolSearch({
  getDomainTools,
  scopeForTool,
  permissions,
  liveTools,
  sessionLoadedSet,
  onLoaded,
  visionAvailable = true,
}) {
  return {
    ...toolSearchDefinition,
    _domain: 'core',
    _permissions: [],
    _formatter: 'text',
    _internalParams: [],
    requiresConfirmation: false,
    execute: async (input) => {
      const domain = input?.domain;
      const query = input?.query?.toLowerCase() || '';

      if (!TOOL_SEARCH_DOMAINS.includes(domain)) {
        return JSON.stringify({
          error: `Unknown domain '${domain}'. Available: ${TOOL_SEARCH_DOMAINS.join(', ')}`,
        });
      }

      const candidates = getDomainTools(domain, query);
      const newlyLoaded = [];
      const alreadyAvailable = [];
      const skippedScopes = new Set();

      for (const tool of candidates) {
        // Hide vision-only tools when the model can't see — never surface a
        // capability that would fail on use.
        if (!visionAvailable && VISION_TOOL_NAMES.has(tool.name)) continue;
        if (liveTools.find(t => t.name === tool.name)) {
          alreadyAvailable.push(tool);
          continue;
        }
        const scope = scopeForTool ? scopeForTool(tool.name) : null;
        const isGranted = !scope || permissions?.[scope] === true;

        if (!isGranted) {
          if (scope) skippedScopes.add(scope);
          continue;
        }

        liveTools.push(tool);
        sessionLoadedSet.add(tool.name);
        newlyLoaded.push(tool);
      }

      const callable = [...newlyLoaded, ...alreadyAvailable];

      if (onLoaded) {
        onLoaded({
          domain,
          query,
          loadedNames: newlyLoaded.map(t => t.name),
          alreadyAvailableNames: alreadyAvailable.map(t => t.name),
          skippedScopes: [...skippedScopes],
        });
      }

      return JSON.stringify({
        domain,
        loaded_count: callable.length,
        loaded: callable.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        message:
          callable.length === 0
            ? `No '${domain}' tools available. Tell the user you can't help with that.`
            : `${callable.length} tool(s) available from '${domain}'. Call the appropriate one immediately to answer the user's question.`,
      });
    },
  };
}
