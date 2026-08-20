/* ============================================================================
   LAYOUT — endless procedural office.

   Fully deterministic from (seed, world cell): walk a circle and the same rooms
   come back, so there is nothing to remember and nothing to persist.

   Three things carry this module:

   * NEIGHBOURHOODS. A per-chunk BSP alone gives every part of the world the
     same statistics, and the eye finds that rhythm within a minute. A coarse
     spatial hash instead selects a *kind* of place — a cubicle warren, an open
     pillar hall, a service corridor run, a dead-end cluster — held across
     several chunks, so the world changes character as you walk rather than
     repeating at a nameable period. The BSP origin is also jittered per chunk
     so its cuts do not land on the chunk lattice.

   * DOORWAYS ARE OPENINGS, NOT GAPS. A hole punched from floor to ceiling
     reads as a missing wall. A real partition has a header above the opening
     and jambs at its sides, and putting those back is the single largest gain
     in how architectural the space feels. Door cells are their own cell kind:
     solid above DOOR_H, open below, walkable, and transparent to the entity's
     line of sight because the entity's eyes are below the header.

   * CELL KINDS. 0 open, 1 wall, 2 pillar (narrower), 3 doorway (header only).
     Collision and raycasting both have to agree with the mesh about these or
     the player walks through walls that are visibly there.
   ========================================================================== */
