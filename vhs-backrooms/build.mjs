#!/usr/bin/env node
/* Concatenates src/*.js (filename order) into a single self-contained
   index.html. Three.js stays a CDN import — everything else is inlined. */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, 'src');
const ARTIFACT = process.argv.includes('--artifact');
const OUT = path.join(ROOT,
  ARTIFACT ? 'artifact.html' : process.argv.includes('--inline') ? 'play.html' : 'index.html');
const THREE_CDN = 'https://unpkg.com/three@0.160.0/build/three.module.js';

/* --inline embeds Three.js in the page instead of importing it from the CDN.
   The shipped index.html uses the CDN as specified; the inlined build exists
   for sandboxed embeds whose CSP refuses external hosts. */
const INLINE = process.argv.includes('--inline') || process.argv.includes('--artifact');
const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).sort();
if (!files.length) { console.error('no sources'); process.exit(1); }

/* Inlining Three.js means it lands in the SAME module scope as our code, so it
   cannot stay an ES module — a separate <script type="module"> would not share
   its bindings. Three ends in exactly one `export { ... }` statement, so rewrite
   that statement into a plain namespace object and everything downstream can go
   on saying THREE.WebGLRenderer unchanged. */
function threeInline() {
  const src = fs.readFileSync(path.join(ROOT, 'vendor/three.module.js'), 'utf8');
  const m = src.match(/\nexport \{([\s\S]*?)\};?\s*$/);
  if (!m) throw new Error('could not find the Three.js export statement to rewrite');
  const members = m[1].split(',').map(t => t.trim()).filter(Boolean).map(t => {
    const as = t.split(/\s+as\s+/);
    return as.length === 2 ? `${as[1]}: ${as[0]}` : t;
  });
  return src.slice(0, m.index) + `\nconst THREE = { ${members.join(', ')} };\n`;
}

const chunks = files.map(f => {
  const body = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/﻿/g, '');
  return `\n/* ==== ${f} ${'='.repeat(Math.max(0, 66 - f.length))} */\n${body}`;
});

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>SUNSET TERRACE — TAPE 04</title>
<style>
  html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden;
    -webkit-user-select:none;user-select:none;touch-action:none}
  #screen{position:absolute;display:block;image-rendering:auto;background:#000}
  #hit{position:absolute;inset:0;cursor:none;background:transparent}
  #warn{position:absolute;left:0;right:0;bottom:6px;text-align:center;color:#5a5a5a;
    font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.14em;pointer-events:none}
  /* The start plate is the paused VCR, not a game menu. */
  #plate{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;
    justify-content:center;gap:22px;background:#000;color:#c8c2a4;text-align:center;
    font:14px/2 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.26em;
    pointer-events:none;transition:opacity .5s ease;z-index:5}
  #plate.gone{opacity:0}
  #plate b{font-size:19px;letter-spacing:.42em;color:#e6dfbe;font-weight:600}
  #plate s{text-decoration:none;color:#6f6a54;font-size:11px;letter-spacing:.2em}
  #plate i{font-style:normal;color:#8a8a72}
  @keyframes pl{0%,44%{opacity:.15}50%,100%{opacity:1}}
  #plate u{text-decoration:none;animation:pl 1.6s steps(1,end) infinite}
</style>
</head>
<body>
<canvas id="screen"></canvas>
<div id="hit"></div>
<div id="plate">
  <b>SUNSET TERRACE</b>
  <s>PROPERTY OF FACILITIES MGMT &nbsp;&middot;&nbsp; TAPE 04 &nbsp;&middot;&nbsp; DO NOT ERASE</s>
  <u>&#9654; CLICK TO PLAY</u>
  <s id="ctl">WASD MOVE &nbsp;&middot;&nbsp; MOUSE LOOK &nbsp;&middot;&nbsp; SHIFT RUN &nbsp;&middot;&nbsp; E INTERACT</s>
  <s>headphones recommended</s>
</div>
<div id="warn"></div>
${INLINE ? '' : `<script type="importmap">{"imports":{"three":"${THREE_CDN}"}}</script>`}
<script type="module">
${INLINE ? threeInline() : "import * as THREE from 'three';"}
${chunks.join('\n')}
</script>
</body>
</html>
`;

/* The artifact host supplies its own doctype/html/head/body, so that variant
   ships the page's contents only. The <title> has to stay in the first 8KB,
   which is why it precedes the 1.4MB of inlined Three.js. */
let outHtml = html;
if (ARTIFACT) {
  outHtml = html
    /* Gallery title is the name alone — the "— TAPE 04" suffix is an
       explainer, and that belongs in the publish description. */
    .replace(/^[\s\S]*?<title>[^<]*<\/title>/, '<title>Sunset Terrace</title>')
    .replace(/<\/head>\s*<body>/, '')
    .replace(/<\/body>\s*<\/html>\s*$/, '');
}
fs.writeFileSync(OUT, outHtml);
const kb = (Buffer.byteLength(outHtml) / 1024).toFixed(1);
console.log(`built ${path.basename(OUT)}  ${kb} KB  from ${files.length} sources:\n  ` + files.join('\n  '));
