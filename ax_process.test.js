/**
 * ax_process — resolve binary + health probe (no live spawn in CI).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { resolveAxBinary, axBaseUrl } from './ax_process.js';
import { PORTS } from './ports.js';

describe('ax_process', () => {
  it('axBaseUrl uses AX port', () => {
    expect(axBaseUrl()).toContain(String(PORTS.AX_PORT));
  });

  it('resolveAxBinary points at package bin when built', () => {
    const bin = resolveAxBinary();
    expect(bin).toMatch(/dottie-mac-use-ax$/);
    // Build artifact should exist after native/build.sh (committed or local).
    expect(fs.existsSync(bin)).toBe(true);
  });
});
