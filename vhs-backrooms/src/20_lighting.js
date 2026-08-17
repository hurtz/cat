/* ============================================================================
   LIGHTING — a small pool of point lights chases the nearest ceiling troffers.
   Fluorescents do not glow steadily: they buzz at 120Hz, some strobe, some are
   half-dead and pink.
   ========================================================================== */
VB.def('lighting', function (VB, THREE) {
  const S = VB.S;
  const POOL = 7;
  const lights = [];
  const state = new Map();   // fixture -> {phase, mode, level}

  function fixtureState(f) {
    let st = state.get(f);
    if (!st) {
      const h = VB.hashf(Math.round(f.pos.x * 10), Math.round(f.pos.z * 10), 4242);
      st = {
        phase: h * 100,
        /* 0 steady, 1 slow strobe, 2 dying stutter, 3 dead */
        mode: !f.on ? 3 : h < 0.08 ? 2 : h < 0.19 ? 1 : 0,
        level: 1,
      };
      state.set(f, st);
    }
    return st;
  }

  return {
    init() {
      VB.scene.fog = new THREE.Fog(0x6b6134, 4.0, 30.0);
      const amb = new THREE.AmbientLight(0xd6c795, 1.15);
      VB.scene.add(amb);
      /* bounce off the yellow everything */
      const hemi = new THREE.HemisphereLight(0xf5e6ae, 0x7d6f38, 0.45);
      VB.scene.add(hemi);
      for (let i = 0; i < POOL; i++) {
        const l = new THREE.PointLight(0xfff0c8, 0, 13, 1.75);
        l.visible = false;
        VB.scene.add(l);
        lights.push({ light: l, fx: null });
      }
      VB.lighting = {
        buzzAt(x, z) {
          let best = 0;
          for (const f of VB.layout.fixtures) {
            const d = Math.hypot(f.pos.x - x, f.pos.z - z);
            if (d < 9) best = Math.max(best, (1 - d / 9) * fixtureState(f).level);
          }
          return best;
        },
        brightnessAt(x, z) { return this.buzzAt(x, z); },
      };
    },

    update(dt) {
      const fixtures = VB.layout ? VB.layout.fixtures : [];
      /* pick the N nearest fixtures */
      const near = [];
      for (const f of fixtures) {
        const d = (f.pos.x - S.pos.x) ** 2 + (f.pos.z - S.pos.z) ** 2;
        if (d < 260) near.push({ f, d });
      }
      near.sort((a, b) => a.d - b.d);

      for (let i = 0; i < POOL; i++) {
        const slot = lights[i];
        const pick = near[i];
        if (!pick) { slot.light.visible = false; slot.fx = null; continue; }
        const f = pick.f, st = fixtureState(f);

        /* 120Hz ripple is aliased by a 60Hz field rate into a slow crawl —
           which is exactly what fluorescents look like on video. */
        const t = S.t + st.phase;
        let lvl;
        if (st.mode === 3) lvl = 0;
        else if (st.mode === 1) lvl = 0.55 + 0.45 * (Math.sin(t * 11.3) > 0.55 ? 1 : 0.12);
        else if (st.mode === 2) {
          const n = VB.fbm1(t * 7.1, 3, 77);
          lvl = n < 0.42 ? 0.06 + Math.random() * 0.12 : 0.78 + 0.22 * Math.sin(t * 47);
        } else lvl = 0.93 + 0.07 * Math.sin(t * 7.53) + 0.03 * Math.sin(t * 118.0);

        /* entity proximity browns everything out */
        lvl *= 1 - S.prox * 0.55;
        st.level = lvl;

        slot.light.visible = lvl > 0.01;
        slot.light.position.copy(f.pos);
        slot.light.intensity = lvl * 9.0;
        slot.light.distance = 13.0;
        slot.light.color.setHSL(0.12, 0.22 - lvl * 0.10, 0.5);
        if (f.mesh) f.mesh.material.color.setRGB(lvl * 1.0, lvl * 0.95, lvl * 0.80);
        if (st.mode !== 0 && Math.random() < dt * 2) VB.emit('light:flicker', { pos: f.pos, amt: lvl });
        slot.fx = f;
      }

      /* fog closes in as dread rises */
      if (VB.scene.fog) {
        VB.scene.fog.far = VB.approach(VB.scene.fog.far, 30 - S.dread * 10 - S.prox * 7, 1.2, dt);
        VB.scene.fog.near = 3.6 - S.prox * 1.6;
      }
    },
  };
}, 20);