VB.def('layout', function (VB, THREE) {
  const S = VB.S;

  const CELL = 2.6;          // metres per grid cell
  const CEIL = 2.72;         // ceiling height
  const DOOR_H = 2.04;       // underside of the door header
  const CH = 8;              // cells per chunk edge
  const RADIUS = 2;          // chunks streamed around the player

  const chunks = new Map();
  const solidCache = new Map();
  const fixtures = [];
  let lastCell = null, lastRoomId = -1;

  const key = (a, b) => a + ',' + b;
  const floorDiv = (a, b) => Math.floor(a / b);

  /* ----------------------------------------------------------- neighbourhood
     Held over a 4x4-chunk area (~83m) so a place has time to establish itself.
     The boundaries are hashed rather than gridded in appearance because the
     generators blend at the edges — a warren next to a hall simply has its
     outermost rooms open into the hall. */
  const HOODS = ['warren', 'hall', 'corridor', 'cluster'];
  function hoodAt(gx, gz) {
    const h = VB.hashf(floorDiv(gx, 4), floorDiv(gz, 4), 60013);
    /* halls are rarer than rooms — a building is mostly rooms, and the open
       spaces have to feel like a change */
    return h < 0.40 ? 'warren' : h < 0.62 ? 'cluster' : h < 0.84 ? 'corridor' : 'hall';
  }

  /* ------------------------------------------------------- chunk solidity */
  function chunkSolids(gx, gz) {
    const k = key(gx, gz);
    let s = solidCache.get(k);
    if (s) return s;
    s = new Uint8Array(CH * CH);
    const R = VB.rngFrom(VB.hash2(gx, gz, S.seed));
    const hood = hoodAt(gx, gz);

    /* Wall runs, collected first so doorways can be cut into them afterwards
       with knowledge of the whole run. */
    const walls = [];
    const pushWall = (v, at, a, b) => { if (b - a >= 2) walls.push({ v, at, a, b }); };

    if (hood === 'hall') {
      /* Big open volume. One or two stub walls so it is not a featureless box. */
      if (R() < 0.55) pushWall(1, 1 + Math.floor(R() * (CH - 2)), 0, 2 + Math.floor(R() * 3));
      if (R() < 0.55) pushWall(0, 1 + Math.floor(R() * (CH - 2)), CH - 3 - Math.floor(R() * 2), CH);
    } else if (hood === 'corridor') {
      /* Parallel service runs. The gap between them is deliberately one cell:
         2.6m minus wall thickness reads as slightly too narrow to be a real
         corridor, which is the point. */
      const vertical = VB.hashf(gx, gz, 7717) < 0.5;
      let at = Math.floor(R() * 3);
      while (at < CH) {
        pushWall(vertical ? 1 : 0, at, 0, CH);
        at += 2 + (R() < 0.3 ? 1 : 0);
      }
    } else {
      /* warren / cluster — BSP, with the origin jittered off the chunk lattice
         so successive chunks do not cut in the same places. */
      const maxDepth = hood === 'warren' ? 4 : 3;
      const jx = Math.floor(R() * 3) - 1, jz = Math.floor(R() * 3) - 1;
      (function split(x0, z0, x1, z1, depth) {
        const w = x1 - x0, h = z1 - z0;
        if (depth > maxDepth || (w < 4 && h < 4) || R() < 0.10) return;
        const vertical = w === h ? R() < 0.5 : w > h;
        if (vertical) {
          if (w < 4) return;
          const cut = x0 + 1 + Math.floor(R() * (w - 2));
          pushWall(1, cut, z0, z1);
          split(x0, z0, cut, z1, depth + 1);
          split(cut + 1, z0, x1, z1, depth + 1);
        } else {
          if (h < 4) return;
          const cut = z0 + 1 + Math.floor(R() * (h - 2));
          pushWall(0, cut, x0, x1);
          split(x0, z0, x1, cut, depth + 1);
          split(x0, cut + 1, x1, z1, depth + 1);
        }
      })(jx, jz, CH + jx, CH + jz, 0);
    }

    /* Lay the runs down, cutting doorways rather than gaps. */
    for (const w of walls) {
      const len = w.b - w.a;
      const doors = [w.a + 1 + Math.floor(R() * Math.max(1, len - 2))];
      if (len > 5 && R() < 0.5) doors.push(w.a + 1 + Math.floor(R() * Math.max(1, len - 2)));
      /* Occasionally a run has NO door. A corridor that ends in a wall for no
         reason is one of the few genuinely unsettling things a floor plan can
         do, so it is rare and never explained. */
      const sealed = R() < 0.06;
      for (let i = w.a; i < w.b; i++) {
        const x = w.v ? w.at : i, z = w.v ? i : w.at;
        if (x < 0 || x >= CH || z < 0 || z >= CH) continue;
        s[z * CH + x] = (!sealed && doors.indexOf(i) >= 0) ? 3 : 1;
      }
    }

    /* Seam walls — both neighbouring chunks derive these from the same hash of
       the shared edge, so they always agree and rooms read as continuous. */
    for (let i = 0; i < CH; i++) {
      const he = VB.hashf(gx, gz * CH + i, 8081);
      if (he < 0.26 && he > 0.14) s[i * CH + 0] = (he < 0.165) ? 3 : 1;
      const hn = VB.hashf(gx * CH + i, gz, 4405);
      if (hn < 0.26 && hn > 0.14) s[0 * CH + i] = (hn < 0.165) ? 3 : 1;
    }

    /* Pillars. In halls they are a grid; elsewhere they are occasional. The
       grid is deliberately NOT aligned to the walls around it — a real building
       would never do that, and noticing it is the whole effect. */
    const pitch = hood === 'hall' ? 3 : 4;
    const off = hood === 'hall' ? 1 : 2;
    for (let z = 1; z < CH - 1; z++) {
      for (let x = 1; x < CH - 1; x++) {
        const wx = gx * CH + x, wz = gz * CH + z;
        if (((wx % pitch) + pitch) % pitch !== off || ((wz % pitch) + pitch) % pitch !== off) continue;
        if (s[z * CH + x]) continue;
        if (hood !== 'hall' && VB.hashf(wx, wz, 5150) > 0.45) continue;
        let clear = true;
        for (let d = 0; d < 4; d++) {
          const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), nz = z + (d === 2 ? 1 : d === 3 ? -1 : 0);
          if (s[nz * CH + nx]) { clear = false; break; }
        }
        if (clear) s[z * CH + x] = 2;
      }
    }

    solidCache.set(k, s);
    if (solidCache.size > 400) solidCache.delete(solidCache.keys().next().value);
    return s;
  }

  function cellKind(wx, wz) {
    const gx = floorDiv(wx, CH), gz = floorDiv(wz, CH);
    const s = chunkSolids(gx, gz);
    return s[(wz - gz * CH) * CH + (wx - gx * CH)];
  }
  /* Blocking for movement: walls and pillars, never doorways. */
  function solidAt(x, z) {
    const k = cellKind(Math.floor(x / CELL), Math.floor(z / CELL));
    return k === 1 || k === 2;
  }

  /* -------------------------------------------------------------- meshing */
  function buildChunk(gx, gz) {
    const s = chunkSolids(gx, gz);
    const ox = gx * CH * CELL, oz = gz * CH * CELL;
    const group = new THREE.Group();
    const localFixtures = [];
    const span = CH * CELL;

    const fg = new THREE.PlaneGeometry(span, span);
    fg.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(fg, VB.mats.carpet);
    floor.position.set(ox + span / 2, 0, oz + span / 2);
    const cg = new THREE.PlaneGeometry(span, span);
    cg.rotateX(Math.PI / 2);
    const ceil = new THREE.Mesh(cg, VB.mats.ceiling);
    ceil.position.set(ox + span / 2, CEIL, oz + span / 2);
    for (const m of [floor, ceil]) {
      const uv = m.geometry.attributes.uv, rep = CH / 2;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rep, uv.getY(i) * rep);
      uv.needsUpdate = true;
    }
    group.add(floor, ceil);

    const pos = [], nor = [], uvs = [], idx = [];
    let vi = 0;
    function quad(ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, nx, ny, nz, u0, v0, u1, v1) {
      pos.push(ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz);
      for (let i = 0; i < 4; i++) nor.push(nx, ny, nz);
      uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
      idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
      vi += 4;
    }
    const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

    for (let z = 0; z < CH; z++) {
      for (let x = 0; x < CH; x++) {
        const kind = s[z * CH + x];
        if (!kind) continue;
        const inset = kind === 2 ? 0.62 : 0;
        const x0 = ox + x * CELL + inset * CELL * 0.5, x1 = ox + (x + 1) * CELL - inset * CELL * 0.5;
        const z0 = oz + z * CELL + inset * CELL * 0.5, z1 = oz + (z + 1) * CELL - inset * CELL * 0.5;
        /* A doorway is only the header — the wall above the opening. */
        const yLo = kind === 3 ? DOOR_H : 0, yHi = CEIL;

        for (let d = 0; d < 4; d++) {
          const nx = x + DIRS[d][0], nz = z + DIRS[d][1];
          const nKind = (nx >= 0 && nx < CH && nz >= 0 && nz < CH)
            ? s[nz * CH + nx] : cellKind(gx * CH + nx, gz * CH + nz);
          /* Skip the face only where a same-height neighbour hides it. A door
             beside a wall still needs its face drawn above the header. */
          if (kind !== 2 && nKind === 1) continue;
          if (kind === 3 && nKind === 3) continue;

          const uw = (d < 2 ? (z1 - z0) : (x1 - x0)) / CELL;
          const u0 = (d < 2 ? z0 : x0) / CELL;
          const v0 = yLo / CEIL, v1 = yHi / CEIL;
          if (d === 0) quad(x1, yLo, z1, x1, yLo, z0, x1, yHi, z0, x1, yHi, z1, 1, 0, 0, u0, v0, u0 + uw, v1);
          else if (d === 1) quad(x0, yLo, z0, x0, yLo, z1, x0, yHi, z1, x0, yHi, z0, -1, 0, 0, u0, v0, u0 + uw, v1);
          else if (d === 2) quad(x0, yLo, z1, x1, yLo, z1, x1, yHi, z1, x0, yHi, z1, 0, 0, 1, u0, v0, u0 + uw, v1);
          else quad(x1, yLo, z0, x0, yLo, z0, x0, yHi, z0, x1, yHi, z0, 0, 0, -1, u0, v0, u0 + uw, v1);
        }

        /* The underside of the header, so a doorway reads as having thickness
           rather than being a decal on a plane. */
        if (kind === 3) {
          quad(x0, DOOR_H, z0, x1, DOOR_H, z0, x1, DOOR_H, z1, x0, DOOR_H, z1,
            0, -1, 0, x0 / CELL, z0 / CELL, x1 / CELL, z1 / CELL);
        }
      }
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(idx);
      g.computeBoundingSphere();
      group.add(new THREE.Mesh(g, VB.mats.variant('wall', VB.hash2(gx, gz, 3) & 1)));
    }

    /* Troffers, on the ceiling grid, some dead. */
    const panelGeo = new THREE.PlaneGeometry(1.16, 0.58);
    panelGeo.rotateX(Math.PI / 2);
    for (let z = 0; z < CH; z++) {
      for (let x = 0; x < CH; x++) {
        const wx = gx * CH + x, wz = gz * CH + z;
        if (((wx % 3) + 3) % 3 !== 1 || ((wz % 3) + 3) % 3 !== 1) continue;
        if (s[z * CH + x] === 1 || s[z * CH + x] === 2) continue;
        const px = ox + (x + 0.5) * CELL, pz = oz + (z + 0.5) * CELL;
        const dead = VB.hashf(wx, wz, 616) < 0.10;
        const m = new THREE.Mesh(panelGeo, VB.mats.lightPanel.clone());
        m.material._isClone = true;
        m.position.set(px, CEIL - 0.012, pz);
        m.material.color.setHex(dead ? 0x2a2a24 : 0xfff2cc);
        group.add(m);
        const fx = { pos: new THREE.Vector3(px, CEIL - 0.10, pz), on: !dead, mesh: m, level: dead ? 0 : 1 };
        localFixtures.push(fx);
        fixtures.push(fx);
      }
    }

    VB.scene.add(group);
    chunks.set(key(gx, gz), { group, fixtures: localFixtures });
  }

  function dropChunk(k) {
    const c = chunks.get(k);
    if (!c) return;
    VB.scene.remove(c.group);
    c.group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material._isClone) o.material.dispose();
    });
    for (const f of c.fixtures) { const i = fixtures.indexOf(f); if (i >= 0) fixtures.splice(i, 1); }
    chunks.delete(k);
  }

  function stream() {
    const gx = floorDiv(Math.floor(S.pos.x / CELL), CH), gz = floorDiv(Math.floor(S.pos.z / CELL), CH);
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
      for (let dx = -RADIUS; dx <= RADIUS; dx++) {
        const k = key(gx + dx, gz + dz);
        if (!chunks.has(k)) { buildChunk(gx + dx, gz + dz); return; }
      }
    }
    for (const k of chunks.keys()) {
      const [a, b] = k.split(',').map(Number);
      if (Math.abs(a - gx) > RADIUS + 1 || Math.abs(b - gz) > RADIUS + 1) { dropChunk(k); return; }
    }
  }

  function reset() {
    for (const k of Array.from(chunks.keys())) dropChunk(k);
    solidCache.clear();
    fixtures.length = 0;
  }

  /* ------------------------------------------------------------ collision */
  function collide(p, r) {
    for (let axis = 0; axis < 2; axis++) {
      const c = axis === 0 ? p.x : p.z;
      const oc = axis === 0 ? p.z : p.x;
      const ci = Math.floor(c / CELL), oi = Math.floor(oc / CELL);
      for (let d = -1; d <= 1; d++) {
        for (let e = -1; e <= 1; e++) {
          const cx = axis === 0 ? ci + d : oi + e;
          const cz = axis === 0 ? oi + e : ci + d;
          const kind = cellKind(cx, cz);
          if (kind !== 1 && kind !== 2) continue;      // doorways are walkable
          const inset = kind === 2 ? 0.62 * CELL * 0.5 : 0;
          const minX = cx * CELL + inset, maxX = (cx + 1) * CELL - inset;
          const minZ = cz * CELL + inset, maxZ = (cz + 1) * CELL - inset;
          const nx = VB.clamp(p.x, minX, maxX), nz = VB.clamp(p.z, minZ, maxZ);
          const dx = p.x - nx, dz = p.z - nz;
          const d2 = dx * dx + dz * dz;
          if (d2 < r * r) {
            if (d2 > 1e-8) {
              const dist = Math.sqrt(d2), push = r - dist;
              p.x += (dx / dist) * push; p.z += (dz / dist) * push;
            } else {
              p.x = p.x < (minX + maxX) / 2 ? minX - r : maxX + r;
            }
          }
        }
      }
    }
  }

  /* Line of sight at eye height. Door headers sit above the eye, so a doorway
     does not block sight — which is exactly how you glimpse something through
     one two rooms away. */
  function raycastWalls(origin, dir, maxD) {
    let x = origin.x, z = origin.z;
    const step = 0.12;
    for (let t = 0; t < maxD; t += step) {
      x += dir.x * step; z += dir.z * step;
      if (solidAt(x, z)) return t;
    }
    return Infinity;
  }

  function randomOpenPointNear(x, z, minR, maxR) {
    for (let i = 0; i < 48; i++) {
      const a = Math.random() * 7, r = minR + Math.random() * (maxR - minR);
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (!solidAt(px, pz)) return { x: px, z: pz };
    }
    return null;
  }

  /* Open on a view rather than nose-first into a wall. */
  function spawn() {
    let best = null;
    for (let z = -6; z <= 6; z++) {
      for (let x = -6; x <= 6; x++) {
        if (solidAt((x + 0.5) * CELL, (z + 0.5) * CELL)) continue;
        let open = 0;
        for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++)
          if (!solidAt((x + a + 0.5) * CELL, (z + b + 0.5) * CELL)) open++;
        const score = open - Math.hypot(x, z) * 0.35;
        if (!best || score > best.score) best = { x, z, score };
      }
    }
    if (!best) best = { x: 0, z: 0 };
    S.pos.set((best.x + 0.5) * CELL, VB.cfg.eyeHeight, (best.z + 0.5) * CELL);

    let bestYaw = 0, bestRun = -1;
    for (let i = 0; i < 16; i++) {
      const yaw = (i / 16) * Math.PI * 2;
      let run = 0;
      for (let d = 0.5; d < 26; d += 0.4) {
        if (solidAt(S.pos.x - Math.sin(yaw) * d, S.pos.z - Math.cos(yaw) * d)) break;
        run = d;
      }
      if (run > bestRun) { bestRun = run; bestYaw = yaw; }
    }
    S.yaw = bestYaw;
    VB.camera.rotation.order = 'YXZ';
    VB.camera.rotation.y = bestYaw;
  }

  return {
    init() {
      VB.layout = {
        CELL, CEIL, CH, DOOR_H,
        solidAt, collide, raycastWalls, randomOpenPointNear,
        floorY: () => 0,
        ceilY: () => CEIL,
        roomKindAt: (x, z) => hoodAt(floorDiv(Math.floor(x / CELL), CH), floorDiv(Math.floor(z / CELL), CH)),
        cellKind,
        fixtures,
        chunkCount: () => chunks.size,
      };
      VB.on('world:reseed', () => { reset(); spawn(); });
      VB.on('player:teleport', () => { stream(); });
      spawn();
    },

    update(dt) {
      stream();
      const cx = Math.floor(S.pos.x / CELL), cz = Math.floor(S.pos.z / CELL);
      if (!lastCell || lastCell.cx !== cx || lastCell.cz !== cz) {
        lastCell = { cx, cz };
        S.cell = lastCell;
        const rid = VB.hash2(floorDiv(cx, 3), floorDiv(cz, 3), 9);
        if (rid !== lastRoomId) {
          lastRoomId = rid;
          /* How wrong this place is. Corridors that are too narrow and halls
             whose pillars ignore their walls score high; ordinary rooms score
             near zero, because the horror only works if most of it is mundane. */
          const hood = hoodAt(floorDiv(cx, CH), floorDiv(cz, CH));
          const base = hood === 'corridor' ? 0.55 : hood === 'hall' ? 0.35 : 0.12;
          S.anomaly = VB.clamp(base + VB.hashf(cx, cz, 1234) * 0.35, 0, 1);
          VB.emit('room:enter', { cx, cz, kind: hood });
        }
      }
    },
  };
}, 15);
