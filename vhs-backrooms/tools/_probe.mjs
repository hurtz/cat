import { chromium } from 'playwright';
import fs from 'fs';
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-gpu-sandbox','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport:{width:640,height:480} });
await p.route('**/three.module.js', r => r.fulfill({ status:200, contentType:'text/javascript', body: fs.readFileSync('vendor/three.module.js','utf8') }));
p.on('console', m=>console.log('[console]', m.text()));
p.on('pageerror', e=>console.log('[pageerror]', e.message));
await p.goto('file:///tmp/claude-0/-home-user-cat/c67f864b-5de8-5c07-8076-96abc968a809/scratchpad/webgltest.html');
await p.waitForFunction('window.__ok', null, {timeout:60000});
console.log(JSON.stringify(await p.evaluate(()=>window.__ok)));
await p.screenshot({path:'shots/_probe.png'});
await b.close();
