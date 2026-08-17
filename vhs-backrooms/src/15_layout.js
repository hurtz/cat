/* ============================================================================
   LAYOUT — endless procedural office. Chunk-streamed, fully deterministic from
   (seed, chunk coords), so walking a circle brings you back to the same room
   and there is nothing to "remember".

   Solidity is decided per world cell. Rooms come from a per-chunk BSP; chunk
   seams are decided by a hash of the shared edge so both sides agree.
   ========================================================================== */
VB.def('layout', function (VB, THREE) {
  const S = VB.S;

  const CELL = 2.6;          // metres per grid cell
  const CEIL = 2.72;         // ceiling height
  const CH = 8;              // cells per chunk edge
  const RADIUS = 2;          // chunks streamed around the player

  const chunks = new Map();  // "cx,cz" -> {group, solids:Uint8Array, fixtures:[]}
  const solidCache = new Map();
  const fixtures = [];
  let lastCell = null, lastRoomId = -1;

  const key = (a, b) => a + ',' + b;
  const floorDiv = (a, b) => Math.floor(a / b);

  /* ------------------------------------------------------- chunk solidity */
  /* Returns Uint8Array(CH*CH): 1 = solid. Cached. */
  function chunkSolids(gx, gz) {
    const k = key(gx, gz);
    let s = solidCache.get(k);
    if (s) return s;
    s = new Uint8Array(CH * CH);
    const R = VB.rngFrom(VB.hash2(gx, gz, S.seed));

    /* BSP: split the chunk into rooms with 1-cell walls and cut doorways. */
    const walls = [];
    (function split(x0, z0, x1, z1, depth) {
      const w = x1 - x0, h = z1 - z0;
      if (depth > 3 || (w < 4 && h < 4) || R() < 0.11) return;
      const vertical = w === h ? R() < 0.5 : w > h;
      if (vertical) {
        if (w < 4) return;
        const cut = x0 + 1 + Math.floor(R() * (w - 2));
        walls.push({ v: 1, at: cut, a: z0, b: z1 });
        split(x0, z0, cut, z1, depth + 1);
        split(cut + 1, z0, x1, z1, depth + 1);
      } else {
        if (h < 4) return;
        const cut = z0 + 1 + Math.floor(R() * (h - 2));
        walls.push({ v: 0, at: cut, a: x0, b: x1 });
        split(x0, z0, x1, cut, depth + 1);
        split(x0, cut + 1, x1, z1, depth + 1);
      }
    })(0, 0, CH, CH, 0);

    for (const w of walls) {
      const len = w.b - w.a;
      /* one or two doorways per wall run */
      const doors = [w.a + 1 + Math.floor(R() * Math.max(1, len - 2))];
      if (len > 5 && R() < 0.45) doors.push(w.a + 1 + Math.floor(R() * Math.max(1, len - 2)));
      for (let i = w.a; i < w.b; i++) {
        if (doors.indexOf(i) >= 0) continue;
        const x = w.v ? w.at : i, z = w.v ? i : w.at;
        if (x >= 0 && x < CH && z >= 0 && z < CH) s[z * CH + x] = 1;
      }
    }

    /* Seam walls: both neighbouring chunks derive these from the same hash, so
       they always agree and rooms read as continuous across the boundary. */
    for (let i = 0; i < CH; i++) {
      if (VB.hashf(gx, gz * CH + i, 8081) < 0.30 && VB.hashf(gx, gz * CH + i, 91) > 0.16) s[i * CH + 0] = 1;
      if (VB.hashf(gx * CH + i, gz, 4405) < 0.30 && VB.hashf(gx * CH + i, gz, 77) > 0.16) s[0 * CH + i] = 1;
    }

    /* Pillars in the wide-open parts — the load-bearing grid that no office
       this shape would ever actually need. */
    for (let z = 1; z < CH - 1; z++) {
      for (let x = 1; x < CH - 1; x++) {
        const wx = gx * CH + x, wz = gz * CH + z;
        if (((wx % 4) + 4) % 4 === 2 && ((wz % 4) + 4) % 4 === 2 && VB.hashf(wx, wz, 5150) < 0.5) {
          let open = true;
          for (let d = 0; d < 4; d++) {
            const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), nz = z + (d === 2 ? 1 : d === 3 ? -1 : 0);
            if (s[nz * CH + nx]) { open = false; break; }
          }
          if (open) s[z * CH + x] = 2;   // 2 = pillar (solid, but narrower)
        }
      }
    }

    solidCache.set(k, s);
    if (solidCache.size > 400) solidCache.delete(solidCache.keys().next().value);
    return s;
  }

  function solidAtCell(wx, wz) {
    const gx = floorDiv(wx, CH), gz = floorDiv(wz, CH);
    const s = chunkSolids(gx, gz);
    return s[(wz - gz * CH) * CH + (wx - gx * CH)];
  }
  function solidAt(x, z) { return solidAtCell(Math.floor(x / CELL), Math.floor(z / CELL)) > 0; }

  /* -------------------------------------------------------------- meshing */
  function buildChunk(gx, gz) {
    const s = chunkSolids(gx, gz);
    const ox = gx * CH * CELL, oz = gz * CH * CELL;
    const group = new THREE.Group();
    const localFixtures = [];

    /* floor + ceiling planes for the whole chunk */
    const span = CH * CELL;
    const fg = new THREE.PlaneGeometry(span, span);
    fg.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(fg, VB.mats.carpet);
    floor.position.set(ox + span / 2, 0, oz + span / 2);
    const cg = new THREE.PlaneGeometry(span, span);
    cg.rotateX(Math.PI / 2);
    const ceil = new THREE.Mesh(cg, VB.mats.ceiling);
    ceil.position.set(ox + span / 2, CEIL, oz + span / 2);
    /* uv tiling: carpet repeats per 2 cells, ceiling texture holds 2x2 tiles */
    for (const [m, rep] of [[floor, CH / 2], [ceil, CH / 2]]) {
      const uv = m.geometry.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rep, uv.getY(i) * rep);
      uv.needsUpdate = true;
    }
    group.add(floor, ceil);

    /* wall faces — emit only the faces that border an open cell */
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
        const inset = kind === 2 ? 0.62 : 0;          // pillars are narrower
        const x0 = ox + x * CELL + inset * CELL * 0.5, x1 = ox + (x + 1) * CELL - inset * CELL * 0.5;
        const z0 = oz + z * CELL + inset * CELL * 0.5, z1 = oz + (z + 1) * CELL - inset * CELL * 0.5;
        const h = CEIL;
        for (let d = 0; d < 4; d++) {
          const nx = x + DIRS[d][0], nz = z + DIRS[d][1];
          const nSolid = (nx >= 0 && nx < CH && nz >= 0 && nz < CH)
            ? s[nz * CH + nx] : solidAtCell(gx * CH + nx, gz * CH + nz);
          if (nSolid && kind !== 2) continue;                 // interior face, skip
          const uw = (d < 2 ? (z1 - z0) : (x1 - x0)) / CELL;
          const u0 = (d < 2 ? z0 : x0) / CELL;
          if (d === 0) quad(x1, 0, z1, x1, 0, z0, x1, h, z0, x1, h, z1, 1, 0, 0, u0, 0, u0 + uw, 1);
          else if (d === 1) quad(x0, 0, z0, x0, 0, z1, x0, h, z1, x0, h, z0, -1, 0, 0, u0, 0, u0 + uw, 1);
          else if (d === 2) quad(x0, 0, z1, x1, 0, z1, x1, h, z1, x0, h, z1, 0, 0, 1, u0, 0, u0 + uw, 1);
          else quad(x1, 0, z0, x0, 0, z0, x0, h, z0, x1, h, z0, 0, 0, -1, u0, 0, u0 + uw, 1);
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

    /* light troffers, on a grid, mostly in open cells, some dead */
    const panelGeo = new THREE.PlaneGeometry(1.16, 0.58);
    panelGeo.rotateX(Math.PI / 2);
    for (let z = 0; z < CH; z++) {
      for (let x = 0; x < CH; x++) {
        const wx = gx * CH + x, wz = gz * CH + z;
        if (((wx % 3) + 3) % 3 !== 1 || ((wz % 3) + 3) % 3 !== 1) continue;
        if (s[z * CH + x]) continue;
        const px = ox + (x + 0.5) * CELL, pz = oz + (z + 0.5) * CELL;
        const dead = VB.hashf(wx, wz, 616) < 0.10;
        const m = new THREE.Mesh(panelGeo, VB.mats.lightPanel.clone());
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
        if (!chunks.has(k)) { buildChunk(gx + dx, gz + dz); return; }  // one per frame
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
  const _v = new THREE.Vector3();
  function collide(p, r) {
    for (let axis = 0; axis < 2; axis++) {
      const c = axis === 0 ? p.x : p.z;
      const oc = axis === 0 ? p.z : p.x;
      const ci = Math.floor(c / CELL), oi = Math.floor(oc / CELL);
      for (let d = -1; d <= 1; d++) {
        for (let e = -1; e <= 1; e++) {
          const cx = axis === 0 ? ci + d : oi + e;
          const cz = axis === 0 ? oi + e : ci + d;
          const kind = solidAtCell(cx, cz);
          if (!kind) continue;
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

  /* --------------------------------------------------------- grid raycast */
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

  /* Open on a view, never nose-first into a wall: take the roomiest cell near
     the origin and face it down its longest clear run. */
  function spawn() {
    let best = null;
    for (let z = -6; z <= 6; z++) {
      for (let x = -6; x <= 6; x++) {
        if (solidAtCell(x, z)) continue;
        let open = 0;
        for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) if (!solidAtCell(x + a, z + b)) open++;
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
        CELL, CEIL, CH,
        solidAt, collide, raycastWalls, randomOpenPointNear,
        floorY: () => 0,
        ceilY: () => CEIL,
        roomKindAt: (x, z) => 'office',
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
        /* "room" identity = flood region id approximated by a coarse hash */
        const rid = VB.hash2(floorDiv(cx, 3), floorDiv(cz, 3), 9);
        if (rid !== lastRoomId) {
          lastRoomId = rid;
          S.anomaly = VB.hashf(cx, cz, 1234) * 0.6;
          VB.emit('room:enter', { cx, cz, kind: 'office' });
        }
      }
    },
  };
}, 15);
