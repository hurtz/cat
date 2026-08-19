import { chromium } from 'playwright'; import fs from 'node:fs'; import path from 'node:path';
const ROOT=path.resolve(path.dirname(new URL(import.meta.url).pathname),'..');
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--mute-audio']});
const p=await b.newPage({viewport:{width:800,height:600}});
p.on('pageerror',e=>console.log('[pageerror]',e.message.slice(0,200)));
await p.route('**/three.module.js',r=>r.fulfill({status:200,contentType:'text/javascript',body:fs.readFileSync(path.join(ROOT,'vendor/three.module.js'),'utf8')}));
await p.goto('file://'+path.join(ROOT,'index.html'));
await p.waitForFunction('window.__VB && window.__VB.ready',null,{timeout:60000});
// force an immediate sighting: warp past the first-appearance gate, zero the cooldown
const r = await p.evaluate(()=>{
  const VB=window.VB,S=VB.S; S.t=90; let ok=false;
  const log=[]; VB.on('entity:spawn',e=>log.push('spawn d='+Math.hypot(e.pos.x-S.pos.x,e.pos.z-S.pos.z).toFixed(1)));
  VB.on('entity:sighting',e=>log.push('sighting str='+e.strength.toFixed(2)+' d='+e.dist.toFixed(1)));
  VB.on('entity:despawn',()=>log.push('despawn'));
  let maxProx=0, framesVisible=0, shot=null, sinceSeen=0, probe=null;
  for(let i=0;i<260;i++){
    if(!VB.entity.active && !shot)ok = VB.entity.forceSpawn() || ok;
    window.__VB.step(2);
    maxProx=Math.max(maxProx,S.prox);
    const m=VB.entity; if(m.active){framesVisible++;
      if(S.seen>0.35) sinceSeen++; if(sinceSeen===14){
        shot=document.getElementById('screen').toDataURL('image/png').slice(22);
        // project the entity to screen space and measure it against its surroundings
        const v=m.pos.clone(); v.y=1.0; v.project(VB.camera);
        const cv=document.getElementById('screen');
        const sx=Math.round((v.x*0.5+0.5)*cv.width), sy=Math.round((-v.y*0.5+0.5)*cv.height);
        const g3=document.createElement('canvas'); g3.width=cv.width; g3.height=cv.height;
        const c3=g3.getContext('2d'); c3.drawImage(cv,0,0);
        const box=(x0,y0,w,h)=>{const d=c3.getImageData(Math.max(0,x0),Math.max(0,y0),w,h).data;let s=0;
          for(let i=0;i<d.length;i+=4)s+=(d[i]+d[i+1]+d[i+2])/3; return s/(d.length/4);};
        const on=box(sx-9,sy-26,18,52), off=box(sx+42,sy-26,18,52);
        probe={sx,sy,dist:+m.dist.toFixed(1),onEntity:+on.toFixed(1),background:+off.toFixed(1),
               contrast:+(off-on).toFixed(1)};
      }}
    if(log.length>6 && shot) break;
  }
  return {ok,probe,log,maxProx:+maxProx.toFixed(2),framesVisible,stalked:+S.stalked.toFixed(3),shot};
});
console.log(JSON.stringify({ok:r.ok,probe:r.probe,log:r.log,maxProx:r.maxProx,framesVisible:r.framesVisible,stalked:r.stalked},null,1));
if(r.shot) fs.writeFileSync(path.join(ROOT,'shots/entity.png'),Buffer.from(r.shot,'base64'));
console.log(r.shot?'wrote shots/entity.png':'NO SIGHTING FRAME CAPTURED');
await b.close();
