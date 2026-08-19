/* ============================================================================
   LIGHTING — the fluorescent grid of a building that goes on forever.

   The Backrooms look is BRIGHT, FLAT and SHADOWLESS. Dread is not darkness; it
   is being able to see perfectly well in every direction and there being
   nothing there. So: a strong pool directly under every troffer, a high
   bounced-yellow fill so nothing is ever actually dark, and pale haze instead
   of a black fade.

   Four things live here:

     1. EXPOSURE      physical-unit calibration of the troffer + fake-GI fill.
     2. FLICKER       per-fixture lamp behaviour, including the 120 Hz mains
                      ripple aliased against the 59.94 Hz field clock.
     3. POOL          a fixed-size SpotLight pool bound to the nearest fixtures.
     4. QUERIES       buzzAt / brightnessAt for the audio module, off a spatial
                      hash so they are O(neighbours) not O(all fixtures).

   No persistent per-fixture state is kept anywhere. Everything a fixture does
   is a pure function of (its grid coordinate, S.t, S.prox). That is the whole
   fix for the old Map-keyed-by-fixture leak: there is no table to prune,
   because there is no table. `f.level` (a field layout already declares) is
   the only thing written back, and it dies with the fixture.
   ========================================================================== */
VB.def('lighting', function (VB, THREE) {
  const S = VB.S;
  const TAU = Math.PI * 2;
  const frac = (x) => x - Math.floor(x);
  const sinc = (x) => (Math.abs(x) < 1e-7 ? 1 : Math.sin(x) / x);

  /* ==========================================================================
     1. EXPOSURE
     --------------------------------------------------------------------------
     three r160 is physically-unit: PointLight/SpotLight intensity is candela
     and decay 2 means irradiance = I / d². MeshLambertMaterial then outputs
     linear radiance = albedo/π · N·L · I/d². The scene lands in an sRGB-encoded
     8-bit buffer, so "what you tune is what the tape gets", and anything over
     1.0 linear is clipped to white before postfx ever sees it.

     Calibrating on the floor pool, which is the shot's anchor:
       fixture height above carpet  h = 2.62 m   →  1/h² = 0.1456
       carpet #a8994f, red channel  albedo_lin = 0.392  →  albedo/π = 0.1248
       radiance_R at nadir = 0.1248 · 0.1456 · CD = 0.01817 · CD
     CD = 30 puts the pool centre at 0.545 linear ≈ 0.77 sRGB before fill;
     with fill it lands ~0.87 sRGB. Halfway between two fixtures (3.9 m, the
     grid is 3 cells = 7.8 m) the same maths gives 0.12 linear ≈ 0.39 sRGB, so
     the corridor reads as a rhythm of pools at roughly 4.5:1 in linear light.
     That ratio is the whole point — a flat wash has no rhythm and no depth.

     A troffer is a recessed Lambertian emitter: it radiates I₀·cosθ downward
     and NOTHING upward. A bare PointLight 100 mm below a ceiling plane blasts
     that ceiling with 1/0.1² and produces a hard white halo on the tiles, which
     is exactly wrong. A SpotLight with angle = π/2 and penumbra = 1 evaluates
     smoothstep(0, 1, cosθ) — within a few percent of cosθ over the useful
     range, zero above the fixture plane. Same per-fragment cost bracket as a
     point light, physically the right distribution, no ceiling halo.
     ====================================================================== */
  const CD = 30.0;            // candela, one healthy troffer at 100%
  const LIGHT_R = 16.0;       // cutoff distance; three windows it as (1-(d/R)⁴)²

  /* Fake GI. The room is a yellow box with a lot of interreflection, so the
     fill is the difference between "office" and "dark horror game". Ambient is
     the flat term; the hemisphere biases it by surface orientation — up-facing
     surfaces see the bright ceiling, down-facing surfaces see the duller
     carpet, which is why the ceiling tiles read slightly darker than the walls
     even though they are closest to the lamps. */
  const AMB_COL = 0xf3e3b4, AMB_I = 1.02;
  const HEMI_SKY = 0xfff0c8, HEMI_GND = 0xa89a58, HEMI_I = 0.80;

  /* Lamp chromaticities, LINEAR rgb, normalised to R = 1. Color.setRGB() writes
     the working colour space (linear-sRGB) directly, so these are used as-is. */
  const LAMP = [1.00, 0.935, 0.735];   // ~4100 K halophosphate, a touch green
  const AMBERR = [1.00, 0.560, 0.205];  // voltage sag / browning out
  const PINKK = [1.00, 0.520, 0.610];  // end-of-life mercury pink

  /* Diffuser panels. They are MeshBasicMaterial, so this is literal emission.
     Slight overdrive so the centre of every panel clips to white and blows the
     display stage's 0.62 bloom threshold — they must be the brightest thing in
     frame — while the edges stay under 1.0 so the ripple is still visible. */
  const PANEL_GAIN = 1.16;
  const PANEL_WHITEN = 0.45;           // pull the panel toward white vs lamp hue
  const PANEL_DEAD = [0.085, 0.083, 0.064];

  /* ==========================================================================
     2. FLICKER — the 120 Hz ripple, aliased by the field clock
     --------------------------------------------------------------------------
     A fluorescent on 60 Hz mains puts out light at 120 Hz. The camcorder
     samples it once per field at 59.94 Hz, and 120 / 59.94 = 2.002002…, so the
     sampled phase creeps by 0.002002 cycle per field: one full beat every
     499.5 fields = 8.333 s. That slow crawl is the single strongest "this was
     shot on video, not rendered" cue there is. The 240 Hz harmonic aliases the
     same way to 0.24 Hz (4.167 s), giving a second, faster crawl underneath.

     Because S.t only ever advances in exact 1/59.94 steps, sampling sin(2π·120t)
     at S.t IS the aliasing — no separate beat oscillator is needed or wanted.

     The shutter matters. A CCD integrating for τ box-filters the waveform, which
     scales a component at f by sinc(π f τ). At τ = 1/60 the 120 Hz term
     integrates to exactly zero and there is no crawl at all — which is why the
     effect is a shutter artefact, not a lamp artefact. A 1987 camcorder under
     office fluorescents sits around 1/350 with its auto electronic shutter:
       sinc(π·120/350) = 0.818   sinc(π·240/350) = 0.387
     Raw lamp modulation for an old halophosphate tube is ~31 % pk-pk at 120 Hz
     and ~12 % at 240 Hz, so what survives to tape is ±12.7 % and ±2.3 %.
     ====================================================================== */
  const FIELD_HZ = 59.94;
  const SHUTTER = 1 / 350;
  const A120 = 0.155 * sinc(Math.PI * 120 * SHUTTER);
  const A240 = 0.060 * sinc(Math.PI * 240 * SHUTTER);

  /* A real panel feeds three circuits off a three-phase board, so fixtures come
     in three ripple phases that cluster spatially (adjacent fixtures usually
     share a circuit). At 120 Hz a 120° mains offset is 240°, i.e. 2/3 cycle. */
  const rip = [0, 0, 0];    // per-circuit ripple, this field
  const ripL = [0, 0, 0];   // lead-lag ballast: second lamp, quarter cycle early

  function precomputeRipple(t, gain) {
    for (let c = 0; c < 3; c++) {
      const p1 = c * (2 / 3), p2 = c * (1 / 3);
      const a = A120 * Math.sin(TAU * frac(120 * t + p1));
      const b = A240 * Math.sin(TAU * frac(240 * t + p2));
      rip[c] = (a + b) * gain;
      ripL[c] = (A120 * Math.sin(TAU * frac(120 * t + p1 + 0.25))
        + A240 * Math.sin(TAU * frac(240 * t + p2 + 0.25))) * gain;
    }
  }

  /* Behaviours. Distribution is deliberate: dying tubes have to be uncommon
     enough that finding one is an event. Layout independently kills ~10 % of
     fixtures outright (f.on === false), so the census across a floor is roughly
     68 % steady, 9 % beating, 5 % starter-cycling, 5 % pink, 4 % dying, 10 % dead. */
  const M_STEADY = 0, M_BEAT = 1, M_STARTER = 2, M_PINK = 3, M_DYING = 4, M_DEAD = 5;

  /* eval outputs — module scope so evalFixture allocates nothing */
  let _lvl = 0, _warm = 0, _pink = 0, _unstable = 0;

  function modeOf(f, h) {
    if (!f.on) return M_DEAD;
    if (h < 0.045) return M_DYING;
    if (h < 0.100) return M_PINK;
    if (h < 0.155) return M_STARTER;
    if (h < 0.245) return M_BEAT;
    return M_STEADY;
  }

  function evalFixture(ix, iz, mode, c, ph, h2, t) {
    _warm = 0; _pink = 0; _unstable = 0;
    switch (mode) {
      case M_DEAD:
        _lvl = 0;
        return;

      case M_STEADY:
        /* Not perfectly constant: tubes wander a percent or two over seconds as
           the ballast warms and the mains sags. */
        _lvl = (1 + rip[c]) * (0.972 + 0.028 * VB.vnoise1(t * 0.11 + ph * 37, 331));
        return;

      case M_BEAT: {
        /* Two lamps in one housing, one of them tired. Its output swings under
           a second, and because it sits on the lag leg of the ballast its
           ripple is a quarter cycle off — so the fixture's ripple beats against
           itself as well as swinging in level. */
        const fb = 0.28 + h2 * 0.85;
        const w = 0.60 + 0.40 * Math.sin(TAU * frac(fb * t + ph));
        _lvl = 0.5 * ((1 + rip[c]) + w * (1 + ripL[c]));
        _unstable = 0.35;
        return;
      }

      case M_STARTER: {
        /* The glow-bottle cycle: runs a while, drops out, clunks through a few
           strike attempts, warms back up. Everyone has heard this fixture. */
        const per = 5.5 + h2 * 7.0;
        const u = frac(t / per + ph);
        if (u < 0.46) { _lvl = 1 + rip[c]; }
        else if (u < 0.60) { _lvl = 0.015; _pink = 0.7; }        // cathode glow only
        else if (u < 0.80) {                                      // striking
          const k = frac((u - 0.60) * per * 2.4);
          _lvl = k < 0.34 ? 1.22 : 0.03;
          _pink = 0.45;
        } else {                                                  // warming up
          const w = (u - 0.80) / 0.20;
          _lvl = (0.34 + 0.66 * w) * (1 + rip[c] * (2.2 - 1.8 * w));
          _pink = 0.34 * (1 - w);
        }
        _unstable = 0.8;
        return;
      }

      case M_PINK: {
        /* End of life: mercury depleted, running dim and pink, one end of the
           tube dark. Swells and nearly drops out every few seconds. */
        const sw = 0.5 + 0.5 * Math.sin(TAU * frac(0.31 * t + ph));
        _lvl = (0.34 + 0.26 * sw) * (1 + rip[c] * 3.0);
        if (VB.vnoise1(t * 0.8 + ph * 13, 617) > 0.86) _lvl *= 0.20;
        _pink = 0.9; _warm = 0.25; _unstable = 0.9;
        return;
      }

      case M_DYING: {
        /* The bad one. A slow envelope decides whether it is limping along or
           in a strike-fail loop; in the loop it strobes at 7–16 Hz with per-field
           jitter, which on a 29.97 fps interlaced frame reads as a hard stutter. */
        const n = VB.fbm1(t * 1.9 + ph * 41, 3, 77);
        if (n < 0.40) {
          const s = frac(t * (7.0 + h2 * 9.0));
          const j = VB.hashf((t * FIELD_HZ) | 0, ix * 31 + iz, 991);
          _lvl = s < 0.30 ? 0.95 + 0.30 * j : 0.02 + 0.05 * j;
        } else {
          _lvl = (0.50 + 0.50 * VB.smoothstep(0.40, 0.64, n)) * (1 + rip[c] * 2.4);
        }
        _warm = 0.30; _pink = 0.25; _unstable = 1;
        return;
      }
    }
  }

  /* ==========================================================================
     3. POOL
     --------------------------------------------------------------------------
     POOL = 8. The count is a shader constant: three bakes numSpotLights into
     the program, so ANY change to how many lights are in the scene recompiles
     every material in the build. That means (a) the pool size is fixed for the
     life of the process and (b) unused slots are driven to intensity 0 rather
     than .visible = false — toggling visibility is what makes lights leave the
     lights array, and the old code did that every single frame.

     Why 8 and not 4 or 16: the fixture grid is 3 cells = 7.8 m, so from any
     standing position the fixtures that make a visible pool in frame are the
     one overhead, its four grid neighbours, and two or three further down
     whichever run you are facing. 8 covers that with one spare. Beyond ~16 m a
     troffer contributes under 3 % of the pool centre's radiance and is 60 %+
     fogged, so it is invisible as a light — but its DIFFUSER still glows,
     because every fixture in view gets its emissive panel updated whether or
     not it owns a real light. That is the fake: distance fixtures are pure
     emissive quads plus fill plus fog, and it is indistinguishable at this
     bandwidth. Materials are Lambert, so each extra light is a full extra
     iteration of the punctual loop over every shaded fragment at 640×480×2
     fields — 16 lights measured ~1.6× the frame cost of 8 for no visible gain.
     ====================================================================== */
  const POOL = 8;
  const slots = [];                 // {light, fx, gain, prev}
  const selFx = new Array(POOL);
  const selScore = new Array(POOL);
  const MAXD2 = 18 * 18;
  const BACK_BIAS = 1.35;           // a fixture behind you lights less of frame
  const HYST = 0.86;                // stickiness for an already-bound fixture

  /* ==========================================================================
     4. SPATIAL HASH — buzzAt / brightnessAt are called every frame by audio
     --------------------------------------------------------------------------
     Fixed 256-bucket table over 16 m cells, rebuilt once per field (O(n), ~130
     fixtures, no allocation). A query touches at most 2×2 cells because the
     largest query radius is under the cell size, so it tests ~a dozen fixtures
     instead of all of them. The old implementation was O(all fixtures) PER CALL
     and also re-derived flicker state per call.
     ====================================================================== */
  const GBITS = 8, GN = 1 << GBITS, GMASK = GN - 1, GCELL = 16;
  const buckets = new Array(GN);
  for (let i = 0; i < GN; i++) buckets[i] = [];
  const bidx = (cx, cz) => ((cx * 73856093) ^ (cz * 19349663)) & GMASK;
  const visited = new Int32Array(4);

  function rebuildGrid(fixtures) {
    for (let i = 0; i < GN; i++) if (buckets[i].length) buckets[i].length = 0;
    for (let i = 0; i < fixtures.length; i++) {
      const p = fixtures[i].pos;
      buckets[bidx(Math.floor(p.x / GCELL), Math.floor(p.z / GCELL))].push(fixtures[i]);
    }
  }

  /* Normalisers so both queries return a calibrated 0..1. */
  const H_LIGHT = 2.62;                       // fixture height over the floor
  const NADIR = 1 / (H_LIGHT * H_LIGHT);      // illuminance factor straight down
  const BUZZ_R = 9.0, BUZZ_R2 = BUZZ_R * BUZZ_R;
  const BRIGHT_R = 15.0, BRIGHT_R2 = BRIGHT_R * BRIGHT_R;
  const AMB_FLOOR = 0.30;                     // what the fill alone reads as

  let buzzKey = -1, buzzVal = 0, brightKey = -1, brightVal = 0;

  /* horizontal-plane illuminance of one troffer, normalised to 1 at nadir,
     including the cosθ emitter distribution the SpotLight models */
  function floorTerm(r2) {
    const d2 = r2 + H_LIGHT * H_LIGHT;
    const d = Math.sqrt(d2);
    const cos = H_LIGHT / d;
    const spot = cos * cos * (3 - 2 * cos);   // smoothstep(0,1,cos)
    return (cos / d2) * spot / NADIR;
  }

  function forEachNear(x, z, R, fn) {
    const c0x = Math.floor((x - R) / GCELL), c1x = Math.floor((x + R) / GCELL);
    const c0z = Math.floor((z - R) / GCELL), c1z = Math.floor((z + R) / GCELL);
    let nv = 0;
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const b = bidx(cx, cz);
        let seen = false;
        for (let k = 0; k < nv; k++) if (visited[k] === b) { seen = true; break; }
        if (seen) continue;
        if (nv < 4) visited[nv++] = b;
        const arr = buckets[b];
        for (let i = 0; i < arr.length; i++) fn(arr[i]);
      }
    }
  }

  /* ------------------------------------------------------------------ fog */
  const FOG_COL = 0xcdc094;   // pale warm haze, brighter than the walls, so a
                              // long run recedes into light rather than black
  const FOG_NEAR = 3.0, FOG_FAR = 27.0;

  let fixtures = [];
  let flickTimer = 0;
  const _ecol = [0, 0, 0];

  function lampColour(warm, pink, out) {
    const w = VB.clamp(warm, 0, 1), p = VB.clamp(pink, 0, 1);
    for (let i = 0; i < 3; i++) {
      out[i] = VB.lerp(VB.lerp(LAMP[i], AMBERR[i], w), PINKK[i], p);
    }
  }

  return {
    init() {
      VB.scene.fog = new THREE.Fog(FOG_COL, FOG_NEAR, FOG_FAR);
      /* No sky exists in here, but chunk streaming has edges and the clear
         colour is black; haze is a better void than a hole. */
      VB.scene.background = new THREE.Color(FOG_COL);

      VB.scene.add(new THREE.AmbientLight(AMB_COL, AMB_I));
      VB.scene.add(new THREE.HemisphereLight(HEMI_SKY, HEMI_GND, HEMI_I));

      for (let i = 0; i < POOL; i++) {
        const l = new THREE.SpotLight(0xffffff, 0, LIGHT_R, Math.PI / 2, 1.0, 2);
        l.castShadow = false;
        /* target parented to the light so its world matrix updates for free and
           the cone always points straight down */
        l.target.position.set(0, -1, 0);
        l.add(l.target);
        l.position.set(0, -999, 0);
        VB.scene.add(l);
        slots.push({ light: l, fx: null, gain: 0, prev: 1 });
      }

      VB.lighting = {
        /* 0..1 ballast buzz for the audio module. Loudest under a dying or
           starter-cycling fixture — a healthy ballast is a hum, a failing one
           is a rattle — and a dead fixture still buzzes a little, because the
           ballast is still energised. */
        buzzAt(x, z) {
          const k = (S.frame * 4096 + ((x * 8) | 0) * 64 + ((z * 8) | 0)) | 0;
          if (k === buzzKey) return buzzVal;
          let acc = 0;
          forEachNear(x, z, BUZZ_R, (f) => {
            const dx = f.pos.x - x, dz = f.pos.z - z;
            const d2 = dx * dx + dz * dz;
            if (d2 >= BUZZ_R2) return;
            const w = 1 - d2 / BUZZ_R2;
            acc += w * w * (f.buzz !== undefined ? f.buzz : 0.5);
          });
          buzzKey = k; buzzVal = VB.clamp(acc, 0, 1);
          return buzzVal;
        },

        /* 0..1 illuminance on the floor plane at (x,z), 1 = directly under a
           healthy troffer. Includes the fill floor, so it never reads 0. */
        brightnessAt(x, z) {
          const k = (S.frame * 4096 + ((x * 8) | 0) * 64 + ((z * 8) | 0)) | 0;
          if (k === brightKey) return brightVal;
          let acc = 0;
          forEachNear(x, z, BRIGHT_R, (f) => {
            const dx = f.pos.x - x, dz = f.pos.z - z;
            const d2 = dx * dx + dz * dz;
            if (d2 >= BRIGHT_R2) return;
            acc += floorTerm(d2) * (f.level || 0);
          });
          brightKey = k;
          brightVal = VB.clamp(acc + AMB_FLOOR * (1 - S.prox * 0.5), 0, 1);
          return brightVal;
        },

        /* introspection for the harness / critics */
        debug() {
          const census = [0, 0, 0, 0, 0, 0];
          const CELLM = VB.layout ? VB.layout.CELL : 2.6;
          for (const f of fixtures) {
            const ix = Math.round(f.pos.x / CELLM - 0.5) | 0;
            const iz = Math.round(f.pos.z / CELLM - 0.5) | 0;
            census[modeOf(f, VB.hashf(ix, iz, 4242))]++;
          }
          return {
            fixtures: fixtures.length, census,
            pool: slots.map(s => +s.light.intensity.toFixed(2)),
            fog: [+VB.scene.fog.near.toFixed(2), +VB.scene.fog.far.toFixed(2)],
            beatPeriod: +(1 / Math.abs(120 - 2 * FIELD_HZ)).toFixed(3),
            ripple: [+A120.toFixed(4), +A240.toFixed(4)],
          };
        },
      };
    },

    update(dt) {
      fixtures = VB.layout ? VB.layout.fixtures : [];
      const t = S.t;
      const CELLM = VB.layout ? VB.layout.CELL : 2.6;

      /* --------------------------------------------------- entity influence */
      const ent = VB.entity && VB.entity.active ? VB.entity.pos : null;
      const prox = VB.clamp(S.prox, 0, 1);
      const killR = 8.0 + prox * 8.0;
      const sag = 1 - prox * 0.40;                      // mains browns out
      /* Ripple gets deeper as it goes wrong — the tape is watching the lights
         harder than it should be. */
      precomputeRipple(t, 1 + S.dread * 0.7 + prox * 2.2);

      /* ------------------------------------------------- per-fixture update */
      const px = S.pos.x, pz = S.pos.z;
      const fogFar = VB.scene.fog ? VB.scene.fog.far : FOG_FAR;
      const visR = fogFar + 10, visR2 = visR * visR;
      const field = (t * FIELD_HZ) | 0;

      rebuildGrid(fixtures);

      for (let i = 0; i < fixtures.length; i++) {
        const f = fixtures[i];
        const dx = f.pos.x - px, dz = f.pos.z - pz;
        if (dx * dx + dz * dz > visR2) continue;        // out of the haze

        const ix = Math.round(f.pos.x / CELLM - 0.5) | 0;
        const iz = Math.round(f.pos.z / CELLM - 0.5) | 0;
        const h = VB.hashf(ix, iz, 4242);
        const h2 = VB.hashf(ix, iz, 9119);
        const mode = modeOf(f, h);
        const circuit = VB.hash2(ix >> 1, iz >> 1, 7717) % 3;

        evalFixture(ix, iz, mode, circuit, h2, h2, t);
        let lvl = _lvl, warm = _warm, pink = _pink, unstable = _unstable;

        /* Entity: browns out globally, fails LOCALLY. The dark is where it is. */
        if (prox > 0.001) {
          lvl *= sag;
          warm += prox * 0.55;
          let k = prox * 0.12;                           // faint global unease
          if (ent) {
            const ex = f.pos.x - ent.x, ez = f.pos.z - ent.z;
            k = Math.max(k, prox * VB.smoothstep(killR, killR * 0.3, Math.hypot(ex, ez)));
          }
          if (k > 0.02) {
            const j = VB.hashf(field, ix * 17 + iz * 7, 313);
            lvl *= (1 - k * 0.92) * (j < k * 0.55 ? 0.08 : 1);
            warm = Math.max(warm, k * 0.85);
            unstable = Math.max(unstable, k);
          }
        }
        lvl = lvl < 0 ? 0 : lvl > 1.35 ? 1.35 : lvl;

        f.level = lvl;
        /* ballast: healthy hum < failing rattle; dead housing still sings */
        f.buzz = mode === M_DEAD ? 0.18 : 0.45 + 0.55 * unstable;

        /* ------------------------------------------------ emissive diffuser */
        const m = f.mesh && f.mesh.material;
        if (m) {
          if (mode === M_DEAD && lvl <= 0.0001) {
            m.color.setRGB(PANEL_DEAD[0], PANEL_DEAD[1], PANEL_DEAD[2]);
          } else {
            lampColour(warm, pink, _ecol);
            const g = lvl * PANEL_GAIN;
            m.color.setRGB(
              VB.lerp(_ecol[0], 1, PANEL_WHITEN) * g,
              VB.lerp(_ecol[1], 1, PANEL_WHITEN) * g,
              VB.lerp(_ecol[2], 1, PANEL_WHITEN) * g);
          }
        }
      }

      /* ----------------------------------------------------- pool selection */
      const fwdX = -Math.sin(S.yaw), fwdZ = -Math.cos(S.yaw);
      for (let i = 0; i < POOL; i++) { selFx[i] = null; selScore[i] = Infinity; }

      for (let i = 0; i < fixtures.length; i++) {
        const f = fixtures[i];
        if (!f.on) continue;                    // never spend a slot on a corpse
        const dx = f.pos.x - px, dz = f.pos.z - pz;
        let s = dx * dx + dz * dz;
        if (s > MAXD2) continue;
        if (dx * fwdX + dz * fwdZ < 0) s *= BACK_BIAS;
        for (let k = 0; k < POOL; k++) if (slots[k].fx === f) { s *= HYST; break; }
        if (s >= selScore[POOL - 1]) continue;
        let j = POOL - 1;
        while (j > 0 && selScore[j - 1] > s) {
          selScore[j] = selScore[j - 1]; selFx[j] = selFx[j - 1]; j--;
        }
        selScore[j] = s; selFx[j] = f;
      }

      /* keep continuing fixtures in the slot they already own, so a light never
         teleports across the room while it is still contributing */
      for (let k = 0; k < POOL; k++) {
        const sl = slots[k];
        if (!sl.fx) continue;
        let still = -1;
        for (let j = 0; j < POOL; j++) if (selFx[j] === sl.fx) { still = j; break; }
        if (still >= 0) selFx[still] = null; else sl.fx = null;
      }
      for (let j = 0; j < POOL; j++) {
        if (!selFx[j]) continue;
        for (let k = 0; k < POOL; k++) {
          if (!slots[k].fx) { slots[k].fx = selFx[j]; slots[k].gain = 0; break; }
        }
      }

      /* ------------------------------------------------------- drive lights */
      flickTimer -= dt;
      for (let k = 0; k < POOL; k++) {
        const sl = slots[k], l = sl.light, f = sl.fx;
        if (!f) { l.intensity = 0; sl.prev = 1; continue; }

        sl.gain = VB.approach(sl.gain, 1, 22, dt);      // ~0.1 s fade-in
        const lvl = f.level;

        l.position.copy(f.pos);
        l.intensity = lvl * CD * sl.gain;
        l.distance = LIGHT_R;

        /* recover the tint the panel used, so lamp and pool always agree */
        const ix = Math.round(f.pos.x / CELLM - 0.5) | 0;
        const iz = Math.round(f.pos.z / CELLM - 0.5) | 0;
        const h = VB.hashf(ix, iz, 4242), h2 = VB.hashf(ix, iz, 9119);
        const mode = modeOf(f, h);
        evalFixture(ix, iz, mode, VB.hash2(ix >> 1, iz >> 1, 7717) % 3, h2, h2, t);
        lampColour(_warm + prox * 0.55, _pink, _ecol);
        l.color.setRGB(_ecol[0], _ecol[1], _ecol[2]);

        /* tell the rest of the build when a nearby tube drops out */
        if (sl.prev - lvl > 0.35 && flickTimer <= 0) {
          flickTimer = 0.11;
          VB.emit('light:flicker', { pos: f.pos, amt: sl.prev - lvl });
        }
        sl.prev = lvl;
      }

      /* --------------------------------------------------------------- fog */
      if (VB.scene.fog) {
        const fog = VB.scene.fog;
        /* Haze closes in as it gets worse. 27 m shows three fixture bays
           receding; 14 m is one bay and a wall of nothing. */
        const far = 27.0 - S.dread * 7.5 - prox * 6.0;
        fog.far = VB.approach(fog.far, far, 1.1, dt);
        fog.near = VB.approach(fog.near, 3.0 - prox * 1.5, 1.4, dt);
        /* and it browns as the lamps sag, because haze is only ever the colour
           of whatever is lighting it */
        const c = fog.color;
        c.setRGB(
          VB.lerp(0.6376, 0.2600, prox),
          VB.lerp(0.5271, 0.1500, prox),
          VB.lerp(0.2874, 0.0900, prox));
        if (VB.scene.background && VB.scene.background.isColor) VB.scene.background.copy(c);
      }
    },
  };
}, 20);
