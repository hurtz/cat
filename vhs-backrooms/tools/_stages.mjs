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
await p.evaluate(()=>window.__VB.step(200));
console.log(await p.evaluate(()=>{
  const VB=window.VB, R=VB.renderer, px=VB.mods.postfx;
  const out=[];
  const stats=(rt,name)=>{
    const buf=new Uint8Array(rt.width*rt.height*4);
    R.readRenderTargetPixels(rt,0,0,rt.width,rt.height,buf);
    let s=[0,0,0],mx=0,n=rt.width*rt.height;
    for(let i=0;i<n;i++){s[0]+=buf[i*4];s[1]+=buf[i*4+1];s[2]+=buf[i*4+2];mx=Math.max(mx,buf[i*4]);}
    out.push(`${name}: mean=(${(s[0]/n).toFixed(1)},${(s[1]/n).toFixed(1)},${(s[2]/n).toFixed(1)}) maxR=${mx}`);
  };
  for(const k of Object.keys(px)) {} // no-op
  const dbg = px.__rts ? px.__rts : null;
  if(!dbg) out.push('no __rts export');
  else for(const [n,rt] of Object.entries(dbg)) stats(rt,n);
  const cv=document.getElementById('screen');
  const g=document.createElement('canvas'); g.width=cv.width; g.height=cv.height;
  const c2=g.getContext('2d'); c2.drawImage(cv,0,0);
  const d=c2.getImageData(0,0,cv.width,cv.height).data;
  let s2=[0,0,0,0]; const n2=cv.width*cv.height;
  for(let i=0;i<n2;i++){s2[0]+=d[i*4];s2[1]+=d[i*4+1];s2[2]+=d[i*4+2];s2[3]+=d[i*4+3];}
  out.push(`CANVAS: mean=(${(s2[0]/n2).toFixed(1)},${(s2[1]/n2).toFixed(1)},${(s2[2]/n2).toFixed(1)}) alpha=${(s2[3]/n2).toFixed(1)}`);
  return out.join('\n');
}));
await b.close();
