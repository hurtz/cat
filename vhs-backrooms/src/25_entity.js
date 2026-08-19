/* ============================================================================
   ENTITY — the thing that is also in here.

   Design rule, and the whole reason this module is restrained: it is never
   fully shown. What the player gets is a dark vertical smudge at the far end of
   a corridor, or a shape crossing a doorway forty metres away, and by the time
   the tracking recovers it is not there any more. The tape reacts to it before
   the eye does — glitches correlate with what is off-screen, which is what
   makes the picture feel like it knows something.

   It is therefore mostly a *state machine driving S.prox/seen/stalked*, and only
   incidentally a mesh.
   ========================================================================== */
VB.def('entity', function (VB, THREE) {
  const S = VB.S;

  /* --- tuning ---------------------------------------------------------- */
  const FIRST_APPEARANCE = 55;      // seconds of nothing before it ever shows
  /* Fog reaches ~30m, so a sighting placed out there is fogged to nothing.
     "Never fully shown" has to still mean *perceptible* — the band below is
     where a dark shape reads as a shape without resolving into a model. */
  const MIN_D = 8, MAX_D = 17;      // never spawns closer than MIN_D
  const RETREAT_D = 9;              // gets this close and it leaves instead
  const SHOW_TIME = [1.4, 3.6];     // how long a sighting lasts

  let mesh = null, mat = null;
  let active = false, life = 0, showFor = 0;
  let cooldown = 26 + Math.random() * 40;
  let seenAccum = 0, prox = 0, stalked = 0;
  let approach = 0;                 // 0 = static sighting, 1 = it is coming
  let debugLock = false;
  const pos = new THREE.Vector3();
  const toE = new THREE.Vector3(), fwd = new THREE.Vector3();

  /* A silhouette, not a character: tall, thin, wrong proportions, no features.
     Soft-edged so that after the tape chain it reads as a smudge that might be
     a person, which is more frightening than a model. */
  function makeSilhouette() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 256;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 128, 256);
    g.fillStyle = '#000';
    /* head */
    g.beginPath(); g.ellipse(64, 44, 15, 19, 0, 0, 7); g.fill();
    /* neck + torso, narrower than a person's should be */
    g.beginPath();
    g.moveTo(56, 58); g.lineTo(72, 58);
    g.lineTo(82, 96); g.lineTo(79, 176);
    g.lineTo(49, 176); g.lineTo(46, 96);
    g.closePath(); g.fill();
    /* arms hanging too long and too straight */
    g.fillRect(40, 92, 9, 96);
    g.fillRect(79, 92, 9, 96);
    /* legs, together */
    g.fillRect(52, 174, 11, 80);
    g.fillRect(66, 174, 11, 80);
    /* feather the whole thing so no hard vector edge survives */
    const img = g.getImageData(0, 0, 128, 256), d = img.data;
    const a = new Float32Array(128 * 256);
    for (let i = 0; i < 128 * 256; i++) a[i] = d[i * 4 + 3] / 255;
    const b = new Float32Array(128 * 256);
    for (let p = 0; p < 2; p++) {
      for (let y = 1; y < 255; y++)
        for (let x = 1; x < 127; x++) {
          const i = y * 128 + x;
          b[i] = (a[i] * 4 + a[i - 1] + a[i + 1] + a[i - 128] + a[i + 128]) / 8;
        }
      a.set(b);
    }
    for (let i = 0; i < 128 * 256; i++) {
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 0;
      d[i * 4 + 3] = Math.min(255, a[i] * 245);
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  }

  /* Place it where it can actually be seen: in front of the player, far away,
     with clear line of sight — a shape behind a wall is wasted. */
  function trySpawn() {
    const L = VB.layout;
    if (!L) return false;
    fwd.set(-Math.sin(S.yaw), 0, -Math.cos(S.yaw));
    /* These rooms are small and cluttered, so a clear 30m sightline is rare.
       Walk the distance band from far to near and take the first spot that has
       one — far is better, but a shape at 10m down a corridor still works, and
       failing to spawn at all is the worst outcome. */
    for (let i = 0; i < 64; i++) {
      /* biased into the forward hemisphere but not dead-centre — it belongs at
         the edge of attention, not in the middle of the frame */
      const off = (Math.random() - 0.5) * 1.7;
      const a = Math.atan2(fwd.x, fwd.z) + off;
      const d = MAX_D - (MAX_D - MIN_D) * (i / 63) * (0.55 + Math.random() * 0.45);
      const x = S.pos.x + Math.sin(a) * d, z = S.pos.z + Math.cos(a) * d;
      if (L.solidAt(x, z)) continue;
      toE.set(x - S.pos.x, 0, z - S.pos.z);
      const dist = toE.length();
      toE.normalize();
      if (L.raycastWalls(S.pos, toE, dist - 0.6) < dist - 0.8) continue;  // blocked
      pos.set(x, 0, z);
      return true;
    }
    return false;
  }

  function despawn() {
    active = false;
    if (mesh) mesh.visible = false;
    cooldown = 22 + Math.random() * 46;
    cooldown *= (1 - S.dread * 0.5);        // the longer you last, the less rest
    VB.emit('entity:despawn', {});
  }

  return {
    init() {
      mat = new THREE.MeshBasicMaterial({
        map: makeSilhouette(), transparent: true, opacity: 0,
        depthWrite: false, fog: true, color: 0x0d0d0c,
      });
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.78, 1.95), mat);
      mesh.visible = false;
      mesh.renderOrder = 5;
      VB.scene.add(mesh);
      VB.entity = {
        pos: null, active: false, dist: Infinity,
        /* test hook: skip the cooldown and place a sighting now. Returns false
           if no spot with clear line of sight could be found. */
        forceSpawn() {
          if (active) return true;
          if (!trySpawn()) return false;
          active = true; life = 0; approach = 0;
          showFor = SHOW_TIME[1];
          mesh.visible = true; mat.opacity = 0;
          VB.emit('entity:spawn', { pos: pos.clone() });
          return true;
        },
        /* debug: make the silhouette unmissable, to separate "not rendering"
           from "rendering but too low contrast" */
        debugMark() { mat.color.setHex(0xff0000); mat.fog = false; mat.opacity = 1; mat.needsUpdate = true; debugLock = true; },
      };
      VB.on('world:reseed', () => { despawn(); cooldown = 30; stalked = 0; });
    },

    update(dt) {
      const L = VB.layout;

      if (!active) {
        prox = VB.approach(prox, 0, 1.1, dt);
        cooldown -= dt;
        if (cooldown <= 0 && S.t > FIRST_APPEARANCE && L) {
          if (trySpawn()) {
            active = true; life = 0;
            showFor = SHOW_TIME[0] + Math.random() * (SHOW_TIME[1] - SHOW_TIME[0]);
            /* it only ever starts moving toward you once the tape is worn */
            approach = Math.random() < 0.18 + S.wear * 0.42 ? 1 : 0;
            mesh.visible = true;
            mat.opacity = 0;
            VB.emit('entity:spawn', { pos: pos.clone() });
          } else {
            cooldown = 4 + Math.random() * 6;
          }
        }
      } else {
        life += dt;

        toE.set(pos.x - S.pos.x, 0, pos.z - S.pos.z);
        let dist = toE.length();
        toE.normalize();

        if (approach) {
          /* a slow, steady walk — never a charge. It does not need to hurry. */
          const sp = 0.62 + S.dread * 0.55;
          pos.x -= toE.x * sp * dt;
          pos.z -= toE.z * sp * dt;
          dist = Math.hypot(pos.x - S.pos.x, pos.z - S.pos.z);
        }

        /* line of sight and whether it is actually in frame */
        const clear = L ? L.raycastWalls(S.pos, toE, dist - 0.6) >= dist - 0.8 : true;
        fwd.set(-Math.sin(S.yaw), 0, -Math.cos(S.yaw));
        const facing = fwd.x * toE.x + fwd.z * toE.z;      // 1 = dead ahead
        const inFrame = facing > 0.62 && clear;

        /* Proximity is what the tape and the audio actually react to, and it
           rises even when the thing is behind you — that is the point. */
        const near = VB.clamp(1 - (dist - RETREAT_D) / (MAX_D - RETREAT_D), 0, 1);
        prox = VB.approach(prox, near * (clear ? 1 : 0.55), 2.2, dt);

        /* It fades in rather than popping, and never becomes fully solid. */
        const vis = VB.clamp(life / 0.9, 0, 1) * VB.clamp((showFor - life) / 0.7, 0, 1);
        /* Alpha is NOT how this stays ambiguous — fog, the tape chain and the
           two-second lifetime do that. A translucent shape over a bright wall
           just vanishes, so it renders nearly opaque and lets the medium hide
           it. */
        if (!debugLock) mat.opacity = vis * (0.88 + 0.12 * near);

        mesh.position.set(pos.x, 0.98, pos.z);
        mesh.lookAt(VB.camera.position.x, 0.98, VB.camera.position.z);
        /* a little taller than a person, and it grows as it gets closer in a
           way that does not quite match the perspective */
        const sc = 1.0 + near * 0.22;
        mesh.scale.set(sc, sc * (1.04 + near * 0.10), sc);

        if (inFrame && vis > 0.25) {
          seenAccum += dt;
          S.seen = VB.approach(S.seen, VB.clamp(vis * facing, 0, 1), 4, dt);
          if (seenAccum > 0.35 && seenAccum - dt <= 0.35) {
            VB.emit('entity:sighting', { strength: vis, dist });
            VB.emit('glitch:burst', { amt: 0.45 + 0.4 * near });
          }
        } else {
          S.seen = VB.approach(S.seen, 0, 3, dt);
        }

        if (dist < 12 && dist >= RETREAT_D) VB.emit('entity:near', { d: dist });

        /* Looking straight at it is what makes it go. You are never allowed to
           resolve the shape — the moment you fix on it, it is gone, and only
           the tape remembers. */
        const stared = inFrame && facing > 0.93 && life > 0.8;
        if (life > showFor || dist < RETREAT_D || (stared && Math.random() < dt * 1.6)) {
          VB.emit('glitch:burst', { amt: 0.55 + 0.35 * near });
          despawn();
        }
      }

      /* "Being followed" builds slowly and only bleeds off very slowly. */
      stalked = VB.clamp(stalked + (active ? dt * 0.055 * (1 + prox) : -dt * 0.010), 0, 1);

      S.prox = prox;
      S.stalked = stalked;
      if (!active) S.seen = VB.approach(S.seen, 0, 3, dt);

      VB.entity.active = active;
      VB.entity.pos = active ? pos : null;
      VB.entity.dist = active ? Math.hypot(pos.x - S.pos.x, pos.z - S.pos.z) : Infinity;
    },
  };
}, 25);
