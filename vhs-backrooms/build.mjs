#!/usr/bin/env node
/* Concatenates src/*.js (filename order) into a single self-contained
   index.html. Three.js stays a CDN import — everything else is inlined. */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'index.html');
const THREE_CDN = 'https://unpkg.com/three@0.160.0/build/three.module.js';

const files = fs.readdirSync(SRC).filter(f => f.endsWith('.js')).sort();
if (!files.length) { console.error('no sources'); process.exit(1); }

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
</style>
</head>
<body>
<canvas id="screen"></canvas>
<div id="hit"></div>
<div id="warn"></div>
<script type="importmap">{"imports":{"three":"${THREE_CDN}"}}</script>
<script type="module">
import * as THREE from 'three';
${chunks.join('\n')}
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`built index.html  ${kb} KB  from ${files.length} sources:\n  ` + files.join('\n  '));
