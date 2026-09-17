/**
 * Task tool overrides (no dottie-memory import — uses context.taskStore only):
 * - `mac_task_create` talks to taskStore directly with a sharper description.
 */

import { tagDomain } from './shared.js';

export const tasksTools = tagDomain([
  {
    name: 'mac_task_create',
    description:
      'Create a task / todo / thing-to-do for the user. ' +
      'Use this for ANY "create a task", "add a todo", "remind me to do X", "I need to X" request. ' +
      'NEVER save tasks as files via mac_workspace_write — tasks belong here. ' +
      'Supports optional steps, priority, deadline, and category.',
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'What the user wants to achieve',
        },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of step descriptions to break the task into subtasks',
        },
        category: {
          type: 'string',
          description: 'Category: fitness, learning, productivity, creative, health, financial, personal, work, other. Default: general',
        },
        priority: {
          type: 'string',
          description: 'Priority level: low, medium, high, critical. Default: medium',
        },
        deadline: {
          type: 'string',
          description: "Optional deadline as ISO date string, e.g. '2026-03-01'",
        },
        mode: {
          type: 'string',
          enum: ['manual', 'auto'],
          description: "Execution mode: 'manual' (user-driven) or 'auto' (autonomous). Default: auto",
        },
      },
      required: ['description'],
    },
    execute: async (input, signal, context) => {
      if (!context?.taskStore) return 'Error: taskStore not available';
      try {
        const task = await context.taskStore.createTask({
          userId: context.userID,
          description: input.description,
          steps: input.steps || [],
          category: input.category || 'general',
          priority: input.priority || 'medium',
          deadline: input.deadline || null,
          mode: input.mode || 'auto',
        });

        const taskId = task.id || task._id?.toString();

        return `Task created: "${input.description}" (ID: ${taskId})\n` +
          `Mode: ${task.mode}, Priority: ${task.priority}, Steps: ${task.steps.length}`;
      } catch (err) {
        return `Error creating task: ${err.message}`;
      }
    },
  },

  {
    name: 'mac_task_list',
    description:
      'List the user\'s tasks / todos. Use this for "list my tasks", "what are my todos", "show my tasks", ' +
      '"what do I need to do". Optionally filter by status or category. ' +
      'NEVER read tasks from files via mac_workspace_read — tasks live here.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Filter by status (optional)',
        },
        category: {
          type: 'string',
          description: 'Filter by category (optional)',
        },
      },
    },
    execute: async (input, signal, context) => {
      if (!context?.taskStore) return 'Error: taskStore not available';

      const filters = {};
      if (input.status) filters.status = input.status;
      if (input.category) filters.category = input.category;

      const tasks = await context.taskStore.getTasks(context.userID, filters);

      if (tasks.length === 0) {
        return input.status || input.category
          ? 'No tasks found matching filters.'
          : 'No tasks yet. Create one with mac_task_create.';
      }

      const text = tasks.map((g) => {
        const taskId = g.id || g._id?.toString();
        const doneCount = g.steps?.filter((s) => s.done).length || 0;
        const totalSteps = g.steps?.length || 0;
        const progress = totalSteps > 0 ? `${doneCount}/${totalSteps} steps` : 'No steps';
        const status = g.status === 'completed' ? '✓' : g.status === 'in_progress' ? '▶' : '○';
        return `${status} [${taskId}] ${g.description} [${g.priority}] - ${progress} (${g.progress}%)`;
      }).join('\n');

      return text;
    },
  },
], 'schedule');
