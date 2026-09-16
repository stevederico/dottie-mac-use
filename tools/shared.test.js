import { describe, it, expect } from 'vitest';
import { escapeAppleScript, runAppleScript, createTool } from './shared.js';
import { getRecentErrors } from '../logger.js';

/**
 * Guards the single audited AppleScript-escape helper that ~20 tool sites now
 * share. The escape order (backslash BEFORE quote) is injection-critical: if a
 * quote were escaped first, its inserted backslash would be re-escaped and the
 * closing `\"` would collapse back into an unescaped `"`, letting a crafted
 * value break out of the AppleScript string literal.
 */
describe('escapeAppleScript', () => {
  it('escapes backslash before quote (order matters)', () => {
    // input:  \"   →  backslash doubled first, then the quote escaped
    expect(escapeAppleScript('\\"')).toBe('\\\\\\"');
  });

  it('escapes a plain double quote', () => {
    expect(escapeAppleScript('a"b')).toBe('a\\"b');
  });

  it('escapes a lone backslash', () => {
    expect(escapeAppleScript('a\\b')).toBe('a\\\\b');
  });

  it('leaves injection attempts inert (no unescaped quote survives)', () => {
    const out = escapeAppleScript('"; do shell script "rm -rf ~"; "');
    // every double-quote in the output is preceded by a backslash
    expect(/(^|[^\\])"/.test(out)).toBe(false);
  });

  it('coerces non-strings without throwing', () => {
    expect(escapeAppleScript(42)).toBe('42');
    expect(escapeAppleScript(null)).toBe('null');
  });

  it('runAppleScript is callable', () => {
    expect(typeof runAppleScript).toBe('function');
  });
});

/**
 * Guards the single tool-execution choke point in wrapExecute(). EVERY custom +
 * core tool is wrapped here, so a thrown tool fault must leave a diagnostic trail
 * in the structured error buffer (category TOOL) — without it, failures surfaced
 * only as the client-facing toolError() string and were invisible in gateway.log
 * and /system/errors. Tool names are made unique per test so assertions don't
 * race the shared 200-entry circular buffer (there is no public clear()).
 */
describe('createTool error logging', () => {
  it('records a TOOL-category error when a tool throws', async () => {
    const name = 'unit_throwing_tool_a';
    const tool = createTool({
      name,
      execute: async () => { throw new Error('boom from tool'); },
    });

    const result = await tool.execute({});

    // Caller still gets the standard EXECUTION error string (behavior unchanged)...
    expect(result).toBe(`[${name}] EXECUTION: boom from tool`);
    // ...AND the failure is now traceable in the structured buffer.
    const entry = getRecentErrors().find(e => e.context?.tool === name);
    expect(entry).toBeTruthy();
    expect(entry.category).toBe('TOOL');
    expect(entry.message).toContain('boom from tool');
    expect(entry.stack).toBeTruthy(); // real Error → stack captured
  });

  it('does NOT record an error when a tool succeeds', async () => {
    const name = 'unit_ok_tool_b';
    const tool = createTool({
      name,
      execute: async () => 'fine',
    });

    const result = await tool.execute({});

    expect(result).toBe('fine');
    expect(getRecentErrors().find(e => e.context?.tool === name)).toBeUndefined();
  });

  it('coerces a non-Error throw into a logged TOOL error', async () => {
    const name = 'unit_throwing_tool_c';
    const tool = createTool({
      name,
      execute: async () => { throw 'plain string failure'; }, // eslint-disable-line no-throw-literal
    });

    const result = await tool.execute({});

    expect(result).toBe(`[${name}] EXECUTION: plain string failure`);
    const entry = getRecentErrors().find(e => e.context?.tool === name);
    expect(entry).toBeTruthy();
    expect(entry.category).toBe('TOOL');
  });

  it('a validation rejection does NOT hit the error buffer', async () => {
    const name = 'unit_validating_tool_d';
    const tool = createTool({
      name,
      validate: () => [false, 'bad input'],
      execute: async () => 'never runs',
    });

    const result = await tool.execute({});

    // Validation failures are user-input errors, logged only at debug — not faults.
    expect(result).toBe(`[${name}] VALIDATION: bad input`);
    expect(getRecentErrors().find(e => e.context?.tool === name)).toBeUndefined();
  });
});
