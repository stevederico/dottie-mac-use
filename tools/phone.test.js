import { describe, it, expect } from 'vitest';
import { escapeAS, buildFaceTimeScript } from './phone.js';

describe('phone.js AppleScript injection hardening', () => {
  describe('escapeAS', () => {
    it('escapes double quotes', () => {
      expect(escapeAS('a"b')).toBe('a\\"b');
    });

    it('escapes backslashes before quotes (order matters)', () => {
      // A literal backslash must become \\, and a quote \" — a naive
      // quote-then-backslash order would double-escape the inserted backslash.
      expect(escapeAS('a\\"b')).toBe('a\\\\\\"b');
    });

    it('leaves plain values untouched', () => {
      expect(escapeAS('+15551234567')).toBe('+15551234567');
    });
  });

  describe('buildFaceTimeScript', () => {
    // The Contacts value cleaning (.replace(/[\s\-\(\)]/g,'')) does NOT strip
    // double quotes, so a crafted contact value reaches the AppleScript literal.
    // This is the exact injection payload the review reproduced.
    const payload = 'x" & (do shell script "touch /tmp/pwned") & "';

    it('escapes a quote-injection payload in the facetime-audio literal', () => {
      const script = buildFaceTimeScript('facetime-audio', payload);
      // The dangerous `" & (...) & "` must be neutralized: every interpolated
      // quote is backslash-escaped, so no bare quote can close the literal.
      expect(script).toContain('\\"');
      // Strip every escaped quote (\"). What remains must NOT contain a bare
      // quote that introduces the injected `& (do shell script` operator — that
      // would mean the literal was broken out of and arbitrary AS would run.
      const noEscaped = script.replace(/\\"/g, '');
      expect(noEscaped).not.toContain('" & (do shell script');
    });

    it('escapes a quote-injection payload in the facetime literal', () => {
      const script = buildFaceTimeScript('facetime', payload);
      const noEscaped = script.replace(/\\"/g, '');
      expect(noEscaped).not.toContain('" & (do shell script');
    });

    it('produces exactly one closing literal quote — no breakout', () => {
      const script = buildFaceTimeScript('facetime-audio', payload);
      // Count unescaped double quotes: the opening and the single trailing
      // closing quote of the literal. With the payload escaped, removing all
      // escaped quotes (\") should leave exactly two structural quotes.
      const structuralQuotes = script.replace(/\\"/g, '').match(/"/g) || [];
      expect(structuralQuotes.length).toBe(2);
    });

    it('builds a clean script for a normal number', () => {
      expect(buildFaceTimeScript('facetime-audio', '+15551234567'))
        .toBe('open location "facetime-audio://+15551234567"');
    });
  });
});
