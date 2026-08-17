/* ============================================================================
   CORE — registry, deterministic RNG, shared state, event bus, config.
   Everything else in the build registers into VB. Do not edit outside of
   coordination; module authors only add files under src/.
   ========================================================================== */

const VB = {
  THREE,
  _factories: [],
  mods: {},
  /* Register a module. factory(VB, THREE) -> instance object.
     Optional instance lifecycle: init(), update(dt), lateUpdate(dt), resize(w,h) */
  def(name, factory, order = 50) {
    VB._factories.push({ name, factory, order });
  },
};

/* ---------------------------------------------------------------- config */
VB.cfg = {
  /* 4:3 is non-negotiable — widescreen instantly reads as "modern game" */
  aspect: 4 / 3,
  /* CCD / optics stage resolution (the "camera" before it hits tape) */
  sceneW: 640,
  sceneH: 480,
  /* Simulated tape luma bandwidth. VHS ~240 visible lines, ~333 luma samples
     per active line; chroma is ~1/8 of that. postfx enforces this. */
  tapeW: 640,
  tapeH: 480,
  /* NTSC 29.97 — silky 60fps is the single loudest "this is a game" tell */
  fps: 29.97,
  fov: 62,            // ~ consumer camcorder at wide end
  eyeHeight: 1.62,
  walkSpeed: 2.35,
  runSpeed: 4.05,
  playerRadius: 0.34,
};

/* ------------------------------------------------------------------- rng */
/* mulberry32 — fast, decent, deterministic */
VB.rngFrom = function (seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
/* Stable spatial hash -> uint32. Same cell always yields the same world. */
VB.hash2 = function (x, y, salt = 0) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (salt | 0) * 2147483647;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};
VB.hashf = function (x, y, salt = 0) { return VB.hash2(x, y, salt) / 4294967296; };

/* ----------------------------------------------------------------- state */
/* Written by owning modules, read by everyone. Ranges are contractual. */
VB.S = {
  t: 0,             // elapsed game seconds since boot
  dt: 0,            // frame delta (clamped)
  frame: 0,
  seed: (Math.random() * 0xffffffff) >>> 0,

  /* --- driven by player module --- */
  pos: null,        // THREE.Vector3, set at boot
  yaw: 0, pitch: 0,
  turn: 0,          // 0..1 smoothed normalised angular speed
  move: 0,          // 0..1 normalised translation speed
  running: 0,       // 0..1
  bobPhase: 0,

  /* --- driven by layout --- */
  cell: null,       // {cx,cz} current chunk-cell
  roomPulse: 0,     // 0..1 spikes on room entry, decays. drives tracking tear
  anomaly: 0,       // 0..1 how "wrong" the current space is

  /* --- driven by entity --- */
  prox: 0,          // 0..1 entity proximity influence
  seen: 0,          // 0..1 how directly the entity is in frame
  stalked: 0,       // 0..1 slow-building "being followed"

  /* --- driven by director (in boot) --- */
  dread: 0,         // 0..1 overall tension
  wear: 0,          // 0..1 cumulative tape degradation (monotonic, slow)
  burst: 0,         // 0..1 static burst, event-driven, decays fast
  dropout: 0,       // 0..1 momentary signal loss
};

/* ------------------------------------------------------------------- bus */
VB._subs = Object.create(null);
VB.on = function (evt, fn) {
  (VB._subs[evt] || (VB._subs[evt] = [])).push(fn);
  return () => { const a = VB._subs[evt]; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
};
VB.emit = function (evt, payload) {
  const a = VB._subs[evt];
  if (!a) return;
  for (let i = 0; i < a.length; i++) { try { a[i](payload); } catch (e) { console.error('[bus]', evt, e); } }
};

/* ----------------------------------------------------------------- utils */
VB.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
VB.lerp = (a, b, t) => a + (b - a) * t;
VB.smoothstep = (e0, e1, x) => { const t = VB.clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
/* frame-rate independent exponential approach */
VB.approach = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/* Value noise, 1D — used all over for flicker / wow / drift */
VB.vnoise1 = function (x, salt = 0) {
  const i = Math.floor(x), f = x - i;
  const a = VB.hashf(i, 0, salt), b = VB.hashf(i + 1, 0, salt);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
};
/* fBm of the above */
VB.fbm1 = function (x, oct = 4, salt = 0) {
  let s = 0, amp = 0.5, fr = 1;
  for (let i = 0; i < oct; i++) { s += amp * VB.vnoise1(x * fr, salt + i * 17); fr *= 2.03; amp *= 0.5; }
  return s;
};
