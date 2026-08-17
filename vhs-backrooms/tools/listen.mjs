#!/usr/bin/env node
/* ============================================================================
   Audio inspection harness.

   Nobody in this loop has ears, so the sound has to be made visible. This
   renders the audio module's graph through an OfflineAudioContext, writes a
   real .wav you can keep, and prints/plots what the signal actually is:
   spectrum, band energies, and a spectrogram PNG.

     node tools/listen.mjs --sec 12 --out shots/audio
     node tools/listen.mjs --sec 12 --state dread=0.9,wear=0.8,prox=0.7

   Requires the audio module to expose:
     VB.audio.renderOffline(seconds, stateOverrides) -> Promise<Float32Array>
   rendering the full room-tone graph mono at 44100.
   ========================================================================== */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const SEC = +arg('sec', 10);
const OUT = arg('out', 'shots/audio');
const STATE = (arg('state', '') || '').split(',').filter(Boolean)
  .reduce((o, kv) => { const [k, v] = kv.split('='); o[k] = +v; return o; }, {});

fs.mkdirSync(path.join(ROOT, path.dirname(OUT)), { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.route('**/three.module.js', r =>
  r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'vendor/three.module.js'), 'utf8') }));
await page.goto('file://' + path.join(ROOT, 'index.html'), { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__VB && window.__VB.ready', null, { timeout: 90000 });

const has = await page.evaluate(() => !!(window.VB.audio && window.VB.audio.renderOffline));
if (!has) {
  console.error('audio module does not expose renderOffline(seconds, stateOverrides) — cannot inspect.');
  await browser.close();
  process.exit(3);
}

const result = await page.evaluate(async (o) => {
  const buf = await window.VB.audio.renderOffline(o.sec, o.state);
  const pcm = Array.from(buf);

  /* ---- analysis, in-page so we can draw with canvas ---- */
  const SR = 44100, N = 2048, HOP = 1024;
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]];[im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < len / 2; k++) {
          const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
          const ur = re[i + k], ui = im[i + k];
          const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
          const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        }
      }
    }
  }
  const frames = [];
  const avg = new Float64Array(N / 2);
  for (let p = 0; p + N < pcm.length; p += HOP) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = pcm[p + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    fft(re, im);
    const mag = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) { mag[i] = Math.hypot(re[i], im[i]) / N; avg[i] += mag[i]; }
    frames.push(mag);
  }
  for (let i = 0; i < N / 2; i++) avg[i] /= frames.length;

  const binHz = SR / N;
  const band = (lo, hi) => { let s = 0; for (let i = Math.floor(lo / binHz); i < Math.min(N / 2, hi / binHz); i++) s += avg[i] * avg[i]; return s; };
  const total = band(0, SR / 2) || 1e-12;
  const db = v => (10 * Math.log10(v / total)).toFixed(1);

  let peak = 0, sum = 0, dc = 0;
  for (let i = 0; i < pcm.length; i++) { peak = Math.max(peak, Math.abs(pcm[i])); sum += pcm[i] * pcm[i]; dc += pcm[i]; }
  const rms = Math.sqrt(sum / pcm.length);

  /* strongest narrow peaks — should land on mains hum and its harmonics */
  const peaks = [];
  for (let i = 2; i < N / 2 - 2; i++) {
    if (avg[i] > avg[i - 1] && avg[i] > avg[i + 1] && avg[i] > avg[i - 2] && avg[i] > avg[i + 2]) {
      peaks.push({ hz: +(i * binHz).toFixed(1), mag: avg[i] });
    }
  }
  peaks.sort((a, b) => b.mag - a.mag);

  /* ---- spectrogram PNG: log-frequency, time across ---- */
  const W = Math.min(1000, frames.length), H = 360;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const img = g.createImageData(W, H);
  const fMin = 20, fMax = 16000;
  for (let x = 0; x < W; x++) {
    const fr = frames[Math.floor(x / W * frames.length)];
    for (let y = 0; y < H; y++) {
      const f = fMin * Math.pow(fMax / fMin, 1 - y / H);
      const bin = Math.min(N / 2 - 1, Math.max(0, Math.round(f / binHz)));
      const v = 20 * Math.log10(fr[bin] + 1e-9);
      const n = Math.max(0, Math.min(1, (v + 100) / 78));
      const i4 = (y * W + x) * 4;
      /* magma-ish: dark -> purple -> orange -> white */
      img.data[i4] = Math.min(255, n * 380);
      img.data[i4 + 1] = Math.min(255, Math.max(0, (n - 0.35) * 400));
      img.data[i4 + 2] = Math.min(255, Math.max(0, n * 190 + (n - 0.75) * 700));
      img.data[i4 + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = '#0f0'; g.font = '11px monospace';
  for (const f of [50, 120, 240, 1000, 4000, 8000, 12000]) {
    const y = H * (1 - Math.log(f / fMin) / Math.log(fMax / fMin));
    g.fillRect(0, y, 12, 1); g.fillText(f + 'Hz', 14, y + 4);
  }

  return {
    png: cv.toDataURL('image/png').slice(22),
    pcm,
    stats: {
      seconds: +(pcm.length / SR).toFixed(2),
      rms: +rms.toFixed(4), peak: +peak.toFixed(4),
      crestDb: +(20 * Math.log10(peak / (rms || 1e-9))).toFixed(1),
      dcOffset: +(dc / pcm.length).toFixed(5),
      bandsDbRelTotal: {
        'sub 0-40': db(band(0, 40)), 'hum 40-160': db(band(40, 160)),
        'low 160-500': db(band(160, 500)), 'mid 500-2k': db(band(500, 2000)),
        'pres 2k-5k': db(band(2000, 5000)), 'hiss 5k-8k': db(band(5000, 8000)),
        'ABOVE 8k (should be tiny)': db(band(8000, 22050)),
      },
      topPeaksHz: peaks.slice(0, 8).map(p => p.hz),
    },
  };
}, { sec: SEC, state: STATE });

fs.writeFileSync(path.join(ROOT, OUT + '_spectrogram.png'), Buffer.from(result.png, 'base64'));

/* ---- WAV (16-bit mono 44100) ---- */
const pcm = result.pcm;
const wav = Buffer.alloc(44 + pcm.length * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + pcm.length * 2, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(44100, 24); wav.writeUInt32LE(88200, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(pcm.length * 2, 40);
for (let i = 0; i < pcm.length; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm[i] * 32767))), 44 + i * 2);
fs.writeFileSync(path.join(ROOT, OUT + '.wav'), wav);

console.log('wrote', OUT + '.wav', 'and', OUT + '_spectrogram.png');
console.log('state overrides:', JSON.stringify(STATE));
console.log(JSON.stringify(result.stats, null, 2));
if (errors.length) { console.log('\n--- ERRORS ---\n' + errors.slice(0, 15).join('\n')); }
await browser.close();
process.exit(errors.length ? 1 : 0);
