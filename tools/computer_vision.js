/**
 * Computer-vision tooling — the shared "see the screen, click the thing"
 * pipeline used by the screen_click tool.
 *
 * Flow: resolve a target app's window bounds (in GLOBAL POINTS) via the
 * in-process AX service (:1319) → region-capture exactly that window to a PNG →
 * ask the calling chat agent (Grok/Pro) to locate the target → convert the
 * model's box_2d (normalized 0-1000) into global screen points → post a
 * synthetic click back through the AX service.
 *
 * Coordinate math: /ax/window_info returns bounds in POINTS and the vision
 * model returns box_2d normalized to 0-1000, so the click point is simply:
 *   globalX = winX + (nx/1000) * winW ;  globalY = winY + (ny/1000) * winH
 * No screenshot pixel dimensions are involved in the math — a capture is taken
 * only to feed the model.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { runCommand, axFetch } from './shared.js';
import { analyzeWithAgentVision } from '../vision_client.js';

/**
 * POST JSON to the in-process AX service (:1319), bearer-authed.
 * @param {string} routePath - e.g. '/ax/click_at'
 * @param {object} body - JSON-serializable request body
 * @returns {Promise<string>} Response body text
 */
export async function axPost(routePath, body) {
  return axFetch(routePath, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * GET from the in-process AX service (:1319), bearer-authed.
 * @param {string} routePath - e.g. '/ax/can_capture'
 * @returns {Promise<string>} Response body text
 */
export async function axGet(routePath) {
  return axFetch(routePath, { method: 'GET' });
}

/**
 * Resolve the largest layer-0 window of a target app, in GLOBAL POINTS.
 * Prefer bundleId; fall back to appName (owner-name match); pass neither to
 * use the frontmost app.
 *
 * @param {{bundleId?: string, appName?: string}} sel
 * @returns {Promise<{id:number,x:number,y:number,w:number,h:number}>}
 */
export async function getWindowBounds({ bundleId, appName } = {}) {
  const body = {};
  if (bundleId) body.bundleId = bundleId;
  else if (appName) body.appName = appName;
  const text = await axPost('/ax/window_info', body);
  const win = JSON.parse(text);
  if (win.error) throw new Error(win.error);
  return win;
}

/**
 * Whether macOS Screen Recording is granted (CGPreflightScreenCaptureAccess).
 * FAIL-OPEN: returns true if the endpoint errors, so a transient AX glitch
 * doesn't block an otherwise-permitted capture.
 *
 * @returns {Promise<boolean>}
 */
export async function canScreenCapture() {
  try {
    const data = JSON.parse(await axGet('/ax/can_capture'));
    return !!data.granted;
  } catch {
    return true;
  }
}

/**
 * Parse a vision model's response into a normalized 0-1000 center point.
 *
 * Accepts the native Gemma box_2d format `[ymin, xmin, ymax, xmax]` (integers,
 * floats, and negatives) found anywhere in the text. The model is prompted to
 * respond ONLY with its target's box, so the PRIMARY target is the FIRST valid
 * box — we return it rather than the largest-area one. Picking max-area was a
 * bug: a stray all-round-integer full-frame list in the model's prose
 * (e.g. "[0,0,200,200]") is in-range, non-degenerate, and dwarfs the tiny real
 * target box, so it wrongly won and locateAndClick clicked the wrong spot.
 *
 * To stay robust against such noise, we also SKIP a "looks-like-a-frame" box:
 * an origin-anchored ([0,0,...]) all-round-multiple-of-100 box (e.g.
 * [0,0,200,200], [0,0,1000,1000]) is a synthetic full-frame/reference example
 * from the model's prose, not a real grounded target. The skip is deliberately
 * narrow — anchoring at the origin is the tell. A plausible round target that
 * is NOT origin-anchored (e.g. [100,200,300,400]) is kept, since round coords
 * alone are not bogus. If only frame-looking boxes exist we still fall back to
 * the first one so we never regress to null when that's all the model emitted.
 *
 * A box is treated as normalized 0-1 (and scaled to 0-1000) ONLY when it
 * carries a fractional value AND every coord is <= 1 — integer-valued boxes
 * like [3,0,18,12] or [0,0,1,1] are genuine 0-1000 pixels and left untouched.
 * Falls back to a {"x":..,"y":..} JSON point (same rule).
 *
 * @param {string} text - Raw model output
 * @returns {{nx:number, ny:number}|null} Center point 0-1000, or null.
 */
export function parseBox2d(text) {
  if (typeof text !== 'string') return null;

  const re = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/g;
  // The model is prompted to emit ONLY the target's box, so the PRIMARY target
  // is the FIRST valid box — return it (matching the JSDoc). Returning max-area
  // was a bug: a stray full-frame list in prose (e.g. "[0,0,200,200]") is
  // in-range and non-degenerate but dwarfs the tiny real target box, so it won.
  let firstValid = null;
  for (const m of text.matchAll(re)) {
    let ymin = +m[1], xmin = +m[2], ymax = +m[3], xmax = +m[4];
    // Normalized 0-1 → scale to 0-1000, but ONLY when a coord is fractional.
    // Gemma emits box_2d on a 0-1000 integer scale, so a small all-integer box
    // like [3,0,18,12] (icon at the window origin) or [0,0,1,1] is genuine
    // pixels, not 0-1 — rescaling it would send the click far off target. A
    // true 0-1 box always carries a fraction (e.g. 0.03), so require one.
    const coords = [ymin, xmin, ymax, xmax];
    const hasFraction = coords.some((v) => !Number.isInteger(v));
    if (hasFraction && coords.every((v) => v <= 1)) {
      ymin *= 1000; xmin *= 1000; ymax *= 1000; xmax *= 1000;
    }
    const inRange = [ymin, xmin, ymax, xmax].every((v) => v >= 0 && v <= 1000);
    if (inRange && xmax > xmin && ymax > ymin) {
      const center = { nx: (xmin + xmax) / 2, ny: (ymin + ymax) / 2 };
      // Remember the first valid box as a last-resort fallback.
      if (!firstValid) firstValid = center;
      // Skip a "looks-like-a-frame" box: an origin-anchored ([0,0,...]),
      // all-round-multiple-of-100 box is a synthetic full-frame/reference
      // example from the model's prose, not a real grounded target. Keep the
      // skip narrow — origin anchoring is the tell, so a plausible round target
      // that is NOT anchored at [0,0] (e.g. [100,200,300,400]) is NOT skipped.
      const looksLikeFrame =
        !hasFraction && ymin === 0 && xmin === 0 && coords.every((v) => v % 100 === 0);
      if (looksLikeFrame) continue;
      // First real (non-frame) box wins.
      return center;
    }
  }
  // Only frame-looking boxes were emitted — fall back to the first rather than
  // regressing to null.
  if (firstValid) return firstValid;

  // Fallback: a {"x":..,"y":..} JSON point.
  const pt = text.match(/\{[^}]*"x"[^}]*\}/);
  if (pt) {
    try {
      const c = JSON.parse(pt[0]);
      let x = c.x, y = c.y;
      if (typeof x === 'number' && typeof y === 'number') {
        // Same rule as box_2d: only 0-1 normalize when a coord is fractional,
        // so an integer point like {"x":1,"y":1} stays in 0-1000 pixel space.
        if ((!Number.isInteger(x) || !Number.isInteger(y)) && x <= 1 && y <= 1) {
          x *= 1000; y *= 1000;
        }
        if (x >= 0 && x <= 1000 && y >= 0 && y <= 1000) return { nx: x, ny: y };
      }
    } catch {
      // fall through to null
    }
  }

  return null;
}

