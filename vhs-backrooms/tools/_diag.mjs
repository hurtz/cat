import { chromium } from 'playwright';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--mute-audio']});
const p = await b.newPage({viewport:{width:1024,height:768}});
p.on('pageerror',e=>console.log('ERR',e.message));
await p.route('**/three.module.js', r=>r.fulfill({status:200,contentType:'text/javascript',body:fs.readFileSync(path.join(ROOT,'vendor/three.module.js'),'utf8')}));
await p.goto('file://'+path.join(ROOT,'index.html'));
await p.waitForFunction('window.__VB && window.__VB.ready',null,{timeout:60000});
await p.evaluate(()=>window.__VB.seed(1337));
await p.evaluate(()=>window.__VB.step(30));
console.log(JSON.stringify(await p.evaluate(()=>{
  const VB=window.VB,S=VB.S;
  const L=VB.layout;
  const lights=[]; VB.scene.traverse(o=>{ if(o.isPointLight&&o.visible) lights.push({p:[+o.position.x.toFixed(1),+o.position.z.toFixed(1)],i:+o.intensity.toFixed(2)});});
  let meshes=0,tris=0; VB.scene.traverse(o=>{if(o.isMesh){meshes++; if(o.geometry.index)tris+=o.geometry.index.count/3;}});
  const yaw=S.yaw; let run=0; for(let d=0.5;d<40;d+=0.2){ if(L.solidAt(S.pos.x-Math.sin(yaw)*d, S.pos.z-Math.cos(yaw)*d)) break; run=d;} 
  let openCells=0; for(let z=-8;z<=8;z++)for(let x=-8;x<=8;x++) if(!L.solidAt(S.pos.x+x*2.6,S.pos.z+z*2.6)) openCells++;
  return {yawDeg:+(yaw*57.3).toFixed(0), clearRun:+run.toFixed(1), openCells, pos:[+S.pos.x.toFixed(2),+S.pos.z.toFixed(2)], solidHere:L.solidAt(S.pos.x,S.pos.z),
    fixtures:L.fixtures.length, chunks:L.chunkCount(), lights, meshes, tris,
    nearestFixture: L.fixtures.map(f=>Math.hypot(f.pos.x-S.pos.x,f.pos.z-S.pos.z)).sort((a,b)=>a-b).slice(0,3).map(v=>+v.toFixed(1)),
    fog:[VB.scene.fog.near,+VB.scene.fog.far.toFixed(1)], calls:VB.renderer.info.render.calls};
})));
await b.close();
