#!/usr/bin/env node
/* ============================================================================
   VHS SIGNAL FORENSICS

   "It looks authentic" is an opinion. Real VHS captures have measurable
   properties, and a fake-VHS shader fails them in characteristic ways. This
   measures the shipped game's actual output frames against those properties
   and prints a pass/fail scorecard.

   Every threshold below is derived from what the medium physically does, and
   the reasoning is stated inline so a critic can argue with it rather than
   trust it.

     node tools/forensics.mjs
     node tools/forensics.mjs --at 600 --warp 600     # measure a worn tape
   ========================================================================== */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const AT = +arg('at', 400);
const WARP = +arg('warp', 0);
const SEED = +arg('seed', 1337);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
await page.route('**/three.module.js', r =>
  r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'vendor/three.module.js'), 'utf8') }));
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__VB && window.__VB.ready', null, { timeout: 90000 });
await page.evaluate(s => window.__VB.seed(s), SEED);
if (WARP) await page.evaluate(s => window.__VB.warp(s), WARP);

const report = await page.evaluate(async (o) => {
  const VB = window.VB, S = window.__VB.S;

  /* Advance to the measurement point. */
  for (let done = 0; done < o.at; done += 60) window.__VB.step(Math.min(60, o.at - done));

  const cv = document.getElementById('screen');
  const W = cv.width, H = cv.height;
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
  const g = tmp.getContext('2d', { willReadFrequently: true });

  function grab() {
    window.__VB.step(2);                       // exactly one presented frame
    g.drawImage(cv, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    const Y = new Float32Array(W * H), I = new Float32Array(W * H), Q = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const r = d[i * 4] / 255, gg = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255;
      Y[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
      I[i] = 0.596 * r - 0.274 * gg - 0.322 * b;
      Q[i] = 0.211 * r - 0.523 * gg + 0.312 * b;
    }
    return { Y, I, Q };
  }

  /* Two frames a few fields apart, and a frame captured mid-pan.
     Combing only exists if the two woven fields were sampled at DIFFERENT
     camera angles, so the yaw has to move BETWEEN the two fields of a single
     presented frame — stepping 2 fields after one yaw change renders both
     fields at the same angle and measures nothing. */
  const A = grab();
  window.__VB.step(2);
  const B = grab();

  const yaw0 = S.yaw;
  const PAN = (() => {
    for (let i = 0; i < 8; i++) { S.yaw += 0.035; window.__VB.step(1); }
    S.yaw += 0.035; window.__VB.step(1);        // field 0 of the frame we keep
    S.yaw += 0.035; window.__VB.step(1);        // field 1 -> present()
    g.drawImage(cv, 0, 0);
    const d = g.getImageData(0, 0, W, H).data;
    const Y = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) Y[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
    return { Y };
  })();
  S.yaw = yaw0;

  const out = {}, notes = [];
  const px = (a, x, y) => a[y * W + x];

  /* ---------------------------------------------------------------------
     1. BLACK FLOOR.  VHS carries a pedestal and the tape adds its own noise
     floor; a real capture essentially never contains true 0,0,0. A render
     that clips to black is the most common giveaway of "game with a filter".
     Expect the 0.5th percentile of luma to sit around 0.03-0.14.
     ------------------------------------------------------------------- */
  {
    const s = Array.from(A.Y).sort((a, b) => a - b);
    out.blackFloor = +s[Math.floor(s.length * 0.005)].toFixed(4);
    out.whiteCeil = +s[Math.floor(s.length * 0.995)].toFixed(4);
    out.pctTrueBlack = +(100 * s.filter(v => v < 0.004).length / s.length).toFixed(2);
  }

  /* ---------------------------------------------------------------------
     2. NOISE ANISOTROPY.  Tape luma noise is correlated ALONG the scanline
     and independent BETWEEN lines. High-pass the image, then compare the
     lag-1 autocorrelation horizontally vs vertically. Per-pixel white noise
     (the lazy shader default) scores ~1.0. Real VHS scores clearly above 1.
     ------------------------------------------------------------------- */
  {
    const hp = new Float32Array(W * H);
    for (let y = 2; y < H - 2; y++)
      for (let x = 2; x < W - 2; x++)
        hp[y * W + x] = px(A.Y, x, y) - 0.25 * (px(A.Y, x - 2, y) + px(A.Y, x + 2, y) + px(A.Y, x, y - 2) + px(A.Y, x, y + 2));
    let hh = 0, vv = 0, e = 0, n = 0;
    for (let y = 3; y < H - 3; y++)
      for (let x = 3; x < W - 3; x++) {
        const v = hp[y * W + x];
        hh += v * hp[y * W + x + 1];
        vv += v * hp[(y + 1) * W + x];
        e += v * v; n++;
      }
    out.noiseCorrH = +(hh / e).toFixed(3);
    out.noiseCorrV = +(vv / e).toFixed(3);
    out.noiseAnisotropy = +((hh / e) / (Math.abs(vv / e) + 1e-6)).toFixed(2);
    out.noiseEnergy = +Math.sqrt(e / n).toFixed(4);
  }

  /* ---------------------------------------------------------------------
     3. CHROMA vs LUMA HORIZONTAL BANDWIDTH.  This is the defining property
     of the format: VHS luma is ~3MHz, chroma ~0.4MHz, so chroma carries
     roughly 1/8 the horizontal detail. Measure mean |d/dx| of luma vs chroma,
     normalised by their own contrast. A shader that just tints the image
     scores ~1.0 here; the format demands chroma be far smoother.
     ------------------------------------------------------------------- */
  {
    const grad = (a) => {
      let s = 0, m = 0, n = 0, mean = 0;
      for (let i = 0; i < a.length; i++) mean += a[i];
      mean /= a.length;
      for (let y = 4; y < H - 4; y++)
        for (let x = 4; x < W - 5; x++) {
          s += Math.abs(px(a, x + 1, y) - px(a, x, y));
          m += Math.abs(px(a, x, y) - mean);
          n++;
        }
      return { g: s / n, c: m / n };
    };
    const gy = grad(A.Y), gi = grad(A.I), gq = grad(A.Q);
    /* roughness normalised by contrast — how much detail per unit of signal */
    const ry = gy.g / (gy.c + 1e-6);
    const rc = (gi.g + gq.g) / (gi.c + gq.c + 1e-6);
    out.lumaRoughness = +ry.toFixed(4);
    out.chromaRoughness = +rc.toFixed(4);
    out.chromaBandwidthRatio = +(rc / (ry + 1e-9)).toFixed(3);
  }

  /* ---------------------------------------------------------------------
     4. CHROMA LAG.  Chroma is not merely blurred, it is DELAYED — colour
     arrives to the right of the luma edge it belongs to. Cross-correlate the
     luma edge signal against the chroma edge signal at a range of shifts and
     report the offset with the best match. Real VHS is positive (rightward),
     typically a few pixels at this resolution.
     ------------------------------------------------------------------- */
  {
    const dY = new Float32Array(W * H), dC = new Float32Array(W * H);
    for (let y = 4; y < H - 4; y++)
      for (let x = 4; x < W - 5; x++) {
        dY[y * W + x] = Math.abs(px(A.Y, x + 1, y) - px(A.Y, x, y));
        dC[y * W + x] = Math.abs(px(A.I, x + 1, y) - px(A.I, x, y)) + Math.abs(px(A.Q, x + 1, y) - px(A.Q, x, y));
      }
    let best = 0, bestScore = -1e9;
    const scores = {};
    for (let shift = -10; shift <= 10; shift++) {
      let s = 0, n = 0;
      for (let y = 6; y < H - 6; y += 2)
        for (let x = 14; x < W - 15; x++) {
          s += dY[y * W + x] * dC[y * W + x + shift]; n++;
        }
      s /= n; scores[shift] = s;
      if (s > bestScore) { bestScore = s; best = shift; }
    }
    out.chromaLagPx = best;
  }

  /* ---------------------------------------------------------------------
     5. SCANLINE STRUCTURE.  Alternating-line modulation should be present:
     compare mean |row(y) - row(y+1)| against |row(y) - row(y+2)|. A frame
     with scanlines and interlace has significantly more line-to-line
     difference than two-line difference.
     ------------------------------------------------------------------- */
  {
    let d1 = 0, d2 = 0, n = 0;
    for (let y = 4; y < H - 6; y++)
      for (let x = 8; x < W - 8; x += 3) {
        d1 += Math.abs(px(A.Y, x, y) - px(A.Y, x, y + 1));
        d2 += Math.abs(px(A.Y, x, y) - px(A.Y, x, y + 2));
        n++;
      }
    out.lineToLineDiff = +(d1 / n).toFixed(4);
    out.twoLineDiff = +(d2 / n).toFixed(4);
    out.scanlineRatio = +((d1 / n) / (d2 / n + 1e-9)).toFixed(3);
  }

  /* ---------------------------------------------------------------------
     6. HEAD SWITCHING NOISE.  The bottom few percent of every VHS frame is
     torn and noisy where the video head leaves the tape. Compare per-row
     horizontal roughness in the bottom band against the frame body. Almost no
     fake VHS filter has this, so it is a strong discriminator.
     ------------------------------------------------------------------- */
  {
    const rowRough = y => {
      let s = 0;
      for (let x = 6; x < W - 7; x++) s += Math.abs(px(A.Y, x + 1, y) - px(A.Y, x, y));
      return s / (W - 13);
    };
    let bot = 0, bn = 0, body = 0, yn = 0;
    for (let y = H - 12; y < H - 1; y++) { bot += rowRough(y); bn++; }
    for (let y = Math.floor(H * 0.25); y < Math.floor(H * 0.75); y++) { body += rowRough(y); yn++; }
    out.headSwitchRoughness = +(bot / bn).toFixed(4);
    out.bodyRoughness = +(body / yn).toFixed(4);
    out.headSwitchRatio = +((bot / bn) / (body / yn + 1e-9)).toFixed(2);
  }

  /* ---------------------------------------------------------------------
     7. EDGE OVERSHOOT (RINGING).  The VCR's detail circuit overshoots after a
     dark->light transition, producing a bright halo to the RIGHT of the edge.
     Find strong rising luma steps, average the profile after them, and report
     how far above the post-edge plateau the peak sits. A pure blur scores ~0.
     ------------------------------------------------------------------- */
  {
    const prof = new Float64Array(10); let count = 0;
    for (let y = 8; y < H - 8; y += 2)
      for (let x = 12; x < W - 20; x++) {
        const a = px(A.Y, x, y), b = px(A.Y, x + 1, y);
        if (b - a > 0.06) {
          const plateau = (px(A.Y, x + 7, y) + px(A.Y, x + 8, y) + px(A.Y, x + 9, y)) / 3;
          if (plateau <= a + 0.02) continue;
          for (let k = 0; k < 10; k++) prof[k] += (px(A.Y, x + 1 + k, y) - a) / (plateau - a);
          count++;
          x += 12;
        }
      }
    if (count > 20) {
      for (let k = 0; k < 10; k++) prof[k] /= count;
      out.edgeProfile = Array.from(prof).map(v => +v.toFixed(3));
      out.overshoot = +(Math.max(...prof) - 1).toFixed(3);
      out.edgeSamples = count;
    } else { out.overshoot = null; out.edgeSamples = count; notes.push('too few strong edges to measure ringing'); }
  }

  /* ---------------------------------------------------------------------
     8. INTERLACE COMBING UNDER MOTION.  Naive line-to-line difference does
     NOT measure this: the display pass modulates every other line, and that
     constant scanline pattern swamps the combing signal entirely.

     So separate the two parities into their own half-height images, normalise
     each to zero mean and unit variance (which removes exactly the per-parity
     brightness offset that scanlines impose, and nothing else), and compare
     what is left. On a static frame the two fields show the same world and
     agree; during a pan they were sampled 1/59.94s apart and disagree.
     ------------------------------------------------------------------- */
  {
    const parityMismatch = (F) => {
      const h2 = (H >> 1) - 2;
      const E = new Float64Array(W * h2), O = new Float64Array(W * h2);
      for (let r = 0; r < h2; r++)
        for (let x = 0; x < W; x++) {
          E[r * W + x] = px(F.Y, x, r * 2);
          O[r * W + x] = px(F.Y, x, r * 2 + 1);
        }
      const norm = (a) => {
        let m = 0; for (let i = 0; i < a.length; i++) m += a[i]; m /= a.length;
        let v = 0; for (let i = 0; i < a.length; i++) v += (a[i] - m) * (a[i] - m);
        v = Math.sqrt(v / a.length) || 1e-6;
        for (let i = 0; i < a.length; i++) a[i] = (a[i] - m) / v;
      };
      norm(E); norm(O);
      let d = 0, n = 0;
      /* skip the head-switch band, which is torn on every frame regardless */
      for (let r = 2; r < h2 - 8; r++)
        for (let x = 8; x < W - 8; x++) { d += Math.abs(E[r * W + x] - O[r * W + x]); n++; }
      return d / n;
    };
    const stat = parityMismatch(A), pan = parityMismatch(PAN);
    out.staticParityMismatch = +stat.toFixed(4);
    out.panningParityMismatch = +pan.toFixed(4);
    out.combingGain = +(pan / (stat + 1e-9)).toFixed(3);
  }

  /* ---------------------------------------------------------------------
     9. TEMPORAL INSTABILITY.  Two consecutive presented frames of a static
     scene must NOT be identical — tape noise, time-base error and flicker
     guarantee change. A frozen image is an instant tell.
     ------------------------------------------------------------------- */
  {
    let d = 0;
    for (let i = 0; i < A.Y.length; i++) d += Math.abs(A.Y[i] - B.Y[i]);
    out.frameToFrameDelta = +(d / A.Y.length).toFixed(5);
  }

  /* ------------------------------------------------------------ verdicts */
  const checks = [
    ['black floor lifted (no crushed blacks)', out.blackFloor > 0.02 && out.blackFloor < 0.20,
      `0.5th pct luma = ${out.blackFloor} (want 0.02-0.20)`],
    ['almost no true black pixels', out.pctTrueBlack < 1.0, `${out.pctTrueBlack}% below 0.004 (want <1%)`],
    ['noise correlated along scanlines', out.noiseAnisotropy > 1.25,
      `H/V autocorr ratio = ${out.noiseAnisotropy} (want >1.25; white noise = 1.0)`],
    ['noise actually present', out.noiseEnergy > 0.004, `hp energy = ${out.noiseEnergy}`],
    ['chroma bandwidth far below luma', out.chromaBandwidthRatio < 0.55,
      `chroma/luma roughness = ${out.chromaBandwidthRatio} (want <0.55; a tint = ~1.0)`],
    ['chroma lags to the right of luma', out.chromaLagPx > 0,
      `best chroma offset = ${out.chromaLagPx}px (want positive)`],
    ['scanline / interlace structure present', out.scanlineRatio > 1.05,
      `line-to-line vs two-line = ${out.scanlineRatio} (want >1.05)`],
    ['head-switching tear at frame bottom', out.headSwitchRatio > 1.6,
      `bottom vs body roughness = ${out.headSwitchRatio}x (want >1.6)`],
    ['edge overshoot / ringing present', out.overshoot != null && out.overshoot > 0.03,
      `post-edge overshoot = ${out.overshoot} (want >0.03; pure blur = ~0)`],
    ['combing increases under motion', out.combingGain > 1.15,
      `parity mismatch panning/static = ${out.combingGain}x (want >1.15)`],
    ['image is never frozen', out.frameToFrameDelta > 0.0015,
      `mean |frame delta| = ${out.frameToFrameDelta}`],
    /* A lit office has to actually reach near-white somewhere. If the 99.5th
       percentile never gets bright, the render is underexposed and no amount of
       tape artefacting will make it read as a fluorescent-lit room. */
    ['image reaches proper highlights', out.whiteCeil > 0.72,
      `99.5th pct luma = ${out.whiteCeil} (want >0.72)`],
    ['usable dynamic range', (out.whiteCeil - out.blackFloor) > 0.5,
      `range = ${(out.whiteCeil - out.blackFloor).toFixed(3)} (want >0.5)`],
  ];
  return { out, checks, notes, W, H, t: +S.t.toFixed(1), wear: +S.wear.toFixed(3) };
}, { at: AT });

console.log(`\nVHS SIGNAL FORENSICS  —  ${report.W}x${report.H}  t=${report.t}s  wear=${report.wear}\n`);
let pass = 0;
for (const [name, ok, detail] of report.checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n          ${detail}`);
  if (ok) pass++;
}
console.log(`\n  ${pass}/${report.checks.length} checks passed\n`);
console.log('raw measurements:', JSON.stringify(report.out, null, 2));
if (report.notes.length) console.log('notes:', report.notes.join('; '));
if (errors.length) console.log('\nCONSOLE ERRORS:\n' + errors.slice(0, 10).join('\n'));
await browser.close();
process.exit(pass === report.checks.length ? 0 : 1);