/**
 * The full vision-grounded click pipeline. Locates `targetPrompt` inside the
 * given app's window via the calling agent's vision and clicks it. Returns a
 * success string or throws a clear Error.
 *
 * Enforces BOTH the 'accessibility.execute' and 'screenshot' scopes (screen
 * capture + synthetic HID click span both) before doing anything.
 *
 * @param {{bundleId?:string, appName?:string, targetPrompt:string, clickCount?:number}} args
 * @returns {Promise<string>}
 */
export async function locateAndClick({ bundleId, appName, targetPrompt, clickCount } = {}) {
  // 1. Enforce scopes. Lazy-import tool_config to avoid a circular import at
  //    module-eval time (tool_config imports the tool arrays which import this).
  const { isScopeGranted } = await import('../permissions.js');
  if (!isScopeGranted('accessibility.execute') || !isScopeGranted('screenshot')) {
    throw new Error(
      'auto-play needs the Screen Recording + accessibility permissions — enable the ' +
      '"click, type, and control other apps" (accessibility.execute) and "capture and ' +
      'analyze your screen" (screenshot) scopes in Settings → Permissions.'
    );
  }

  // 2. Screen Recording permission (separate from the agent-layer scope).
  if (!(await canScreenCapture())) {
    throw new Error(
      'Screen Recording permission required — grant it in System Settings › Privacy & Security › Screen Recording'
    );
  }

  // 3. Resolve the target window's bounds in global points.
  const win = await getWindowBounds({ bundleId, appName });

  // 4. Region-capture exactly the window bounds to a temp PNG.
  const shot = path.join(os.tmpdir(), `dottie-cv-${Date.now()}.png`);
  try {
    const rx = Math.round(win.x), ry = Math.round(win.y);
    const rw = Math.round(win.w), rh = Math.round(win.h);
    await runCommand(`screencapture -x -R${rx},${ry},${rw},${rh} "${shot}"`);
    if (!fs.existsSync(shot) || fs.statSync(shot).size <= 1024) {
      throw new Error('blank/empty capture');
    }
    const base64 = fs.readFileSync(shot).toString('base64');

    // 5. Ask the calling agent (Grok/Pro) to locate the target — not local llama.
    const prompt =
      `Locate ${targetPrompt} in this screenshot. Respond ONLY with its bounding box ` +
      `as box_2d [ymin, xmin, ymax, xmax].`;
    const text = await analyzeWithAgentVision({
      base64Image: base64,
      question: prompt,
      maxTokens: 96,
      temperature: 0,
    });

    // 6. Parse the model's box into a normalized 0-1000 center point.
    const c = parseBox2d(text);
    if (!c) throw new Error(`vision returned no usable coords: ${text.slice(0, 120)}`);

    // 7. Normalized 0-1000 → global screen points.
    const gx = win.x + (c.nx / 1000) * win.w;
    const gy = win.y + (c.ny / 1000) * win.h;
    if (!Number.isFinite(gx) || !Number.isFinite(gy)) {
      throw new Error('non-finite click coordinate');
    }

    // 8. Post the synthetic click (imageWidth 0 => x,y are global points, no scaling).
    await axPost('/ax/click_at', {
      x: gx,
      y: gy,
      imageWidth: 0,
      imageHeight: 0,
      bundleId: bundleId || '',
      clickCount: clickCount || 1,
    });

    return `Clicked ${targetPrompt}.`;
  } finally {
    try { if (fs.existsSync(shot)) fs.unlinkSync(shot); } catch { /* best-effort cleanup */ }
  }
}
