import { describe, it, expect } from 'vitest';
import { parseBox2d } from './computer_vision.js';

/**
 * parseBox2d: turns a vision model's response into a normalized 0-1000 center
 * point. The model is prompted to emit ONLY the target's box, so the FIRST
 * valid box is the primary target — NOT the largest-area one.
 */
describe('parseBox2d', () => {
  it('returns the center of a single box_2d', () => {
    // box_2d is [ymin, xmin, ymax, xmax]; center = (xmin+xmax)/2, (ymin+ymax)/2.
    expect(parseBox2d('[100, 200, 300, 400]')).toEqual({ nx: 300, ny: 200 });
  });

  it('picks the tiny real target over a large bogus full-frame box in prose', () => {
    // Gemma returns the small target box first; a stray all-round-integer
    // full-frame list appears later in the prose. Area-max wrongly selected the
    // bogus [0,0,200,200] (area 40000) over the real target (area 100); the fix
    // returns the FIRST real box and rejects the grid-looking one.
    const text =
      'The play button is at box_2d [480, 490, 500, 510]. ' +
      'Note: the screenshot grid is roughly [0,0,200,200] in size.';
    expect(parseBox2d(text)).toEqual({ nx: 500, ny: 490 });
  });

  it('skips a leading grid-looking box and returns the next real target', () => {
    // A synthetic-looking full-frame example precedes the genuine grounded box.
    const text = 'frame [0, 0, 1000, 1000] target [612, 333, 648, 401]';
    expect(parseBox2d(text)).toEqual({ nx: 367, ny: 630 });
  });

  it('falls back to the first box when only grid-looking boxes exist', () => {
    // Never regress to null when that's all the model emitted.
    expect(parseBox2d('[0, 0, 200, 200]')).toEqual({ nx: 100, ny: 100 });
  });

  it('keeps a round, non-origin-anchored target over a later non-grid box', () => {
    // [100,200,300,400] is all multiples of 100 but is NOT origin-anchored, so
    // it is a plausible real target — the over-broad grid skip wrongly discarded
    // it and returned the tiny [3,0,18,12] box instead. The frame skip only
    // rejects origin-anchored ([0,0,...]) reference boxes, so the round target wins.
    expect(parseBox2d('target [100,200,300,400] then [3,0,18,12]'))
      .toEqual({ nx: 300, ny: 200 });
  });

  it('scales a fractional 0-1 box to 0-1000', () => {
    expect(parseBox2d('[0.1, 0.2, 0.3, 0.4]')).toEqual({ nx: 300, ny: 200 });
  });

  it('leaves a small all-integer box in 0-1000 pixel space (no rescale)', () => {
    // [3,0,18,12] is genuine pixels, not 0-1 — center stays small.
    expect(parseBox2d('[3, 0, 18, 12]')).toEqual({ nx: 6, ny: 10.5 });
  });

  it('falls back to a {"x":..,"y":..} JSON point', () => {
    expect(parseBox2d('{"x": 250, "y": 750}')).toEqual({ nx: 250, ny: 750 });
  });

  it('returns null on non-string and on no usable coords', () => {
    expect(parseBox2d(null)).toBeNull();
    expect(parseBox2d('no coordinates here')).toBeNull();
  });
});
