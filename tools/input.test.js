// Shape tests for the raw input primitives. Execution posts real HID events via
// :1319, so only definitions are asserted here — never fire live events in tests.

import { describe, it, expect } from 'vitest';
import { inputTools } from './input.js';

const byName = (name) => inputTools.find((t) => t.name === name);

describe('input primitive tool shapes', () => {
  it('exposes exactly the five primitives', () => {
    expect(inputTools.map((t) => t.name).sort()).toEqual(
      ['key_event', 'keyboard_type', 'mouse_click', 'mouse_drag', 'mouse_move']
    );
  });

  it('all are scope-gated under accessibility.execute and tagged computer_use', () => {
    for (const t of inputTools) {
      expect(t.requiresPermission).toBe('accessibility.execute');
      expect(t._domain).toBe('computer_use');
    }
  });

  it('mouse_move takes absolute x/y or relative dx/dy, neither pair required', () => {
    // `required` is deliberately absent: the two pairs are either/or, which
    // JSON Schema can only say with oneOf, and Gemma follows the description
    // far more reliably than a combinator. Relative motion is the one voice
    // needs — "move left a bit" can't be expressed in absolute coordinates
    // because nothing tells the model where the cursor is. The Swift side
    // (moveTarget) rejects a call supplying neither pair.
    const t = byName('mouse_move');
    expect(t.parameters.required).toBeUndefined();
    expect(Object.keys(t.parameters.properties).sort()).toEqual(['dx', 'dy', 'x', 'y']);
    expect(t.description).toMatch(/negative dx is left/);
  });

  it('mouse_click has optional coords and a button enum', () => {
    const t = byName('mouse_click');
    expect(t.parameters.required).toEqual([]);
    expect(t.parameters.properties.button.enum).toEqual(['left', 'right', 'middle']);
  });

  it('mouse_drag requires all four coordinates', () => {
    expect(byName('mouse_drag').parameters.required).toEqual(['fromX', 'fromY', 'toX', 'toY']);
  });

  it('keyboard_type requires text and says focused app', () => {
    const t = byName('keyboard_type');
    expect(t.parameters.required).toEqual(['text']);
    expect(t.description.toLowerCase()).toContain('focus');
  });

  it('key_event gates destructive chords via internal confirmed param', () => {
    const t = byName('key_event');
    expect(t.parameters.required).toEqual(['key']);
    expect(t._internalParams).toContain('confirmed');
    expect(t.parameters.properties.direction.enum).toEqual(['press', 'down', 'up']);
  });
});
