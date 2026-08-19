#!/usr/bin/env node
/* Emulated-phone smoke test: does the thing actually work with two thumbs?
   Uses real PointerEvents so the same code path a device takes is exercised. */
import { chromium, devices } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HTML = process.argv.includes('--play') ? 'play.html' : 'index.html';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--mute-audio','--autoplay-policy=no-user-gesture-required'] });
const ctx = await b.newContext({ ...devices['iPhone 13'], hasTouch:true, isMobile:true });
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.route('**/three.module.js', r=>r.fulfill({status:200,contentType:'text/javascript',body:fs.readFileSync(path.join(ROOT,'vendor/three.module.js'),'utf8')}));
await p.goto('file://'+path.join(ROOT,HTML));
await p.waitForFunction('window.__VB && window.__VB.ready', null, {timeout:120000});

const vp = p.viewportSize();
console.log('viewport', vp, 'file', HTML);
console.log('controls line:', await p.evaluate(()=>document.getElementById('ctl')?.textContent.trim()));

const r = await p.evaluate(async (vp) => {
  const S = window.__VB.S, VB = window.VB;
  const hit = document.getElementById('hit');
  const pe = (t, id, x, y) => hit.dispatchEvent(new PointerEvent(t, {
    pointerId:id, pointerType:'touch', clientX:x, clientY:y, bubbles:true, cancelable:true }));
  const wpe = (t, id, x, y) => window.dispatchEvent(new PointerEvent(t, {
    pointerId:id, pointerType:'touch', clientX:x, clientY:y, bubbles:true, cancelable:true }));

  pe('pointerdown', 1, vp.width*0.18, vp.height*0.75);   // left thumb: stick
  pe('pointerdown', 2, vp.width*0.75, vp.height*0.5);    // right thumb: look
  const started = VB.running;
  const p0 = { x:S.pos.x, z:S.pos.z }, yaw0 = S.yaw;

  const plateGone = document.getElementById('plate').classList.contains('gone');

  for (let i=0;i<40;i++){
    wpe('pointermove', 1, vp.width*0.18, vp.height*0.75 - 90);        // push stick up = forward
    wpe('pointermove', 2, vp.width*0.75 + i*3, vp.height*0.5);        // drag look
    window.__VB.step(4);
  }
  const moved = Math.hypot(S.pos.x-p0.x, S.pos.z-p0.z);
  const turned = Math.abs(S.yaw - yaw0);
  wpe('pointerup', 1, vp.width*0.18, vp.height*0.75-90);
  wpe('pointerup', 2, vp.width*0.75+120, vp.height*0.5);

  const cv = document.getElementById('screen');
  return { started, plateGone, movedMetres:+moved.toFixed(2), turnedRad:+turned.toFixed(3),
           perfRung: VB.perf ? VB.perf.rung : null, internal:[cv.width, cv.height],
           cssW: Math.round(parseFloat(cv.style.width)), cssH: Math.round(parseFloat(cv.style.height)),
           png: (window.__VB.step(2), cv.toDataURL('image/png').slice(22)) };
}, vp);

fs.writeFileSync(path.join(ROOT,'shots/mobile.png'), Buffer.from(r.png,'base64'));
delete r.png;
console.log(JSON.stringify(r,null,1));
const pass = r.started && r.plateGone && r.movedMetres > 0.4 && r.turnedRad > 0.05;
console.log(pass ? '\nMOBILE SMOKE TEST: PASS' : '\nMOBILE SMOKE TEST: FAIL');
if (errs.length) console.log('ERRORS:\n'+errs.slice(0,8).join('\n'));
await b.close();
process.exit(pass && !errs.length ? 0 : 1);
