/* ============================================================================
   MATERIALS — every surface generated into a <canvas> at boot. No image files.

   The mono-yellow is the whole point, so it can never be flat: vertical
   printing stripes, a chair rail, damp rising from the skirting, scuffs.
   ========================================================================== */
VB.def('materials', function (VB, THREE) {

  function cv(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
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
  /* seeded noise splat helper */
  function grain(g, w, h, n, alpha, size, hue) {
    for (let i = 0; i < n; i++) {
      const x = Math.random() * w, y = Math.random() * h;
      g.fillStyle = hue ? hue(Math.random()) : `rgba(0,0,0,${(Math.random() * alpha).toFixed(3)})`;
      g.fillRect(x, y, Math.random() * size + 0.5, Math.random() * size + 0.5);
    }
  }

  /* ------------------------------------------------------------ wallpaper */
  function makeWall(seed) {
    const R = VB.rngFrom(seed);
    const W = 512, H = 512;
    const { c, g } = cv(W, H);
    /* base — sickly institutional yellow, slightly green in the shadows */
    g.fillStyle = '#c9b96a'; g.fillRect(0, 0, W, H);

    /* vertical print striping, uneven period */
    for (let x = 0; x < W; x += 2) {
      const v = 0.5 + 0.5 * Math.sin(x * 0.42 + Math.sin(x * 0.031) * 2.2);
      const a = 0.030 + v * 0.055;
      g.fillStyle = `rgba(150,132,64,${a.toFixed(3)})`;
      g.fillRect(x, 0, 2, H);
    }
    /* faint horizontal weave of the vinyl */
    for (let y = 0; y < H; y += 3) {
      g.fillStyle = `rgba(255,246,190,${(0.02 + Math.random() * 0.03).toFixed(3)})`;
      g.fillRect(0, y, W, 1);
    }
    /* mottled damp — low frequency blobs */
    for (let i = 0; i < 26; i++) {
      const x = R() * W, y = R() * H, r = 30 + R() * 130;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const dark = R() < 0.5;
      gr.addColorStop(0, dark ? 'rgba(96,84,42,0.20)' : 'rgba(226,214,150,0.16)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    /* damp rising from the floor — bottom of texture is bottom of wall */
    const rise = g.createLinearGradient(0, H, 0, H * 0.52);
    rise.addColorStop(0, 'rgba(74,62,30,0.46)');
    rise.addColorStop(0.45, 'rgba(88,76,38,0.17)');
    rise.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rise; g.fillRect(0, 0, W, H);
    /* a scalloped tide line where the damp stopped */
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 8) g.lineTo(x, H * (0.70 + 0.055 * Math.sin(x * 0.021 + seed) + 0.03 * Math.sin(x * 0.07)));
    g.lineTo(W, H); g.closePath();
    g.fillStyle = 'rgba(70,58,26,0.15)'; g.fill();

    /* chair rail / batten — the horizontal that makes it read as an office */
    const railY = H * 0.63;
    g.fillStyle = 'rgba(60,50,22,0.30)'; g.fillRect(0, railY - 1, W, 2);
    g.fillStyle = 'rgba(232,222,164,0.30)'; g.fillRect(0, railY + 1, W, 2);

    /* scuffs and knocks along the traffic height */
    for (let i = 0; i < 90; i++) {
      const x = R() * W, y = H * (0.62 + R() * 0.36), len = 4 + R() * 34;
      g.strokeStyle = `rgba(58,48,20,${(0.05 + R() * 0.16).toFixed(3)})`;
      g.lineWidth = 0.6 + R() * 1.5;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + len * (R() - 0.2), y + (R() - 0.5) * 3); g.stroke();
    }
    grain(g, W, H, 5200, 0.055, 2.0);
    grain(g, W, H, 1400, 0.05, 1.6, () => `rgba(255,248,205,${(Math.random() * 0.06).toFixed(3)})`);
    return c;
  }

  /* --------------------------------------------------------------- carpet */
  function makeCarpet(seed) {
    const R = VB.rngFrom(seed);
    const W = 512, H = 512;
    const { c, g } = cv(W, H);
    g.fillStyle = '#a8994f'; g.fillRect(0, 0, W, H);
    /* commercial loop pile — short dashes in two directions */
    for (let i = 0; i < 26000; i++) {
      const x = R() * W, y = R() * H;
      const v = R();
      g.strokeStyle = v < 0.5
        ? `rgba(${(96 + R() * 30) | 0},${(86 + R() * 28) | 0},${(38 + R() * 18) | 0},0.55)`
        : `rgba(${(180 + R() * 44) | 0},${(168 + R() * 40) | 0},${(96 + R() * 30) | 0},0.35)`;
      g.lineWidth = 0.9;
      const a = R() < 0.5 ? 0 : Math.PI / 2;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * 2.2, y + Math.sin(a) * 2.2); g.stroke();
    }
    /* the stains — this is what sells it */
    for (let i = 0; i < 20; i++) {
      const x = R() * W, y = R() * H, r = 16 + R() * 95;
      const gr = g.createRadialGradient(x, y, r * 0.15, x, y, r);
      gr.addColorStop(0, `rgba(${(58 + R() * 26) | 0},${(46 + R() * 22) | 0},${(20 + R() * 14) | 0},${(0.24 + R() * 0.3).toFixed(2)})`);
      gr.addColorStop(0.72, 'rgba(70,58,26,0.11)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      /* irregular blob rather than a circle */
      g.beginPath();
      for (let a = 0; a <= 6.5; a += 0.35) {
        const rr = r * (0.62 + 0.38 * VB.vnoise1(a * 1.7 + i * 13, seed + i));
        const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr * 0.82;
        a === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
      }
      g.closePath(); g.fill();
    }
    /* traffic wear lanes */
    for (let i = 0; i < 6; i++) {
      const y = R() * H;
      g.fillStyle = `rgba(140,130,74,${(0.04 + R() * 0.06).toFixed(3)})`;
      g.fillRect(0, y, W, 20 + R() * 60);
    }
    grain(g, W, H, 7000, 0.07, 2.2);
    return c;
  }

  /* ------------------------------------------------------------ ceiling tile */
  function makeCeiling(seed) {
    const R = VB.rngFrom(seed);
    const W = 512, H = 512;               // one texel block = a 2x2 tile group
    const { c, g } = cv(W, H);
    g.fillStyle = '#cdc4a4'; g.fillRect(0, 0, W, H);
    /* fissured mineral fibre — the classic random worm pattern */
    for (let i = 0; i < 2600; i++) {
      const x = R() * W, y = R() * H;
      g.strokeStyle = `rgba(120,112,88,${(0.10 + R() * 0.30).toFixed(3)})`;
      g.lineWidth = 0.7 + R() * 1.7;
      g.beginPath(); g.moveTo(x, y);
      let px = x, py = y, a = R() * 7;
      for (let k = 0; k < 5; k++) { a += (R() - 0.5) * 1.5; px += Math.cos(a) * 4; py += Math.sin(a) * 4; g.lineTo(px, py); }
      g.stroke();
    }
    for (let i = 0; i < 1800; i++) {
      const x = R() * W, y = R() * H, r = 0.6 + R() * 2.1;
      g.fillStyle = `rgba(108,100,78,${(0.12 + R() * 0.3).toFixed(3)})`;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    /* the T-grid, drawn into the texture edges (2 tiles across) */
    const grid = () => {
      g.fillStyle = '#8e8974';
      g.fillRect(0, 0, W, 5); g.fillRect(0, H - 5, W, 5);
      g.fillRect(0, 0, 5, H); g.fillRect(W - 5, 0, 5, H);
      g.fillRect(0, H / 2 - 2.5, W, 5); g.fillRect(W / 2 - 2.5, 0, 5, H);
      g.fillStyle = 'rgba(255,255,255,0.16)';
      g.fillRect(0, 1, W, 1); g.fillRect(0, H / 2 - 1.5, W, 1);
      g.fillStyle = 'rgba(0,0,0,0.28)';
      g.fillRect(0, 4, W, 1); g.fillRect(0, H / 2 + 1.5, W, 1);
    };
    /* water damage — brown tide rings, concentric, the tell of a wet ceiling */
    for (let i = 0; i < 5; i++) {
      const x = R() * W, y = R() * H, r = 25 + R() * 110;
      for (let ring = 3; ring >= 0; ring--) {
        const rr = r * (0.45 + ring * 0.19);
        const gr = g.createRadialGradient(x, y, rr * 0.7, x, y, rr);
        gr.addColorStop(0, 'rgba(0,0,0,0)');
        gr.addColorStop(0.82, `rgba(${(126 + ring * 8) | 0},${(88 + ring * 8) | 0},44,${(0.10 + ring * 0.045).toFixed(3)})`);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        g.beginPath();
        for (let a = 0; a <= 6.6; a += 0.3) {
          const q = rr * (0.72 + 0.3 * VB.vnoise1(a * 2.1 + i * 7 + ring, seed));
          const px = x + Math.cos(a) * q, py = y + Math.sin(a) * q;
          a === 0 ? g.moveTo(px, py) : g.lineTo(px, py);
        }
        g.closePath(); g.fill();
      }
    }
    grid();
    grain(g, W, H, 3000, 0.05, 1.8);
    return c;
  }

  /* -------------------------------------------------------- light diffuser */
  function makeDiffuser() {
    const W = 256, H = 128;
    const { c, g } = cv(W, H);
    g.fillStyle = '#fff6d8'; g.fillRect(0, 0, W, H);
    /* prismatic acrylic — a grid of little pyramids */
    for (let y = 0; y < H; y += 8) {
      for (let x = 0; x < W; x += 8) {
        g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(x, y, 7, 7);
        g.fillStyle = 'rgba(196,186,150,0.55)'; g.fillRect(x + 6, y, 2, 8);
        g.fillStyle = 'rgba(210,200,164,0.45)'; g.fillRect(x, y + 6, 8, 2);
      }
    }
    /* dead flies and dust in the bottom of the diffuser */
    for (let i = 0; i < 26; i++) {
      g.fillStyle = `rgba(50,42,26,${(0.25 + Math.random() * 0.5).toFixed(2)})`;
      const x = Math.random() * W, y = Math.random() * H;
      g.beginPath(); g.ellipse(x, y, 1.2 + Math.random() * 2.4, 0.8 + Math.random() * 1.2, Math.random() * 3, 0, 7); g.fill();
    }
    /* the two tubes showing through */
    for (const ty of [H * 0.3, H * 0.7]) {
      const gr = g.createLinearGradient(0, ty - 14, 0, ty + 14);
      gr.addColorStop(0, 'rgba(255,255,255,0)');
      gr.addColorStop(0.5, 'rgba(255,255,255,0.75)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, ty - 14, W, 28);
    }
    return c;
  }

  const T = {};
  const M = {};

  return {
    init() {
      T.wall = tex(makeWall(9001), 1, 1);
      T.wallB = tex(makeWall(4242), 1, 1);
      T.carpet = tex(makeCarpet(777), 1, 1);
      T.ceiling = tex(makeCeiling(31337), 1, 1);
      T.diffuser = tex(makeDiffuser(), 1, 1);

      M.wall = new THREE.MeshLambertMaterial({ map: T.wall, color: 0xffffff });
      M.wallB = new THREE.MeshLambertMaterial({ map: T.wallB, color: 0xf6f2e2 });
      M.carpet = new THREE.MeshLambertMaterial({ map: T.carpet, color: 0xffffff });
      M.ceiling = new THREE.MeshLambertMaterial({ map: T.ceiling, color: 0xffffff });
      M.lightPanel = new THREE.MeshBasicMaterial({ map: T.diffuser, color: 0xfff2cc });
      M.baseboard = new THREE.MeshLambertMaterial({ color: 0x8f8348 });
      M.pillar = M.wall;
      M.doorFrame = new THREE.MeshLambertMaterial({ color: 0xb5a86a });

      VB.mats = M;
      VB.mats.tex = T;
      VB.mats.variant = (kind, n) => (n & 1 ? (M[kind + 'B'] || M[kind]) : M[kind]);
    },
  };
}, 5);
