/* ============================================================================
   PLAYER — the person holding the camcorder.

   The camera is not mounted to a head; it is held at chest height in two tired
   hands. It lags behind the intent, overshoots, drifts, and breathes. Nothing
   here is critically damped — a perfectly-tracking camera reads as a game.
   ========================================================================== */
VB.def('player', function (VB, THREE) {
  const S = VB.S, cfg = VB.cfg;

  /* look: `want` is the mouse-integrated intent, S.yaw/pitch is where the
     operator's hands have actually got to. */
  let wantYaw = 0, wantPitch = 0, appliedYaw = 0, appliedPitch = 0;
  let velYaw = 0, velPitch = 0;      // spring velocity, gives the overshoot
  let roll = 0, rollVel = 0;

  const vel = new THREE.Vector3();
  const keys = Object.create(null);
  let locked = false, bobAmt = 0, lastFoot = 0, stepPhase = 0;
  let breath = 0, breathRate = 0.24, stamina = 1;
  let sway = 0;
  let flashOn = true;
  const tmp = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3();

  /* ------------------------------------------------------------- input */
  function onKey(e, down) {
    const k = e.code;
    keys[k] = down;
    if (down && (k === 'KeyE' || k === 'Space')) interact();
    if (down && k === 'KeyF') { flashOn = !flashOn; VB.emit('player:flashlight', { on: flashOn }); }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft'].indexOf(k) >= 0) e.preventDefault();
  }
  function onMove(e) {
    if (!locked) return;
    /* 1987 camcorder operators are not esports players — deliberately slow. */
    const sens = 0.00165;
    wantYaw -= e.movementX * sens;
    wantPitch -= e.movementY * sens;
    wantPitch = VB.clamp(wantPitch, -1.15, 1.15);
  }
  function interact() {
    if (!VB.running) return;
    fwd.set(-Math.sin(S.yaw) * Math.cos(S.pitch), Math.sin(S.pitch), -Math.cos(S.yaw) * Math.cos(S.pitch));
    const d = VB.layout && VB.layout.raycastWalls ? VB.layout.raycastWalls(S.pos, fwd, 2.2) : Infinity;
    VB.emit('player:interact', { hit: isFinite(d) ? d : null, pos: S.pos.clone(), dir: fwd.clone() });
  }

  /* Pointer lock is not always available — an embedded/sandboxed frame can
     refuse it outright. Rather than leaving the player unable to look around,
     fall back to drag-to-look, which needs no permission at all. */
  let dragging = false, dragX = 0, dragY = 0;

  function requestLock() {
    const el = document.getElementById('hit');
    if (el && el.requestPointerLock) {
      const r = el.requestPointerLock();
      if (r && r.catch) r.catch(() => { /* fallback path handles it */ });
    }
    const plate = document.getElementById('plate');
    if (plate) plate.classList.add('gone');
    VB.start();
  }

  function onDown(e) {
    requestLock();
    dragging = true; dragX = e.clientX; dragY = e.clientY;
  }
  function onDrag(e) {
    if (!dragging || locked) return;      // pointer lock, when we have it, wins
    const sens = 0.0034;
    wantYaw -= (e.clientX - dragX) * sens;
    wantPitch -= (e.clientY - dragY) * sens;
    wantPitch = VB.clamp(wantPitch, -1.15, 1.15);
    dragX = e.clientX; dragY = e.clientY;
  }

  return {
    init() {
      const hit = document.getElementById('hit');
      hit.addEventListener('mousedown', onDown);
      window.addEventListener('mouseup', () => { dragging = false; });
      window.addEventListener('mousemove', onDrag);
      document.addEventListener('pointerlockchange', () => {
        locked = document.pointerLockElement === document.getElementById('hit');
      });
      document.addEventListener('mousemove', onMove);
      window.addEventListener('keydown', e => onKey(e, true));
      window.addEventListener('keyup', e => onKey(e, false));
      window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
      VB.on('player:teleport', () => { vel.set(0, 0, 0); wantYaw = S.yaw; });
      VB.player = {
        get locked() { return locked; },
        get flashOn() { return flashOn; },
        interact,
      };
    },

    update(dt) {
      /* ---------------------------------------------------------- look */
      /* If anything outside this module moved the view (spawn placement, a
         teleport, a scripted glance) adopt it as the new intent instead of
         springing back to where the mouse thinks we were pointing. */
      if (Math.abs(S.yaw - appliedYaw) > 1e-6 || Math.abs(S.pitch - appliedPitch) > 1e-6) {
        wantYaw = S.yaw; wantPitch = S.pitch; velYaw = 0; velPitch = 0;
      }

      /* Under-damped spring: the hands arrive late and go slightly past. */
      const kSpring = 118, kDamp = 15.5;
      velYaw += (wantYaw - S.yaw) * kSpring * dt; velYaw -= velYaw * kDamp * dt;
      velPitch += (wantPitch - S.pitch) * kSpring * dt; velPitch -= velPitch * kDamp * dt;
      const dyaw = velYaw * dt;
      S.yaw += dyaw; S.pitch += velPitch * dt;
      appliedYaw = S.yaw; appliedPitch = S.pitch;

      /* S.turn is what the tape reacts to — normalise against a brisk pan. */
      const rawTurn = Math.min(1, Math.abs(velYaw) / 3.1 + Math.abs(velPitch) / 3.6);
      S.turn = VB.approach(S.turn, rawTurn, rawTurn > S.turn ? 26 : 5.5, dt);

      /* --------------------------------------------------------- drive */
      const run = !!keys.ShiftLeft && stamina > 0.06;
      let ix = 0, iz = 0;
      if (keys.KeyW || keys.ArrowUp) iz -= 1;
      if (keys.KeyS || keys.ArrowDown) iz += 1;
      if (keys.KeyA || keys.ArrowLeft) ix -= 1;
      if (keys.KeyD || keys.ArrowRight) ix += 1;
      const inLen = Math.hypot(ix, iz);
      if (inLen > 0) { ix /= inLen; iz /= inLen; }

      const speed = run ? cfg.runSpeed : cfg.walkSpeed;
      fwd.set(-Math.sin(S.yaw), 0, -Math.cos(S.yaw));
      right.set(Math.cos(S.yaw), 0, -Math.sin(S.yaw));
      tmp.set(0, 0, 0).addScaledVector(fwd, -iz * speed).addScaledVector(right, ix * speed);
      /* boots on damp carpet: slow to start, slower to stop */
      const accel = inLen > 0 ? 11 : 8.5;
      vel.x = VB.approach(vel.x, tmp.x, accel, dt);
      vel.z = VB.approach(vel.z, tmp.z, accel, dt);

      S.pos.x += vel.x * dt; S.pos.z += vel.z * dt;
      if (VB.layout && VB.layout.collide) VB.layout.collide(S.pos, cfg.playerRadius);

      const spd = Math.hypot(vel.x, vel.z);
      S.move = VB.clamp(spd / cfg.walkSpeed, 0, 1.8);
      S.running = run && spd > 0.6 ? VB.approach(S.running, 1, 6, dt) : VB.approach(S.running, 0, 4, dt);
      stamina = VB.clamp(stamina + (run && spd > 0.6 ? -dt * 0.075 : dt * 0.045), 0, 1);

      /* ----------------------------------------------------- head bob */
      /* Two footfalls per cycle; the vertical is the double-frequency term. */
      const stride = run ? 9.2 : 6.35;
      stepPhase += spd * dt * (stride / Math.max(0.9, cfg.walkSpeed));
      S.bobPhase = stepPhase;
      bobAmt = VB.approach(bobAmt, VB.clamp(spd / cfg.walkSpeed, 0, 1.5), 7, dt);

      const foot = Math.floor(stepPhase / Math.PI);
      if (foot !== lastFoot && bobAmt > 0.18) {
        lastFoot = foot;
        VB.emit('player:step', { foot: foot & 1, speed: spd, pos: S.pos });
      }

      /* -------------------------------------------- breathing + sway */
      breathRate = 0.22 + S.running * 0.5 + (1 - stamina) * 0.42 + S.dread * 0.30;
      breath += dt * breathRate * Math.PI * 2;
      const breathDepth = 0.0075 + (1 - stamina) * 0.019 + S.dread * 0.011;

      /* operator drift — never still, low frequency, unrepeating */
      const dr = 1 + S.dread * 1.5;
      const nY = (VB.fbm1(S.t * 0.33, 4, 11) - 0.5) * 0.030 * dr;
      const nP = (VB.fbm1(S.t * 0.29, 4, 29) - 0.5) * 0.024 * dr;
      const nR = (VB.fbm1(S.t * 0.21, 3, 53) - 0.5) * 0.055 * dr;

      /* body roll into strafes + the swing of the arm carrying the camera */
      sway = VB.approach(sway, -ix * 0.055, 4.5, dt);
      const targetRoll = sway + Math.sin(stepPhase) * 0.021 * bobAmt + nR - dyaw * 1.9;
      rollVel += (targetRoll - roll) * 90 * dt; rollVel -= rollVel * 13 * dt;
      roll += rollVel * dt;

      const bobY = Math.cos(stepPhase * 2) * 0.034 * bobAmt;
      const bobX = Math.sin(stepPhase) * 0.030 * bobAmt;
      const breathY = Math.sin(breath) * breathDepth;

      /* ------------------------------------------------------- camera */
      const cam = VB.camera;
      cam.position.set(
        S.pos.x + right.x * bobX + fwd.x * (Math.sin(stepPhase * 2) * 0.012 * bobAmt),
        S.pos.y + bobY + breathY - S.running * 0.03,
        S.pos.z + right.z * bobX + fwd.z * (Math.sin(stepPhase * 2) * 0.012 * bobAmt)
      );
      cam.rotation.set(0, 0, 0);
      cam.rotation.order = 'YXZ';
      cam.rotation.y = S.yaw + nY;
      cam.rotation.x = S.pitch + nP + Math.sin(stepPhase * 2 + 1.1) * 0.010 * bobAmt;
      cam.rotation.z = roll;
    },
  };
}, 10);
