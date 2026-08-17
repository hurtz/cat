#!/usr/bin/env node
/* ============================================================================
   Screenshot / inspection harness.

   Loads the *real shipped* index.html in headless Chromium (the Three.js CDN
   request is intercepted and served from vendor/ so this works offline), drives
   the game deterministically through __VB.step(), and writes PNGs.

     node tools/shoot.mjs --out shots/look --at 120,900,3600
     node tools/shoot.mjs --out shots/motion --at 600 --sheet 3x3 --every 2
     node tools/shoot.mjs --perf

   --at      comma list of field counts at which to capture (1 field = 1/59.94s)
   --sheet   CxR contact sheet of consecutive presented frames from that point
   --every   fields between contact-sheet cells (default 2 = one presented frame)
   --seed    world seed (default 1337, fixed for reproducibility)
   --walk    "x,z,yaw" teleport before stepping
   --warp    advance the game clock by N seconds with no rendering, so tape
             wear / dread at minute 20 can be inspected in one second
   --size    output pixel size, default 1024x768
   --perf    measure real-time frame pacing instead of stepping
   --html    file to load (default index.html)
   ========================================================================== */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const flag = k => argv.includes('--' + k);

const OUT = arg('out', 'shots/frame');
const AT = arg('at', '120').split(',').map(Number);
const SHEET = arg('sheet', null);
const EVERY = +arg('every', 2);
const SEED = +arg('seed', 1337);
const SIZE = arg('size', '1024x768').split('x').map(Number);
const WALK = arg('walk', null);
const HTML = arg('html', 'index.html');

fs.mkdirSync(path.join(ROOT, path.dirname(OUT)), { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--disable-gpu-sandbox', '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: SIZE[0], height: SIZE[1] }, deviceScaleFactor: 1 });

const logs = [], errors = [];
page.on('console', m => { const t = m.text(); logs.push(m.type() + ': ' + t); if (m.type() === 'error') errors.push(t); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.stack || e.message)));

await page.route('**/three.module.js', r =>
  r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'vendor/three.module.js'), 'utf8') }));

await page.goto('file://' + path.join(ROOT, HTML), { waitUntil: 'domcontentloaded' });

try {
  await page.waitForFunction('window.__VB && window.__VB.ready', null, { timeout: 90000 });
} catch (e) {
  console.error('BOOT FAILED — page never reached __VB.ready.');
  console.error(errors.length ? errors.join('\n') : logs.slice(-40).join('\n'));
  await page.screenshot({ path: path.join(ROOT, OUT + '_bootfail.png') });
  await browser.close();
  process.exit(2);
}

console.log('modules:', await page.evaluate(() => window.__VB.modules().join(', ')));

await page.evaluate(s => window.__VB.seed(s), SEED);
const WARP = +arg('warp', 0);
if (WARP) { await page.evaluate(s => window.__VB.warp(s), WARP); console.log('warped clock +' + WARP + 's'); }
if (WALK) {
  const [x, z, y] = WALK.split(',').map(Number);
  await page.evaluate(a => window.__VB.teleport(a[0], a[1], a[2]), [x, z, y || 0]);
}

/* ------------------------------------------------------------------- perf */
if (flag('perf')) {
  const r = await page.evaluate(async () => {
    window.__VB.VB.deterministic = false;
    if (!window.__VB.VB.running) window.__VB.VB.start();
    const t = [];
    let last = performance.now();
    await new Promise(res => {
      let n = 0;
      const tick = () => {
        const now = performance.now(); t.push(now - last); last = now;
        if (++n < 200) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
    const s = t.slice(40).sort((a, b) => a - b);
    const info = window.__VB.VB.renderer.info;
    return {
      medianMs: +s[s.length >> 1].toFixed(2),
      p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(2),
      calls: info.render.calls, tris: info.render.triangles,
      geometries: info.memory.geometries, textures: info.memory.textures,
      programs: info.programs ? info.programs.length : -1,
    };
  });
  console.log('PERF(software-rasterised, treat as relative):', JSON.stringify(r, null, 2));
}

/* ---------------------------------------------------------------- capture
   Stepping and grabbing happen inside ONE page.evaluate so the WebGL drawing
   buffer is still intact when toDataURL runs (no preserveDrawingBuffer cost on
   the shipped renderer), and Playwright never waits for the canvas to "settle". */
function write(file, b64) {
  fs.writeFileSync(path.join(ROOT, file), Buffer.from(b64, 'base64'));
  console.log('wrote', file);
}

let prev = 0;
for (const at of AT) {
  const delta = at - prev; prev = at;
  if (delta > 2) {
    /* chunked so a hung frame is visible rather than a silent timeout */
    for (let done = 0; done < delta - 2;) {
      const n = Math.min(120, delta - 2 - done);
      await page.evaluate(k => window.__VB.step(k), n);
      done += n;
    }
  }
  if (SHEET) {
    const [cols, rows] = SHEET.split('x').map(Number);
    const buf = await page.evaluate(async (o) => {
      const cv = document.getElementById('screen');
      const W = cv.width, H = cv.height;
      const sheet = document.createElement('canvas');
      sheet.width = W * o.cols; sheet.height = H * o.rows;
      const g = sheet.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, sheet.width, sheet.height);
      for (let i = 0; i < o.cols * o.rows; i++) {
        window.__VB.step(i === 0 ? 2 : o.every);
        g.drawImage(cv, (i % o.cols) * W, Math.floor(i / o.cols) * H, W, H);
        g.fillStyle = '#0f0'; g.font = '14px monospace';
        g.fillText('f' + i, (i % o.cols) * W + 6, Math.floor(i / o.cols) * H + 18);
      }
      return sheet.toDataURL('image/png').slice(22);
    }, { cols, rows, every: EVERY });
    write(`${OUT}_${at}_sheet.png`, buf);
  } else {
    const buf = await page.evaluate(() => {
      /* two fields guarantees exactly one present() lands on the canvas
         regardless of field parity — capturing after a non-presenting field
         returns whatever the compositor last cleared. */
      window.__VB.step(2);
      return document.getElementById('screen').toDataURL('image/png').slice(22);
    });
    write(`${OUT}_${at}.png`, buf);
  }
}

const state = await page.evaluate(() => {
  const S = window.__VB.S;
  return { t: +S.t.toFixed(2), dread: +S.dread.toFixed(3), wear: +S.wear.toFixed(3), prox: +S.prox.toFixed(3), pos: S.pos ? [+S.pos.x.toFixed(2), +S.pos.z.toFixed(2)] : null };
});
console.log('state:', JSON.stringify(state));

if (errors.length) { console.log('\n--- CONSOLE ERRORS (' + errors.length + ') ---'); console.log(errors.slice(0, 25).join('\n')); }
await browser.close();
process.exit(errors.length ? 1 : 0);
