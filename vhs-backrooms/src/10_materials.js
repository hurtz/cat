/* ============================================================================
   MATERIALS — every surface generated into a <canvas> at boot. No image files.

   Authoring rules that the rest of this file obeys:

   * Physical scale is fixed by the layout module. Wall UVs arrive as
     u = worldDistance / CELL (2.6 m) and v = height / CEIL (2.72 m), so a wall
     texture with repeat.x = 0.5 covers 5.2 m of wall by 2.72 m of height. Every
     wall texture here is 1024x512 => ~197 px/m across, ~188 px/m up. Floor and
     ceiling repeat every 2 cells = 5.2 m at 1024^2 => ~197 px/m. Everything is
     sized in metres first and converted, so a skirting board is 11 cm because a
     skirting board is 11 cm.

   * Horizontal seams are visible: wall U is continuous along a whole run of
     wall, and floor/ceiling tile in both axes. So all noise is *periodic*
     value-noise fBm on a wrapping lattice, all stripes have an integer cycle
     count across the texture, and every stamped feature wraps its bounding box.

   * The VHS chain downstream destroys fine detail and lifts blacks. What
     survives is mid-scale structure and value contrast, so features are
     authored 3-30 cm and given real edges. Nothing here is pre-degraded — no
     scanlines, no noise-for-the-look; the pipeline does that.

   * Damp is the whole game. Real damp has a *hard tide line* with a
     concentrated mineral rim and a soft mottled interior — not an airbrush
     blob. Everything wet in this file is a thresholded noise field, never a
     radial gradient.
   ========================================================================== */
