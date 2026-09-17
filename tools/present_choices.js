/**
 * mac_present_choices — render a row of tappable action buttons (DUIActionButtonsCard).
 *
 * This is the ONLY producer of the `action_buttons` _ui component. Use it when
 * the natural next step is for the USER to pick between a few concrete options
 * and each pick maps to a tool call (e.g. "Open in Safari" vs "Copy link").
 *
 * Each choice becomes a UIAction the frontend registers; tapping it re-executes
 * `tool` with `input` against the unwrapped tool registry — the same tap path
 * the working confirmation_dialog uses. A choice with no `tool` is a passive
 * pick (selection recorded client-side, nothing re-executed), mirroring the
 * confirmation dialog's Cancel button.
 */

import { toolOk, toolError, tagDomain } from './shared.js';

export const presentChoicesTools = tagDomain([
  {
    name: 'mac_present_choices',
    description:
      'Show the user a row of tappable buttons to pick between 2–5 concrete options. ' +
      'Use when you would otherwise ask "do you want A or B?" and each option maps to an action. ' +
      'Each choice can carry a `tool` + `input` that runs when the user taps it.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Optional prompt shown above the buttons (e.g. "How should I open this?")',
        },
        choices: {
          type: 'array',
          description: '2–5 options to present as buttons.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Button text the user sees' },
              tool: { type: 'string', description: 'Tool to run when tapped (optional)' },
              input: { type: 'object', description: 'Input passed to that tool (optional)' },
              style: {
                type: 'string',
                enum: ['default', 'destructive'],
                description: 'Button styling (optional)',
              },
            },
            required: ['label'],
          },
        },
      },
      required: ['choices'],
    },
    execute: async (input) => {
      const choices = Array.isArray(input?.choices) ? input.choices : [];
      if (choices.length < 2) {
        return toolError('mac_present_choices', 'VALIDATION', 'Provide at least 2 choices.');
      }

      const actions = choices.map((c, i) => ({
        id: `choice_${i}`,
        label: String(c?.label ?? `Option ${i + 1}`),
        ...(c?.style ? { style: c.style } : {}),
        ...(c?.tool ? { tool: String(c.tool) } : {}),
        ...(c?.input && typeof c.input === 'object' ? { input: c.input } : {}),
      }));

      const title = typeof input?.title === 'string' ? input.title : undefined;
      const fallback = `${title ? `${title}\n` : ''}${actions.map((a) => `• ${a.label}`).join('\n')}`;

      return toolOk(fallback, {
        component: 'action_buttons',
        version: 1,
        id: `present_choices_${Date.now()}`,
        data: { title },
        actions,
        fallback,
      });
    },
  },
], 'core');
