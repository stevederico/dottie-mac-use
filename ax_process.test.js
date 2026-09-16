/**
 * ax_process — resolve binary + health probe (no live spawn in CI).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveAxBinary, axBaseUrl } from './ax_process.js';
import { PORTS } from './ports.js';

describe('ax_process', () => {
  it('axBaseUrl uses AX port', () => {
    expect(axBaseUrl()).toContain(String(PORTS.AX_PORT));
  });

  it('resolveAxBinary prefers DOTTIE_MAC_USE_AX or native/.build', () => {
    const bin = resolveAxBinary();
    expect(bin).toMatch(/dottie-mac-use-ax$/);
    if (process.env.DOTTIE_MAC_USE_AX) {
      expect(bin).toBe(process.env.DOTTIE_MAC_USE_AX);
    } else {
      expect(bin).toContain(`${path.sep}native${path.sep}.build${path.sep}`);
    }
  });
});