VB.def('materials', function (VB, THREE) {

  const CEILH = 2.72;             // must match layout CEIL
  const WALLW = 5.2;              // metres of wall per wall texture (2 cells)
  const FLOORW = 5.2;             // metres of floor/ceiling per texture (2 cells)

  let genMs = 0, genBytes = 0;

  /* ------------------------------------------------------------------ utils */
  function cv(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    genBytes += w * h * 4;
    return { c, g: c.getContext('2d') };
  }
  function tex(canvas, rx, ry) {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx || 1, ry || 1);
    t.anisotropy = 4;
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
  const cl01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const cl255 = v => (v < 0 ? 0 : v > 255 ? 255 : v);
  /* smoothstep from a..b */
  function ss(a, b, x) { const t = cl01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

  /* Tileable 2D value-noise fBm.
     The lattice wraps at (cx*2^o, cy*2^o) so the field is exactly periodic over
     the texture; per-row/per-column index tables keep the inner loop to four
     lookups and three lerps, which is the only reason this is affordable at
     1024^2. Returns Float32Array(W*H) in 0..1. */
  function nf(W, H, cx, cy, oct, seed) {
    const out = new Float32Array(W * H);
    let amp = 1, norm = 0, px = cx, py = cy;
    const ix0 = new Int32Array(W), ix1 = new Int32Array(W), ux = new Float32Array(W);
    const iy0 = new Int32Array(H), iy1 = new Int32Array(H), uy = new Float32Array(H);
    for (let o = 0; o < oct; o++) {
      const R = VB.rngFrom((seed + o * 7919) >>> 0);
      const lat = new Float32Array(px * py);
      for (let i = 0; i < lat.length; i++) lat[i] = R();
      for (let x = 0; x < W; x++) {
        const t = x * px / W, i = Math.floor(t), f = t - i;
        ix0[x] = i % px; ix1[x] = (i + 1) % px; ux[x] = f * f * (3 - 2 * f);
      }
      for (let y = 0; y < H; y++) {
        const t = y * py / H, i = Math.floor(t), f = t - i;
        iy0[y] = i % py; iy1[y] = (i + 1) % py; uy[y] = f * f * (3 - 2 * f);
      }
      for (let y = 0; y < H; y++) {
        const r0 = iy0[y] * px, r1 = iy1[y] * px, v = uy[y], off = y * W;
        for (let x = 0; x < W; x++) {
          const u = ux[x], a0 = ix0[x], a1 = ix1[x];
          const a = lat[r0 + a0], b = lat[r0 + a1], c = lat[r1 + a0], d = lat[r1 + a1];
          const t0 = a + (b - a) * u, t1 = c + (d - c) * u;
          out[off + x] += (t0 + (t1 - t0) * v) * amp;
        }
      }
      norm += amp; amp *= 0.5; px *= 2; py *= 2;
    }
    const inv = 1 / norm;
    for (let i = 0; i < out.length; i++) out[i] *= inv;
    return out;
  }
  /* 1D version — tide lines, stripe warps, leak placement */
  function nf1(W, cells, oct, seed) {
    const out = new Float32Array(W);
    let amp = 1, norm = 0, p = cells;
    for (let o = 0; o < oct; o++) {
      const R = VB.rngFrom((seed + o * 104729) >>> 0);
      const lat = new Float32Array(p);
      for (let i = 0; i < p; i++) lat[i] = R();
      for (let x = 0; x < W; x++) {
        const t = x * p / W, i = Math.floor(t), f = t - i;
        const a = lat[i % p], b = lat[(i + 1) % p], u = f * f * (3 - 2 * f);
        out[x] += (a + (b - a) * u) * amp;
      }
      norm += amp; amp *= 0.5; p *= 2;
    }
    for (let i = 0; i < W; i++) out[i] /= norm;
    return out;
  }
  /* draw fn at x, and again shifted a texture-width so features wrap the seam */
  function wrapX(g, W, x, pad, fn) {
    fn(x);
    if (x < pad) fn(x + W);
    else if (x > W - pad) fn(x - W);
  }

  /* ==========================================================================
     WALLPAPER
     1024x512 = 5.2 m x 2.72 m. Bottom of the canvas is the floor.
     ======================================================================== */
  function makeWall(P) {
    const W = 1024, H = 512, hw = W >> 1, hh = H >> 1;
    const PPM = H / CEILH;                 // pixels per metre, vertical
    const R = VB.rngFrom(P.seed);
    const { c, g } = cv(W, H);

    /* --- fields. Half-res for anything whose finest feature is > 4 cm. --- */
    const fBlot = nf(hw, hh, 4, 2, 3, P.seed + 11);      // ~1.3 m blotching
    const fMot = nf(hw, hh, 14, 7, 4, P.seed + 23);      // ~9-37 cm mottle
    const fFin = nf(hw, hh, 56, 28, 3, P.seed + 37);     // ~2-9 cm
    const fStr = nf(hw, hh, 130, 7, 3, P.seed + 53);     // vertical streaking
    const fDmp = nf(W, H, 12, 6, 5, P.seed + 71);        // full-res: tide edge

    /* --- per-column: the printing, the drop seams, the tide height --- */
    const warp = nf1(W, 5, 3, P.seed + 97);
    const NS = 50;                                        // ~10 cm print stripes
    const stripeS = new Float32Array(NS);
    for (let i = 0; i < NS; i++) stripeS[i] = R();
    const NDROP = 10;                                     // 52 cm paper drops
    const dropS = new Float32Array(NDROP);
    for (let i = 0; i < NDROP; i++) dropS[i] = R();
    const colL = new Float32Array(W), tide = new Float32Array(W), leak = new Float32Array(W);
    const tA = nf1(W, 7, 4, P.seed + 113), tB = nf1(W, 29, 2, P.seed + 131);
    const lk = nf1(W, 13, 3, P.seed + 149);
    const dropPx = W / NDROP;
    for (let x = 0; x < W; x++) {
      const w = warp[x] - 0.5;
      /* wide printed stripe: per-stripe shade, phase-warped so the period is
         uneven — a roller print, not a ruler */
      const sx = x * NS / W + w * 0.9;
      const sfl = Math.floor(sx);
      let si = sfl % NS; if (si < 0) si += NS;
      let l = 1 + (stripeS[si] - 0.5) * P.stripe;
      l *= 1 + 0.017 * Math.cos((sx - sfl) * 6.2831853);
      /* fine print line, ~2.6 cm */
      l *= 1 + 0.019 * Math.cos(6.2831853 * (x * 200 / W + w * 0.6));
      /* the butt joint between paper drops, and the edge that catches light */
      const dp = x * NDROP / W, dpx = (dp - Math.floor(dp)) * dropPx;
      let di = Math.floor(dp) % NDROP; if (di < 0) di += NDROP;
      l *= 1 + (dropS[di] - 0.5) * 0.05;
      if (dpx < 1.3) l *= 0.945; else if (dpx < 2.8) l *= 1.022;
      colL[x] = l;
      tide[x] = P.tide + (tA[x] - 0.5) * P.tideVar + (tB[x] - 0.5) * P.tideVar * 0.4;
      leak[x] = P.leak * Math.max(0, lk[x] - 0.60) * 2.8;
    }

    /* --- per-row: the bands. Skirting, chair rail, and the shadows they cast.
       Doing this per row (not as a drawn rectangle) means the damp and the
       grime modulate the joinery too, which is what actually sells it. --- */
    const rowC = new Float32Array(H * 3), rowL = new Float32Array(H);
    const hgt = new Float32Array(H), trim = new Uint8Array(H);
    const SK = 0.115, RAIL0 = 0.895, RAIL1 = 0.958;
    const wallC = P.base, railC = P.trim, skirtC = P.skirt;
    for (let y = 0; y < H; y++) {
      const h = (H - 1 - y + 0.5) / PPM;
      hgt[y] = h;
      let cr = wallC[0], cg = wallC[1], cb = wallC[2], l = 1;
      /* vinyl embossing, ~1.6 cm */
      l *= 1 + 0.013 * Math.cos(6.2831853 * y * 170 / H);
      if (h < SK) {
        /* skirting board: painted, dirtier toward the carpet, black gap below */
        trim[y] = 1;
        const u = h / SK;                       // 0 at the floor, 1 at the top
        cr = skirtC[0]; cg = skirtC[1]; cb = skirtC[2];
        l *= 0.84 + 0.20 * u;
        if (u > 0.93) l *= 1.16;                // top edge catches the light
        if (h < 0.012) l *= 0.42;               // the gap where it meets carpet
        else if (h < 0.022) l *= 0.68;
      } else if (h < SK + 0.018) {
        l *= 0.90 + 4.0 * (h - SK);             // shadow the skirting throws up
      } else if (h >= RAIL0 && h <= RAIL1) {
        /* chair rail batten */
        trim[y] = 1;
        const u = (h - RAIL0) / (RAIL1 - RAIL0);
        cr = railC[0]; cg = railC[1]; cb = railC[2];
        l *= 0.90 + 0.22 * u;
        if (u > 0.88) l *= 1.20;
        if (u < 0.10) l *= 0.72;
      } else if (h < RAIL0 && h > RAIL0 - 0.035) {
        l *= 0.70 + 8.0 * (RAIL0 - h);          // hard shadow under the batten
      } else if (h > RAIL1 && h < RAIL1 + 0.02) {
        l *= 1.05;                              // dust ledge above it
      }
      rowC[y * 3] = cr; rowC[y * 3 + 1] = cg; rowC[y * 3 + 2] = cb;
      rowL[y] = l;
    }

    /* ------------------------------------------------------- the pixel pass */
    const img = g.createImageData(W, H), px = img.data;
    const dR = 118, dG = 99, dB = 57;           // wet paper
    const rR = 88, rG = 68, rB = 36;            // the tide mark itself
    const mR = 74, mG = 76, mB = 60;            // mould
    for (let y = 0; y < H; y++) {
      const h = hgt[y], rl = rowL[y], isTrim = trim[y];
      const br = rowC[y * 3], bg = rowC[y * 3 + 1], bb = rowC[y * 3 + 2];
      const ho = (y >> 1) * hw, off = y * W;
      /* how far below the ceiling, for leak runs */
      const drop = CEILH - h;
      const leakFall = cl01(1 - drop / P.leakLen);
      for (let x = 0; x < W; x++) {
        const hi = ho + (x >> 1);
        let lum = rl * (isTrim ? 1 : colL[x]);
        lum *= 1 + (fBlot[hi] - 0.5) * 0.155;
        lum *= 1 + (fMot[hi] - 0.5) * 0.085;
        lum *= 1 + (fFin[hi] - 0.5) * 0.05;
        let r = br * lum, gg = bg * lum, b = bb * lum;

        /* ---- rising damp: threshold a noise field against the tide line ---- */
        const d = tide[x] + (fDmp[off + x] - 0.5) * P.dampRough - h;
        if (d > -0.09) {
          const body = ss(0, 0.038, d);                     // hard-ish edge
          if (body > 0.001) {
            /* wetter toward the floor, streaked, mottled */
            const wet = 0.5 + 0.5 * cl01(1 - h / Math.max(0.2, tide[x]));
            const mott = 0.6 + 0.8 * fStr[hi];
            const amt = cl01(P.damp * body * wet * mott);
            const k = amt * 0.62;
            r += (dR - r) * k; gg += (dG - gg) * k; b += (dB - b) * k;
            /* mould blooms in the wettest, oldest part */
            const mo = (fFin[hi] - 0.70) * 3.2 * amt * P.mould;
            if (mo > 0) { const q = cl01(mo); r += (mR - r) * q; gg += (mG - gg) * q; b += (mB - b) * q; }
          }
          /* the tide line: a narrow concentrated rim right at the boundary */
          const q = d / 0.058, rim = P.damp / (1 + q * q * 2.4);
          if (rim > 0.004) {
            const k = cl01(rim * 0.72);
            r += (rR - r) * k; gg += (rG - gg) * k; b += (rB - b) * k;
          }
        }

        /* ---- leak running down from the ceiling ---- */
        if (leakFall > 0 && leak[x] > 0) {
          const runnel = ss(0.40, 0.56, fStr[hi] + (fDmp[off + x] - 0.5) * 0.25);
          const a = cl01(leak[x] * leakFall * runnel);
          if (a > 0.004) {
            const k = a * 0.55;
            r += (128 - r) * k; gg += (104 - gg) * k; b += (58 - b) * k;
            const edge = a * ss(0.52, 0.58, fStr[hi]) * 0.35;
            r -= 22 * edge; gg -= 20 * edge; b -= 12 * edge;
          }
        }

        /* ---- general floor-level grime, independent of the damp ---- */
        if (h < 0.5) {
          const gr = ss(0.5, 0.0, h) * (0.45 + 0.55 * fMot[hi]) * P.grime;
          r *= 1 - gr * 0.22; gg *= 1 - gr * 0.21; b *= 1 - gr * 0.16;
        }

        const i = (off + x) << 2;
        px[i] = cl255(r); px[i + 1] = cl255(gg); px[i + 2] = cl255(b); px[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    /* ------------------------------------------------- struck-on detail ---- */
    const yOf = m => H - m * PPM;

    /* peeled / blown paper — only on the ruined variant */
    if (P.peel > 0) {
      const n = 3 + Math.floor(R() * 4);
      for (let i = 0; i < n; i++) {
        const cx0 = R() * W, cy0 = yOf(0.15 + R() * (P.tide + 0.5));
        const rad = 14 + R() * 46;
        wrapX(g, W, cx0, rad * 2.2, (cx) => {
          g.beginPath();
          for (let a = 0; a <= 6.2832; a += 0.32) {
            const rr = rad * (0.5 + 0.75 * VB.vnoise1(a * 1.9 + i * 11, P.seed + i));
            const qx = cx + Math.cos(a) * rr, qy = cy0 + Math.sin(a) * rr * 0.8;
            a === 0 ? g.moveTo(qx, qy) : g.lineTo(qx, qy);
          }
          g.closePath();
          g.fillStyle = `rgba(${(96 + R() * 20) | 0},${(88 + R() * 18) | 0},${(72 + R() * 16) | 0},0.88)`;
          g.fill();
          /* the curled edge of the paper still attached, catching light */
          g.lineWidth = 1.6; g.strokeStyle = 'rgba(238,230,186,0.55)'; g.stroke();
          g.lineWidth = 0.8; g.strokeStyle = 'rgba(48,40,20,0.45)'; g.stroke();
        });
      }
    }

    /* scuffs and trolley knocks, concentrated at traffic height */
    const nSc = Math.round(150 * P.scuff);
    for (let i = 0; i < nSc; i++) {
      const t = R();
      /* three populations: chair backs at the rail, trolleys at 0.55 m, and
         shoes/vacuums on the skirting */
      const hgtM = t < 0.42 ? 0.86 + R() * 0.16
        : t < 0.80 ? 0.34 + R() * 0.42
          : 0.01 + R() * 0.11;
      const y = yOf(hgtM), len = 3 + R() * (hgtM < 0.15 ? 26 : 46);
      const dark = R() < 0.72;
      const a = (dark ? 0.10 + R() * 0.24 : 0.08 + R() * 0.14) * P.scuff;
      wrapX(g, W, R() * W, len + 6, (x) => {
        g.strokeStyle = dark
          ? `rgba(${(54 + R() * 22) | 0},${(46 + R() * 20) | 0},${(30 + R() * 16) | 0},${a.toFixed(3)})`
          : `rgba(238,232,196,${a.toFixed(3)})`;
        g.lineWidth = 0.6 + R() * 2.2;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + len * (R() - 0.15), y + (R() - 0.5) * 4);
        g.stroke();
      });
    }
    /* a handful of hard black rubber knocks — bumper height, with a bright
       scrape through the middle where the paper is torn back */
    const nK = Math.round(9 * P.scuff);
    for (let i = 0; i < nK; i++) {
      const y = yOf(0.24 + R() * 0.30), len = 10 + R() * 34;
      wrapX(g, W, R() * W, len + 8, (x) => {
        g.strokeStyle = 'rgba(38,34,26,0.38)'; g.lineWidth = 2.4 + R() * 2.6; g.lineCap = 'round';
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + (R() - 0.5) * 2); g.stroke();
        g.strokeStyle = 'rgba(226,218,178,0.30)'; g.lineWidth = 0.8;
        g.beginPath(); g.moveTo(x + 2, y - 0.6); g.lineTo(x + len - 2, y - 0.6 + (R() - 0.5) * 2); g.stroke();
      });
    }
    /* nicks out of the chair rail and the skirting */
    for (let i = 0; i < 26; i++) {
      const onRail = R() < 0.5;
      const y = onRail ? yOf(RAIL0 + R() * (RAIL1 - RAIL0)) : yOf(0.015 + R() * 0.09);
      wrapX(g, W, R() * W, 12, (x) => {
        g.fillStyle = `rgba(70,60,36,${(0.22 + R() * 0.3).toFixed(2)})`;
        g.fillRect(x, y, 1 + R() * 4, 1 + R() * 2.5);
      });
    }
    /* the dirty halo along the top of the skirting where the vacuum never goes */
    const skTop = yOf(SK);
    const sh = g.createLinearGradient(0, skTop - 5, 0, skTop + 2);
    sh.addColorStop(0, 'rgba(52,44,24,0)');
    sh.addColorStop(1, 'rgba(52,44,24,0.30)');
    g.fillStyle = sh; g.fillRect(0, skTop - 5, W, 7);

    return c;
  }

  /* ==========================================================================
     CARPET — commercial level-loop, greyer and dirtier than the walls.
     1024x1024 = 5.2 m square, ~197 px/m. Loop pitch 2 px = 1 cm.
     ======================================================================== */
  function makeCarpet(P) {
    const W = 1024, H = 1024, hw = W >> 1, hh = H >> 1;
    const R = VB.rngFrom(P.seed);
    const { c, g } = cv(W, H);

    const fBlot = nf(hw, hh, 4, 4, 3, P.seed + 11);    // 1.3 m soiling
    const fLane = nf(hw, hh, 3, 9, 3, P.seed + 23);    // elongated wear paths
    const fClump = nf(hw, hh, 80, 80, 2, P.seed + 37); // ~3-6 cm pile clumping
    const fWarp = nf(W, H, 22, 22, 4, P.seed + 51);    // stain lobes, full-res

    /* the yarn. Commercial carpet is a heather — three or four yarn colours
       twisted together, which is what stops it reading as a flat plane. */
    const yarn = P.yarn;
    const LN = W >> 1;                                  // 512 loops across
    const loop = new Float32Array(LN * LN);
    for (let i = 0; i < loop.length; i++) loop[i] = R();

    const img = g.createImageData(W, H), px = img.data;
    const ny = yarn.length;
    for (let y = 0; y < H; y++) {
      const ry = y >> 1, ho = (y >> 1) * hw, off = y * W;
      const rowDark = (y & 1) ? 0.945 : 1.0;            // the gap between loop rows
      const brick = ry & 1;
      for (let x = 0; x < W; x++) {
        const hi = ho + (x >> 1);
        const li = ry * LN + (((x + brick) >> 1) & (LN - 1));
        const v = loop[li];
        /* pick a yarn */
        let yi = (v * ny) | 0; if (yi >= ny) yi = ny - 1;
        const yc = yarn[yi];
        let r = yc[0], gg = yc[1], b = yc[2];
        /* per-loop shade + the 2x2 emboss that reads as a loop at close range */
        let lum = rowDark * (0.90 + 0.20 * ((v * 7.3) % 1));
        lum *= (x & 1) ? 1.035 : 0.965;
        lum *= 1 + (fClump[hi] - 0.5) * 0.17;
        lum *= 1 + (fBlot[hi] - 0.5) * 0.16;

        /* traffic lane: crushed, greyer, less contrast between yarns */
        const lane = ss(0.50, 0.80, fLane[hi]) * P.lane;
        if (lane > 0.002) {
          const mean = P.mean;
          const k = lane * 0.60;
          r += (mean[0] - r) * k; gg += (mean[1] - gg) * k; b += (mean[2] - b) * k;
          const k2 = lane * 0.22;
          r += (118 - r) * k2; gg += (114 - gg) * k2; b += (100 - b) * k2;
          lum *= 1 - lane * 0.10;
        }
        /* broad ground-in dirt */
        const soil = ss(0.58, 0.95, fBlot[hi] * 0.6 + fClump[hi] * 0.4) * P.soil;
        if (soil > 0.002) {
          const k = soil * 0.45;
          r += (74 - r) * k; gg += (68 - gg) * k; b += (48 - b) * k;
        }
        r *= lum; gg *= lum; b *= lum;
        const i = (off + x) << 2;
        px[i] = cl255(r); px[i + 1] = cl255(gg); px[i + 2] = cl255(b); px[i + 3] = 255;
      }
    }

    /* ---------------------------------------------------------- the stains
       A stain is a thresholded distance field warped by noise: irregular
       lobes, a hard edge, and a rim that is *darker* than the middle because
       the solute wicks outward and dries at the boundary. Nothing here is a
       radial gradient. */
    function stamp(sx, sy, rad, sq, rough, core, rim, col, rimCol, hard) {
      const rx = Math.ceil(rad * (1 + rough)) + 2;
      const ry = Math.ceil(rad * (1 + rough) / sq) + 2;
      for (let yy = -ry; yy <= ry; yy++) {
        const py0 = Math.round(sy) + yy, wy = ((py0 % H) + H) % H, row = wy * W;
        const dy = yy * sq;
        for (let xx = -rx; xx <= rx; xx++) {
          const px0 = Math.round(sx) + xx, wx = ((px0 % W) + W) % W;
          const dx = xx;
          let d = Math.sqrt(dx * dx + dy * dy) / rad;
          d += (fWarp[row + wx] - 0.5) * rough * 2;
          if (d >= 1.0) continue;
          const a = 1 - ss(1 - hard, 1.0, d);
          if (a <= 0.002) continue;
          const rimA = ss(0.45, 0.94, d) * rim;
          const k = cl01(a * (core * (1 - d * 0.35) + rimA));
          const i = (row + wx) << 2;
          const cc = rimA > core * 0.5 ? rimCol : col;
          px[i] = cl255(px[i] + (cc[0] - px[i]) * k);
          px[i + 1] = cl255(px[i + 1] + (cc[1] - px[i + 1]) * k);
          px[i + 2] = cl255(px[i + 2] + (cc[2] - px[i + 2]) * k);
        }
      }
    }
    const STAINS = [
      /* [colour, rim colour] */
      [[86, 70, 40], [58, 44, 20]],     // coffee / tea
      [[70, 62, 44], [44, 38, 24]],     // ground-in dirt
      [[96, 86, 46], [64, 56, 26]],     // old spill
      [[58, 56, 50], [36, 34, 30]],     // something worse
    ];
    const nSt = Math.round(P.stains);
    for (let i = 0; i < nSt; i++) {
      const big = R() < 0.30;
      const rad = big ? 26 + R() * 44 : 6 + R() * 20;      // 3-35 cm
      const s = STAINS[(R() * STAINS.length) | 0];
      const sx = R() * W, sy = R() * H;
      stamp(sx, sy, rad, 0.8 + R() * 0.5, 0.30 + R() * 0.30,
        0.30 + R() * 0.34, 0.55 + R() * 0.55, s[0], s[1], 0.06 + R() * 0.06);
      /* satellite droplets — a spill throws them, and they are the thing that
         makes a stain read as a spill rather than a texture blob */
      const nd = big ? 4 + (R() * 8 | 0) : (R() * 3 | 0);
      for (let k = 0; k < nd; k++) {
        const a = R() * 6.2832, dd = rad * (1.1 + R() * 1.4);
        stamp(sx + Math.cos(a) * dd, sy + Math.sin(a) * dd * 0.8,
          1.5 + R() * 4, 1, 0.35, 0.34 + R() * 0.3, 0.5, s[0], s[1], 0.35);
      }
    }
    /* cigarette burns: a black centre with a scorched ring */
    for (let i = 0; i < P.burns; i++) {
      const sx = R() * W, sy = R() * H;
      stamp(sx, sy, 4 + R() * 4, 1, 0.25, 0.10, 1.5, [96, 78, 46], [42, 32, 20], 0.25);
      stamp(sx, sy, 1.6 + R() * 1.6, 1, 0.2, 0.85, 0.2, [26, 22, 18], [26, 22, 18], 0.45);
    }
    /* long thin drag scrapes where something heavy was pulled */
    for (let i = 0; i < P.drags; i++) {
      const x0 = R() * W, y0 = R() * H, a = R() * 6.2832, len = 60 + R() * 260;
      const dxs = Math.cos(a), dys = Math.sin(a);
      const wob = R() * 0.02;
      for (let t = 0; t < len; t += 1.5) {
        const jx = Math.sin(t * wob) * 6;
        stamp(x0 + dxs * t - dys * jx, y0 + dys * t + dxs * jx,
          1.6 + R() * 2.2, 1, 0.2, 0.16, 0.2, [78, 70, 46], [60, 52, 32], 0.5);
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  /* ==========================================================================
     CEILING — 2 ft x 4 ft mineral fibre in a 15/16" T-grid.
     1024x1024 = 5.2 m square: 8 x 4 tiles of 0.65 x 1.3 m, 128 x 256 px each.
     Most tiles are plain. The point is the *contrast* between a clean tile and
     a ruined one, so damage is localised into leak groups.
     ======================================================================== */
  function makeCeiling(P) {
    const W = 1024, H = 1024;
    const TX = 8, TY = 4, TW = W / TX, TH = H / TY;
    const R = VB.rngFrom(P.seed);
    const { c, g } = cv(W, H);

    const fFine = nf(W >> 1, H >> 1, 128, 128, 2, P.seed + 11);   // ~2 cm grain
    const fSoil = nf(W >> 1, H >> 1, 6, 6, 3, P.seed + 23);       // broad ageing
    const fWarp = nf(W, H, 20, 20, 4, P.seed + 37);               // stain lobes
    /* pinholes: mineral fibre is perforated, ~1 mm holes, subpixel here, so
       they live as a dense hard speckle rather than as drawn dots */
    const SP = 512, spk = new Uint8Array(SP * SP);
    for (let i = 0; i < spk.length; i++) spk[i] = (R() * 256) | 0;

    /* --- leak groups: 1-3 wet spots, each ruining one tile and wetting the
       tiles next to it. Everything else stays clean. --- */
    const leaks = [];
    for (let i = 0; i < P.leaks; i++) leaks.push({ x: R() * W, y: R() * H, r: 120 + R() * 220 });

    const tiles = [];
    for (let ty = 0; ty < TY; ty++) {
      for (let tx = 0; tx < TX; tx++) {
        const cx = (tx + 0.5) * TW, cy = (ty + 0.5) * TH;
        let wet = 0, lx = cx, ly = cy;
        for (const L of leaks) {
          /* wrapped distance so a leak near the seam still works */
          let dx = L.x - cx, dy = L.y - cy;
          if (dx > W / 2) dx -= W; if (dx < -W / 2) dx += W;
          if (dy > H / 2) dy -= H; if (dy < -H / 2) dy += H;
          const d = Math.hypot(dx, dy);
          const s = cl01(1 - d / L.r);
          if (s > wet) { wet = s; lx = cx + dx * 0.75; ly = cy + dy * 0.75; }
        }
        tiles.push({
          tx, ty, cx, cy,
          bright: 0.93 + R() * 0.14,
          hue: R(),
          dir: R() < 0.72 ? 1 : 0,          // fissures mostly run along the tile
          fis: 10 + R() * 26,
          wet: wet * wet,                    // sharpen the falloff
          wx: lx, wy: ly,
          sag: wet > 0.35 ? cl01((wet - 0.3) * 1.6) * (0.5 + R() * 0.5) : (R() < 0.10 ? 0.25 + R() * 0.4 : 0),
          rings: 3 + ((R() * 3) | 0),
        });
      }
    }

    /* ------------------------------------------------------- the pixel pass */
    const img = g.createImageData(W, H), px = img.data;
    const base = P.base;
    for (let y = 0; y < H; y++) {
      const ty = (y / TH) | 0, ly = y - ty * TH;
      const ho = (y >> 1) * (W >> 1), off = y * W, sy = (y & (SP - 1)) * SP;
      for (let x = 0; x < W; x++) {
        const tx = (x / TW) | 0, lx = x - tx * TW;
        const T = tiles[ty * TX + tx];
        const hi = ho + (x >> 1);
        let lum = T.bright;
        /* the perforation reads as a fine hard speckle */
        const s = spk[sy + (x & (SP - 1))];
        lum *= s < 26 ? 0.80 : s < 70 ? 0.93 : 1.0;
        lum *= 1 + (fFine[hi] - 0.5) * 0.10;
        /* age: tiles yellow unevenly, and the edges of a tile are dirtier */
        const edge = Math.min(lx, TW - lx, ly, TH - ly);
        lum *= 1 - ss(9, 1, edge) * 0.10;
        let r = base[0] * lum, gg = base[1] * lum, b = base[2] * lum;
        const age = ss(0.45, 0.95, fSoil[hi]) * P.age;
        if (age > 0.002) { const k = age * 0.5; r += (166 - r) * k; gg += (152 - gg) * k; b += (112 - b) * k; }
        const i = (off + x) << 2;
        px[i] = cl255(r); px[i + 1] = cl255(gg); px[i + 2] = cl255(b); px[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    /* ------------------------------------------------------------ fissures
       The classic random worm pattern: shallow grooves with a lit upper lip.
       Drawn per tile, clipped to the tile, biased along the long axis. */
    for (const T of tiles) {
      g.save();
      g.beginPath();
      g.rect(T.tx * TW + 3, T.ty * TH + 3, TW - 6, TH - 6);
      g.clip();
      const n = T.fis | 0;
      for (let i = 0; i < n; i++) {
        let x = T.tx * TW + R() * TW, y = T.ty * TH + R() * TH;
        let a = (T.dir ? Math.PI / 2 : 0) + (R() - 0.5) * 1.5;
        const segs = 3 + (R() * 7 | 0), step = 4 + R() * 7;
        const pts = [[x, y]];
        for (let k = 0; k < segs; k++) {
          a += (R() - 0.5) * 1.15;
          x += Math.cos(a) * step; y += Math.sin(a) * step;
          pts.push([x, y]);
        }
        const drawn = (dy, style, lw) => {
          g.beginPath(); g.moveTo(pts[0][0], pts[0][1] + dy);
          for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1] + dy);
          g.strokeStyle = style; g.lineWidth = lw; g.lineCap = 'round'; g.stroke();
        };
        const dark = (0.16 + R() * 0.30).toFixed(3);
        drawn(0.9, `rgba(232,228,206,${(0.16 + R() * 0.2).toFixed(3)})`, 1.0);
        drawn(0, `rgba(112,106,84,${dark})`, 0.9 + R() * 1.5);
      }
      /* a few deeper pits */
      for (let i = 0; i < 26; i++) {
        const x = T.tx * TW + R() * TW, y = T.ty * TH + R() * TH;
        g.fillStyle = `rgba(104,98,78,${(0.14 + R() * 0.28).toFixed(3)})`;
        g.beginPath(); g.arc(x, y, 0.7 + R() * 1.8, 0, 6.2832); g.fill();
      }
      g.restore();
    }

    /* ------------------------------------------------------- water damage
       Concentric tide rings: each drying front leaves a boundary that darkens
       gradually then stops dead. Clipped to the tile, because the grid stops
       the water. Some tiles get ruined; their neighbours get an edge stain. */
    const wimg = g.getImageData(0, 0, W, H), wp = wimg.data;
    for (const T of tiles) {
      if (T.wet < 0.06) continue;
      const rad = (28 + T.wet * 150) * (0.8 + T.hue * 0.5);
      const x0 = T.tx * TW + 2, x1 = x0 + TW - 4;
      const y0 = T.ty * TH + 2, y1 = y0 + TH - 4;
      const bx0 = Math.max(x0, Math.floor(T.wx - rad * 1.4)), bx1 = Math.min(x1, Math.ceil(T.wx + rad * 1.4));
      const by0 = Math.max(y0, Math.floor(T.wy - rad * 1.4)), by1 = Math.min(y1, Math.ceil(T.wy + rad * 1.4));
      const strength = 0.35 + T.wet * 0.75;
      for (let y = by0; y < by1; y++) {
        const row = y * W;
        for (let x = bx0; x < bx1; x++) {
          const dx = x - T.wx, dy = (y - T.wy) * 0.86;
          let d = Math.sqrt(dx * dx + dy * dy) / rad;
          d += (fWarp[row + x] - 0.5) * 0.55;
          if (d >= 1.0) continue;
          const ext = 1 - ss(0.93, 1.0, d);
          /* nested tide rings — gradual darkening, hard reset */
          const q = d * T.rings, fr = q - Math.floor(q);
          const ring = fr * fr * fr;
          /* and the centre, where the drip actually landed */
          const centre = (1 - ss(0, 0.34, d)) * 0.5;
          const amt = cl01(ext * strength * (0.22 + 0.55 * ring + centre));
          const i = (row + x) << 2;
          /* ochre body, rust at the ring boundaries */
          const tr = 150 - ring * 46, tg = 116 - ring * 44, tb = 62 - ring * 26;
          wp[i] = cl255(wp[i] + (tr - wp[i]) * amt);
          wp[i + 1] = cl255(wp[i + 1] + (tg - wp[i + 1]) * amt);
          wp[i + 2] = cl255(wp[i + 2] + (tb - wp[i + 2]) * amt);
        }
      }
    }
    g.putImageData(wimg, 0, 0);

    /* --------------------------------------------------------- sag shading
       The tile drops out of the grid, so a shadow opens along its perimeter
       and the middle bellies down away from the light. */
    for (const T of tiles) {
      if (T.sag < 0.05) continue;
      const x0 = T.tx * TW, y0 = T.ty * TH;
      g.save();
      g.beginPath(); g.rect(x0, y0, TW, TH); g.clip();
      const inner = g.createRadialGradient(x0 + TW / 2, y0 + TH / 2, TW * 0.2, x0 + TW / 2, y0 + TH / 2, TH * 0.62);
      inner.addColorStop(0, `rgba(40,36,26,0)`);
      inner.addColorStop(1, `rgba(40,36,26,${(0.34 * T.sag).toFixed(3)})`);
      g.fillStyle = inner; g.fillRect(x0, y0, TW, TH);
      /* the black slot that opens between the tile and the tee */
      g.fillStyle = `rgba(18,16,12,${(0.55 * T.sag).toFixed(3)})`;
      const t = 1 + 3 * T.sag;
      g.fillRect(x0, y0, TW, t); g.fillRect(x0, y0 + TH - t, TW, t);
      g.fillRect(x0, y0, t * 0.6, TH); g.fillRect(x0 + TW - t * 0.6, y0, t * 0.6, TH);
      g.restore();
    }

    /* ------------------------------------------------------------ the grid
       15/16" exposed tee = 24 mm = ~4.7 px. Painted steel, dirty, with a
       highlight on one shoulder and the bulb shadow on the other. */
    const GW = 4.6;
    function tee(x, y, w, h, horiz) {
      g.fillStyle = '#b9b5a2'; g.fillRect(x, y, w, h);
      if (horiz) {
        g.fillStyle = 'rgba(255,255,246,0.42)'; g.fillRect(x, y, w, 1.1);
        g.fillStyle = 'rgba(46,42,32,0.40)'; g.fillRect(x, y + h - 1.2, w, 1.2);
        g.fillStyle = 'rgba(96,90,72,0.20)'; g.fillRect(x, y + h * 0.5 - 0.4, w, 0.8);
      } else {
        g.fillStyle = 'rgba(255,255,246,0.42)'; g.fillRect(x, y, 1.1, h);
        g.fillStyle = 'rgba(46,42,32,0.40)'; g.fillRect(x + w - 1.2, y, 1.2, h);
        g.fillStyle = 'rgba(96,90,72,0.20)'; g.fillRect(x + w * 0.5 - 0.4, y, 0.8, h);
      }
    }
    for (let i = 0; i < TY; i++) tee(0, i * TH - GW / 2, W, GW, true);
    for (let i = 0; i < TX; i++) tee(i * TW - GW / 2, 0, GW, H, false);
    /* wrap the ones that hang off the top/left edge */
    tee(0, H - GW / 2, W, GW, true);
    tee(W - GW / 2, 0, GW, H, false);
    /* grime and rust freckles along the tee, heavier under the leaks */
    for (let i = 0; i < 900; i++) {
      const onH = R() < 0.5;
      const x = onH ? R() * W : ((R() * TX) | 0) * TW - GW / 2 + R() * GW;
      const y = onH ? ((R() * TY) | 0) * TH - GW / 2 + R() * GW : R() * H;
      g.fillStyle = `rgba(${(96 + R() * 60) | 0},${(84 + R() * 50) | 0},${(60 + R() * 40) | 0},${(0.08 + R() * 0.26).toFixed(3)})`;
      g.fillRect(x, y, 0.8 + R() * 2.4, 0.8 + R() * 1.6);
    }
    /* rust bleeding out of the tee where a tile above it is soaked */
    for (const T of tiles) {
      if (T.wet < 0.45) continue;
      const x0 = T.tx * TW, y0 = T.ty * TH;
      g.fillStyle = `rgba(124,86,44,${(0.22 * T.wet).toFixed(3)})`;
      g.fillRect(x0 - GW / 2, y0 - GW / 2, TW + GW, GW);
      g.fillRect(x0 - GW / 2, y0 + TH - GW / 2, TW + GW, GW);
      g.fillRect(x0 - GW / 2, y0 - GW / 2, GW, TH + GW);
      g.fillRect(x0 + TW - GW / 2, y0 - GW / 2, GW, TH + GW);
    }
    return c;
  }

  /* ==========================================================================
     PRISMATIC DIFFUSER — the acrylic pyramid grid over a 2-tube troffer.
     Panel is 1.16 x 0.58 m, so 512x256 = ~440 px/m. Pyramid pitch ~1.8 cm.
     ======================================================================== */
  function makeDiffuser(seed, yellowed) {
    const W = 512, H = 256;
    const R = VB.rngFrom(seed);
    const { c, g } = cv(W, H);
    const tint = yellowed ? [232, 214, 158] : [248, 240, 214];
    const img = g.createImageData(W, H), px = img.data;
    const P = 8;                                   // pyramid pitch, px
    /* the two tubes, running the long way, showing through the acrylic */
    const TUBE = [H * 0.29, H * 0.71], TR = H * 0.20;
    const fD = nf(W >> 1, H >> 1, 6, 3, 3, seed + 7);   // dust film
    for (let y = 0; y < H; y++) {
      const ho = (y >> 1) * (W >> 1), off = y * W;
      /* tube glow */
      let tub = 0;
      for (const t of TUBE) tub = Math.max(tub, 1 - Math.min(1, Math.abs(y - t) / TR));
      tub = tub * tub * (3 - 2 * tub);
      const ly = y % P, cy = ly / P - 0.5;
      for (let x = 0; x < W; x++) {
        const lx = x % P, cx = lx / P - 0.5;
        /* four facets of a pyramid: pick the one this pixel is on, and shade
           it by which way it faces. This is what makes a prismatic panel
           sparkle rather than glow flat. */
        let f;
        if (Math.abs(cx) > Math.abs(cy)) f = cx > 0 ? 1.16 : 0.80;
        else f = cy > 0 ? 0.90 : 1.06;
        /* the valleys between pyramids are dark lines */
        const vx = Math.min(lx, P - lx), vy = Math.min(ly, P - ly);
        const val = Math.min(vx, vy);
        if (val < 0.9) f *= 0.55; else if (val < 1.6) f *= 0.82;
        /* apex catches the tube */
        const apex = 1 - Math.min(1, (Math.abs(cx) + Math.abs(cy)) * 2.2);
        let lum = f * (0.42 + 0.58 * (0.35 + 0.65 * tub)) + apex * tub * 0.30;
        lum *= 1 - (1 - fD[ho + (x >> 1)]) * 0.16;   // dust film
        const i = (off + x) << 2;
        px[i] = cl255(tint[0] * lum);
        px[i + 1] = cl255(tint[1] * lum);
        px[i + 2] = cl255(tint[2] * lum);
        px[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);

    /* dead flies, dust bunnies and one moth, pooled in the bottom of the pan */
    const nf_ = 16 + (R() * 16 | 0);
    for (let i = 0; i < nf_; i++) {
      /* they collect toward the low edge and the corners */
      const x = R() * W;
      const y = R() < 0.62 ? H * (0.72 + R() * 0.26) : R() * H;
      const s = 1.6 + R() * 2.6, a = R() * 3.14;
      g.save(); g.translate(x, y); g.rotate(a);
      g.fillStyle = `rgba(${(38 + R() * 26) | 0},${(32 + R() * 22) | 0},${(22 + R() * 16) | 0},${(0.55 + R() * 0.4).toFixed(2)})`;
      g.beginPath(); g.ellipse(0, 0, s, s * 0.42, 0, 0, 6.2832); g.fill();
      /* wings + legs, which is what makes it read as an insect not a smudge */
      g.strokeStyle = `rgba(58,52,38,${(0.30 + R() * 0.3).toFixed(2)})`;
      g.lineWidth = 0.7;
      for (let k = 0; k < 3; k++) {
        g.beginPath(); g.moveTo(-s * 0.3 + k * s * 0.3, 0);
        g.lineTo(-s * 0.3 + k * s * 0.3 + (R() - 0.5) * s, (R() < 0.5 ? -1 : 1) * s * (0.5 + R() * 0.6));
        g.stroke();
      }
      g.globalAlpha = 0.35;
      g.fillStyle = 'rgba(90,84,66,0.5)';
      g.beginPath(); g.ellipse(s * 0.2, -s * 0.35, s * 0.8, s * 0.3, 0.5, 0, 6.2832); g.fill();
      g.restore();
    }
    /* dust drifts in the pan */
    for (let i = 0; i < 40; i++) {
      const x = R() * W, y = H * (0.55 + R() * 0.45);
      g.fillStyle = `rgba(120,110,84,${(0.05 + R() * 0.12).toFixed(3)})`;
      g.beginPath(); g.ellipse(x, y, 4 + R() * 22, 1.5 + R() * 4, R(), 0, 6.2832); g.fill();
    }
    /* the sheet-metal reveal around the panel */
    g.strokeStyle = 'rgba(58,54,42,0.55)'; g.lineWidth = 3;
    g.strokeRect(1.5, 1.5, W - 3, H - 3);
    g.strokeStyle = 'rgba(255,250,226,0.35)'; g.lineWidth = 1;
    g.strokeRect(3.5, 3.5, W - 7, H - 7);
    return c;
  }

  /* ==========================================================================
     TRIM — grid tee / wall angle, and a painted steel doorframe.
     ======================================================================== */
  function makeTrim(seed) {
    const W = 64, H = 64;
    const R = VB.rngFrom(seed);
    const { c, g } = cv(W, H);
    g.fillStyle = '#b6b2a0'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(${(120 + R() * 70) | 0},${(112 + R() * 60) | 0},${(90 + R() * 50) | 0},${(0.06 + R() * 0.2).toFixed(3)})`;
      g.fillRect(R() * W, R() * H, 0.7 + R() * 2.5, 0.7 + R() * 1.6);
    }
    for (let i = 0; i < 10; i++) {
      g.fillStyle = `rgba(122,84,44,${(0.08 + R() * 0.18).toFixed(3)})`;
      g.beginPath(); g.arc(R() * W, R() * H, 1 + R() * 5, 0, 6.2832); g.fill();
    }
    return c;
  }
  function makeDoorFrame(seed) {
    const W = 128, H = 512;                 // ~0.15 m x 2.1 m of frame
    const R = VB.rngFrom(seed);
    const { c, g } = cv(W, H);
    const img = g.createImageData(W, H), px = img.data;
    const base = [186, 176, 132];
    const fn_ = nf(W, H, 4, 12, 3, seed + 5);
    for (let y = 0; y < H; y++) {
      const off = y * W;
      for (let x = 0; x < W; x++) {
        /* the pressed profile of a steel frame: a soffit, a stop, a return */
        const u = x / W;
        let l = 1;
        if (u < 0.06) l = 0.62; else if (u < 0.12) l = 1.18;
        else if (u < 0.52) l = 1.0 - (u - 0.12) * 0.18;
        else if (u < 0.58) l = 0.70;
        else if (u < 0.64) l = 1.14;
        else l = 0.94 - (u - 0.64) * 0.10;
        l *= 1 + (fn_[off + x] - 0.5) * 0.10;
        l *= 1 - ss(0.9, 1.0, y / H) * 0.35;     // grubby at the bottom
        const i = (off + x) << 2;
        px[i] = cl255(base[0] * l); px[i + 1] = cl255(base[1] * l); px[i + 2] = cl255(base[2] * l); px[i + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    /* chips down to primer, and kick scuffs at the bottom */
    for (let i = 0; i < 70; i++) {
      const y = H * (0.55 + Math.pow(R(), 0.6) * 0.45);
      g.fillStyle = `rgba(${(88 + R() * 40) | 0},${(78 + R() * 34) | 0},${(60 + R() * 30) | 0},${(0.2 + R() * 0.5).toFixed(2)})`;
      g.beginPath(); g.ellipse(R() * W, y, 1 + R() * 4, 0.8 + R() * 2.5, R(), 0, 6.2832); g.fill();
    }
    return c;
  }

  /* ==========================================================================
     PARAMETERS — the per-room variation lives here.
     ======================================================================== */
  const WALLS = [
    /* 0 and 1 are the everyday rooms — these are the two the layout module
       currently asks for. Keep them close to each other but not identical. */
    {
      key: 'wall', seed: 9001, base: [204, 189, 118], trim: [198, 187, 140], skirt: [186, 176, 134],
      stripe: 0.055, tide: 0.46, tideVar: 0.30, dampRough: 0.34, damp: 0.72,
      mould: 0.35, leak: 0.20, leakLen: 1.3, grime: 0.9, scuff: 1.0, peel: 0,
    },
    {
      key: 'wallB', seed: 4242, base: [199, 184, 124], trim: [193, 183, 142], skirt: [180, 172, 132],
      stripe: 0.042, tide: 0.62, tideVar: 0.40, dampRough: 0.42, damp: 0.85,
      mould: 0.55, leak: 0.32, leakLen: 1.7, grime: 1.05, scuff: 1.25, peel: 0,
    },
    /* a drier, cleaner room */
    {
      key: 'wallC', seed: 60613, base: [209, 195, 122], trim: [203, 192, 146], skirt: [190, 181, 138],
      stripe: 0.07, tide: 0.24, tideVar: 0.18, dampRough: 0.24, damp: 0.5,
      mould: 0.12, leak: 0.06, leakLen: 1.0, grime: 0.55, scuff: 0.6, peel: 0,
    },
    /* the room with the real problem */
    {
      key: 'wallDamp', seed: 1717, base: [190, 174, 110], trim: [180, 170, 128], skirt: [166, 158, 118],
      stripe: 0.05, tide: 1.28, tideVar: 0.62, dampRough: 0.58, damp: 1.0,
      mould: 1.0, leak: 0.85, leakLen: 2.3, grime: 1.3, scuff: 1.1, peel: 1,
    },
  ];

  const CARPETS = [
    {
      key: 'carpet', seed: 777,
      yarn: [[84, 76, 44], [112, 103, 58], [146, 136, 80], [172, 162, 104], [128, 122, 86]],
      mean: [126, 118, 74], lane: 1.0, soil: 0.8, stains: 17, burns: 5, drags: 2,
    },
    {
      key: 'carpetB', seed: 5150,
      yarn: [[76, 72, 50], [104, 98, 64], [136, 128, 84], [160, 152, 108], [116, 112, 88]],
      mean: [118, 112, 78], lane: 1.25, soil: 1.15, stains: 24, burns: 8, drags: 3,
    },
  ];

  const CEILINGS = [
    { key: 'ceiling', seed: 31337, base: [206, 199, 172], age: 0.55, leaks: 2 },
    { key: 'ceilingB', seed: 8801, base: [200, 192, 164], age: 0.85, leaks: 3 },
  ];

  const T = {};
  const M = {};
  const V = {};

  return {
    init() {
      const t0 = (performance && performance.now) ? performance.now() : Date.now();

      for (const P of WALLS) T[P.key] = tex(makeWall(P), 0.5, 1);
      for (const P of CARPETS) T[P.key] = tex(makeCarpet(P), 1, 1);
      for (const P of CEILINGS) T[P.key] = tex(makeCeiling(P), 1, 1);
      T.diffuser = tex(makeDiffuser(4801, false), 1, 1);
      T.diffuserB = tex(makeDiffuser(9902, true), 1, 1);
      T.trim = tex(makeTrim(2020), 1, 1);
      T.doorFrame = tex(makeDoorFrame(3030), 1, 1);

      const lam = (map, hex) => new THREE.MeshLambertMaterial({ map, color: hex === undefined ? 0xffffff : hex });

      /* Variant lists. Each entry is a distinct material; several share a
         texture and differ only by a small colour trim, which is free and is
         exactly how two rooms papered from different batches differ. */
      V.wall = [
        lam(T.wall), lam(T.wallB),
        lam(T.wall, 0xf3ead6), lam(T.wallB, 0xe8e2cc),
        lam(T.wallC), lam(T.wallC, 0xefe6cd),
        lam(T.wall, 0xdcd8c6), lam(T.wallB, 0xfaf2dc),
        lam(T.wallDamp), lam(T.wallDamp, 0xe6ddc4),
      ];
      V.carpet = [
        lam(T.carpet), lam(T.carpetB),
        lam(T.carpet, 0xe9e4d2), lam(T.carpetB, 0xf4eeda),
        lam(T.carpet, 0xd8d4c4),
      ];
      V.ceiling = [
        lam(T.ceiling), lam(T.ceilingB),
        lam(T.ceiling, 0xece6d6), lam(T.ceilingB, 0xf6f0e0),
      ];
      V.lightPanel = [
        new THREE.MeshBasicMaterial({ map: T.diffuser, color: 0xfff2cc }),
        new THREE.MeshBasicMaterial({ map: T.diffuserB, color: 0xfff0c4 }),
      ];
      V.pillar = [V.wall[1], V.wall[0], V.wall[3], V.wall[8]];
      V.doorFrame = [lam(T.doorFrame), lam(T.doorFrame, 0xe6e0cc)];
      V.ceilTrim = [lam(T.trim), lam(T.trim, 0xdad6c6)];
      V.wallLower = [V.wall[8], V.wall[1], V.wall[9]];

      M.wall = V.wall[0];
      M.wallB = V.wall[1];
      M.wallC = V.wall[4];
      M.wallDamp = V.wall[8];
      M.wallLower = V.wallLower[0];
      M.carpet = V.carpet[0];
      M.ceiling = V.ceiling[0];
      M.ceilTrim = V.ceilTrim[0];
      M.lightPanel = V.lightPanel[0];
      M.doorFrame = V.doorFrame[0];
      M.pillar = V.pillar[0];
      M.baseboard = V.ceilTrim[0];      // legacy name; walls carry their own skirting

      VB.mats = M;
      M.tex = T;
      M.variants = V;
      /* Stable per-room variant. n may be any integer; the mapping never
         changes for a given (kind, n), so a room keeps its identity. */
      M.variant = function (kind, n) {
        const a = V[kind];
        if (!a) return M[kind] || M.wall;
        const i = ((n | 0) % a.length + a.length) % a.length;
        return a[i];
      };
      M.variantCount = kind => (V[kind] ? V[kind].length : 0);

      genMs = ((performance && performance.now) ? performance.now() : Date.now()) - t0;
      M.genMs = Math.round(genMs);
      M.genMB = +(genBytes / 1048576).toFixed(1);
    },
  };
}, 5);
