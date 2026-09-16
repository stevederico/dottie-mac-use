// Shape tests for the Safari page-interaction tools (safari_click / safari_fill)
// and the ref-or-name upgrade to ax_fill. Execution paths hit :1319 + osascript,
// so only definitions are asserted here (same posture as computer_vision.test.js).

import { describe, it, expect } from 'vitest';
import { safariTools } from './safari.js';
import { axTools } from './ax.js';

const byName = (tools, name) => tools.find((t) => t.name === name);

describe('safari tool shapes', () => {
  it('safari_click targets by ref or name, scope accessibility.execute, confirm param internal', () => {
    const t = byName(safariTools, 'safari_click');
    expect(t).toBeDefined();
    expect(t.requiresPermission).toBe('accessibility.execute');
    expect(t._internalParams).toContain('confirmed');
    expect(Object.keys(t.parameters.properties)).toEqual(
      expect.arrayContaining(['ref', 'name', 'role', 'snapshotId'])
    );
    // No bundleId param — it is hardcoded to com.apple.Safari inside execute.
    expect(t.parameters.properties.bundleId).toBeUndefined();
  });

  it('safari_fill requires only value, scope accessibility.execute', () => {
    const t = byName(safariTools, 'safari_fill');
    expect(t).toBeDefined();
    expect(t.requiresPermission).toBe('accessibility.execute');
    expect(t.parameters.required).toEqual(['value']);
    expect(Object.keys(t.parameters.properties)).toEqual(
      expect.arrayContaining(['ref', 'name', 'role', 'value', 'snapshotId'])
    );
  });

  it('safari_open_url steers to the page-interaction tools', () => {
    const t = byName(safariTools, 'safari_open_url');
    expect(t.description).toContain('safari_click');
    expect(t.description).toContain('safari_fill');
  });
});

describe('ax_fill ref-or-name upgrade', () => {
  it('no longer requires ref and exposes name/role/snapshotId', () => {
    const t = byName(axTools, 'ax_fill');
    expect(t.parameters.required).toEqual(['bundleId', 'value']);
    expect(Object.keys(t.parameters.properties)).toEqual(
      expect.arrayContaining(['ref', 'name', 'role', 'snapshotId'])
    );
  });
});
