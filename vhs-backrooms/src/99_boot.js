/* ============================================================================
   BOOT — renderer, module instantiation, the director, and the 59.94Hz field
   clock. Presents at 29.97fps by weaving two temporally-distinct fields.
   ========================================================================== */
(function boot() {
  const S = VB.S, cfg = VB.cfg;

  /* ------------------------------------------------------------ renderer */
  const canvas = document.getElementById('screen');
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, alpha: false, powerPreference: 'high-performance',
    stencil: false, depth: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(cfg.sceneW, cfg.sceneH, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 1);
  VB.renderer = renderer;
  VB.canvas = canvas;

  const scene = new THREE.Scene();
  VB.scene = scene;
  const camera = new THREE.PerspectiveCamera(cfg.fov, cfg.aspect, 0.02, 60);
  VB.camera = camera;
  S.pos = new THREE.Vector3(0, cfg.eyeHeight, 0);

  /* ------------------------------------------------- module instantiation */
  VB._factories.sort((a, b) => a.order - b.order);
  for (const f of VB._factories) {
    try {
      VB.mods[f.name] = f.factory(VB, THREE) || {};
    } catch (e) {
      console.error('[module ' + f.name + ' construct]', e);
      VB.mods[f.name] = {};
    }
  }
  const list = VB._factories.map(f => VB.mods[f.name]);
  const call = (fn, ...a) => {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m && typeof m[fn] === 'function') {
        try { m[fn](...a); } catch (e) { console.error('[' + VB._factories[i].name + '.' + fn + ']', e); }
      }
    }
  };
  call('init');

  /* -------------------------------------------------------------- layout */
  function layoutScreen() {
    const W = window.innerWidth, H = window.innerHeight;
    /* Pillarbox / letterbox to a hard 4:3 window. */
    let w = W, h = W / cfg.aspect;
    if (h > H) { h = H; w = H * cfg.aspect; }
    canvas.style.width = Math.round(w) + 'px';
    canvas.style.height = Math.round(h) + 'px';
    canvas.style.left = Math.round((W - w) / 2) + 'px';
    canvas.style.top = Math.round((H - h) / 2) + 'px';
    call('resize', cfg.sceneW, cfg.sceneH);
  }
  window.addEventListener('resize', layoutScreen);
  layoutScreen();

  /* ------------------------------------------------------------ director */
  /* Owns S.dread / S.wear / S.burst / S.dropout — the slow build of the tape
     falling apart and the room getting less friendly. */
  let nextBurst = 6 + Math.random() * 14;
  let nextDrop = 3 + Math.random() * 9;
  const director = {
    update(dt) {
      /* Tape wear: monotonic, asymptotic. Reaches ~0.5 at 6 min, ~0.8 at 20. */
      S.wear = 1 - Math.exp(-S.t / 520) * (1 - 0.02);
      S.wear = VB.clamp(S.wear + S.prox * 0.10, 0, 1);

      /* Dread: slow base ramp, pushed hard by entity proximity/sighting. */
      const base = VB.smoothstep(0, 300, S.t) * 0.55;
      const target = VB.clamp(base + S.prox * 0.55 + S.seen * 0.35 + S.stalked * 0.25, 0, 1);
      S.dread = VB.approach(S.dread, target, target > S.dread ? 1.6 : 0.22, dt);

      /* Static bursts — more frequent as the tape wears and dread climbs. */
      nextBurst -= dt * (0.55 + S.wear * 1.9 + S.dread * 1.3);
      if (nextBurst <= 0) {
        nextBurst = 5 + Math.random() * 16;
        VB.emit('glitch:burst', { amt: 0.35 + Math.random() * 0.65 * (0.4 + S.wear) });
      }
      S.burst = Math.max(0, S.burst - dt * 3.4);

      /* Dropouts — the short white/black streaks of shed oxide. */
      nextDrop -= dt * (0.7 + S.wear * 3.2);
      if (nextDrop <= 0) { nextDrop = 1.6 + Math.random() * 7; S.dropout = 0.4 + Math.random() * 0.6; }
      S.dropout = Math.max(0, S.dropout - dt * 5.5);

      S.roomPulse = Math.max(0, S.roomPulse - dt * 1.25);
    },
  };
  VB.on('glitch:burst', e => { S.burst = Math.max(S.burst, e && e.amt != null ? e.amt : 0.6); });
  VB.on('room:enter', () => { S.roomPulse = Math.min(1, S.roomPulse + 0.75); });

  /* ----------------------------------------------------------- the clock */
  const FIELD_DT = 1 / 59.94;
  const MAX_STEPS = 3;
  let acc = 0, last = performance.now() / 1000;
  let field = 0;                 // 0 = upper field, 1 = lower field
  VB.field = 0;
  VB.running = false;
  VB.deterministic = false;      // harness sets true for reproducible frames

  function stepSim(dt) {
    S.dt = dt; S.t += dt; S.frame++;
    director.update(dt);
    call('update', dt);
    call('lateUpdate', dt);
  }

  /* Renders the scene into postfx's CCD buffer for the current field, then —
     on the lower field — weaves + presents the finished frame. */
  function renderField() {
    VB.field = field;
    const px = VB.mods.postfx;
    if (px && px.renderField) px.renderField(scene, camera, field);
    else renderer.render(scene, camera);
    if (field === 1 && px && px.present) px.present();
    field ^= 1;
  }

  function frame(nowMs) {
    if (!VB.deterministic) {
      const now = nowMs / 1000;
      let wall = now - last; last = now;
      if (wall > 0.25) wall = 0.25;
      acc += wall;
      let steps = 0;
      while (acc >= FIELD_DT && steps < MAX_STEPS) {
        acc -= FIELD_DT; steps++;
        if (VB.running) stepSim(FIELD_DT);
        renderField();
      }
      if (steps === 0 && VB.mods.postfx && VB.mods.postfx.repaint) VB.mods.postfx.repaint();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ------------------------------------------------------------ start-up */
  /* Audio + pointer lock both require a gesture. The "press play" plate is
     itself diegetic: a paused VCR. */
  function start() {
    if (VB.running) return;
    VB.running = true;
    call('start');
    VB.emit('game:start');
  }
  VB.start = start;

  /* -------------------------------------------------------- harness hook */
  window.__VB = {
    VB, S, cfg,
    ready: true,
    /* Advance exactly n fields of fixed dt with the wall clock ignored, so a
       screenshot at step N is bit-identical run to run (given a fixed seed). */
    step(n = 1) {
      VB.deterministic = true;
      if (!VB.running) { VB.running = true; call('start'); VB.emit('game:start'); }
      for (let i = 0; i < n; i++) { stepSim(FIELD_DT); renderField(); }
    },
    /* Jump the clock without rendering — lets a critic see minute-20 tape wear
       without waiting for 70000 software-rasterised fields. */
    warp(seconds) {
      S.t += seconds;
      director.update(1 / 60);
      for (let i = 0; i < 30; i++) director.update(0.2);
    },
    seed(v) { S.seed = v >>> 0; VB.emit('world:reseed', v >>> 0); },
    set(k, v) { S[k] = v; },
    teleport(x, z, yaw) {
      S.pos.set(x, cfg.eyeHeight, z);
      if (yaw != null) S.yaw = yaw;
      VB.emit('player:teleport');
    },
    modules() { return VB._factories.map(f => f.name); },
  };
  window.VB = VB;
  console.log('[vb] booted modules:', VB._factories.map(f => f.name).join(', '));
})();
