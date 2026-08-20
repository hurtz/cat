/* Collision integrity: walk a long random path and assert the player never
   ends up inside a solid cell, and never gets stuck. */
import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
const ROOT=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--mute-audio']});
const p=await b.newPage({viewport:{width:640,height:480}});
p.on('pageerror',e=>console.log('ERR',e.message.slice(0,160)));
await p.route('**/three.module.js',r=>r.fulfill({status:200,contentType:'text/javascript',body:fs.readFileSync(path.join(ROOT,'vendor/three.module.js'),'utf8')}));
await p.goto('file://'+path.join(ROOT,'index.html'));
await p.waitForFunction('window.__VB && window.__VB.ready',null,{timeout:90000});
console.log(JSON.stringify(await p.evaluate(()=>{
  const VB=window.VB,S=VB.S,L=VB.layout;
  let inside=0, stuck=0, dist=0, hoods={};
  for(let seed of [1337,4242,991]){
    window.__VB.seed(seed);
    for(let leg=0; leg<26; leg++){
      const yaw=Math.random()*Math.PI*2;
      const dirx=-Math.sin(yaw), dirz=-Math.cos(yaw);
      let moved=0;
      for(let i=0;i<60;i++){
        const bx=S.pos.x, bz=S.pos.z;
        S.pos.x+=dirx*0.06; S.pos.z+=dirz*0.06;
        L.collide(S.pos,0.34);
        const d=Math.hypot(S.pos.x-bx,S.pos.z-bz); moved+=d; dist+=d;
        if(L.solidAt(S.pos.x,S.pos.z)) inside++;
      }
      if(moved<0.05) stuck++;
      const h=L.roomKindAt(S.pos.x,S.pos.z); hoods[h]=(hoods[h]||0)+1;
    }
  }
  return {insideWallSamples:inside, stuckLegs:stuck, totalLegs:78, metresWalked:+dist.toFixed(1), hoods};
})));
await b.close();
