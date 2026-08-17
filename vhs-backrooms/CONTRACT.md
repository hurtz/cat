# SUNSET TERRACE — build contract

A first-person Backrooms horror piece that must be indistinguishable from a
1987 camcorder tape that sat in a hot attic for thirty years.

Ships as **one self-contained `index.html`**. Three.js comes from a CDN
importmap. **Zero other external assets** — every texture, mesh, sound and
particle is generated in code at runtime.

---

## 1. Repo layout

```
src/00_core.js      registry, RNG, shared state, event bus     [core — do not edit]
src/10_materials.js procedural textures + materials            [materials]
src/15_layout.js    endless procgen geometry + collision       [layout]
src/20_lighting.js  fluorescents, flicker, fog, light pooling  [lighting]
src/25_entity.js    presence, stalking AI, proximity signal    [entity]
src/30_player.js    controls, head bob, sway, interaction      [core — do not edit]
src/40_audio.js     Web Audio synthesis, everything            [audio]
src/60_postfx.js    the VHS pipeline                           [postfx]
src/65_hud.js       camcorder OSD                              [hud]
src/80_perf.js      adaptive quality                           [perf]
src/99_boot.js      renderer, director, field clock            [core — do not edit]
build.mjs           src/*.js -> index.html
tools/shoot.mjs     headless capture harness
```

**You own exactly one file.** Never edit another module's file, `00_core.js`,
`30_player.js`, or `99_boot.js`. If you need something from another module that
the contract doesn't give you, say so in your report instead of reaching in.

## 2. Module shape — mandatory

Each source file contains **exactly one top-level statement**:

```js
VB.def('materials', function (VB, THREE) {
  // ALL your code lives in here. Top-level `const` in your file would collide
  // with other modules — everything is concatenated into one module scope.
  return {
    init() {},            // after all modules constructed, before first frame
    start() {},           // on first user gesture (audio unlock lives here)
    update(dt) {},        // every field: dt = 1/59.94
    lateUpdate(dt) {},    // after all update()s
    resize(w, h) {},      // internal buffer size changed
  };
}, 5); // <- update order, see table
```

Order: materials 5 · player 10 · layout 15 · lighting 20 · entity 25 ·
audio 40 · hud 60 · postfx 70 · perf 90.

Exceptions must not throw — boot catches, but a throwing module is a bug.

## 3. Shared state `VB.S`

Read freely. **Write only the fields your module owns.**

| field | range | owner | meaning |
|---|---|---|---|
| `t` `dt` `frame` | — | boot | game clock, `dt` is `1/59.94` |
| `seed` | u32 | boot | world seed; `world:reseed` fires on change |
| `pos` `yaw` `pitch` | — | player | eye position (Vector3), radians |
| `turn` | 0..1 | player | smoothed angular speed — **drives tracking tears** |
| `move` `running` | 0..1 | player | translation speed |
| `bobPhase` | rad | player | head-bob phase, footfalls at the extremes |
| `cell` | {cx,cz} | layout | current chunk cell |
| `roomPulse` | 0..1 | layout→boot | spikes to 1 on room entry, decays |
| `anomaly` | 0..1 | layout | how geometrically wrong the current space is |
| `prox` | 0..1 | entity | entity proximity |
| `seen` | 0..1 | entity | entity is in frame / has line of sight |
| `stalked` | 0..1 | entity | slow "being followed" build |
| `dread` | 0..1 | boot | overall tension |
| `wear` | 0..1 | boot | cumulative tape degradation (slow, monotonic) |
| `burst` | 0..1 | boot | static burst, decays in ~0.3s |
| `dropout` | 0..1 | boot | momentary signal loss |

Helpers on `VB`: `clamp lerp smoothstep approach(cur,target,rate,dt)
rngFrom(seed) hash2(x,y,salt) hashf(x,y,salt) vnoise1(x,salt) fbm1(x,oct,salt)`.

`VB.approach` is frame-rate independent — use it instead of `+= (a-b)*0.1`.

## 4. Events — `VB.on(name, fn)` / `VB.emit(name, payload)`

| event | payload | emitted by |
|---|---|---|
| `game:start` | — | boot (first gesture) |
| `world:reseed` | seed | harness |
| `player:teleport` | — | harness |
| `player:step` | `{foot, speed, pos}` | player, at each footfall |
| `player:interact` | `{hit}` | player |
| `room:enter` | `{cx, cz, kind}` | layout |
| `entity:spawn` `entity:despawn` | `{pos}` | entity |
| `entity:near` | `{d}` | entity |
| `entity:sighting` | `{strength}` | entity |
| `glitch:burst` | `{amt}` | anyone — postfx + audio both react |
| `light:flicker` | `{pos, amt}` | lighting |

## 5. Cross-module interfaces

**materials** → `VB.mats = { wall, wallLower, carpet, ceiling, ceilTrim,
lightPanel, doorFrame, pillar }` (all `MeshLambertMaterial`-compatible so the
light pool works) and `VB.mats.tex = {…}` raw `THREE.Texture`s. Provide
`VB.mats.variant(kind, n)` returning a stable per-room material variant.

**layout** → `VB.layout = {`
- `CELL` (metres, suggest 2.6) `CEIL` (2.72)
- `solidAt(x, z) -> bool`
- `collide(pos: Vector3, radius) -> void` (mutates pos out of walls)
- `floorY(x,z)` / `ceilY(x,z)`
- `raycastWalls(origin, dir, maxD) -> dist|Infinity` (entity + interaction use this)
- `randomOpenPointNear(x, z, minR, maxR) -> {x,z}|null` (entity spawn)
- `roomKindAt(x,z) -> string`
- `fixtures` — live array of `{pos, on}` ceiling lights for the lighting module
  to bind to; layout pushes/removes as chunks stream.
`}`

**lighting** → `VB.lighting = { buzzAt(x,z) -> 0..1, brightnessAt(x,z) -> 0..1 }`.
Owns `scene.fog`. Binds a fixed-size `PointLight` pool onto `VB.layout.fixtures`.

**entity** → `VB.entity = { pos: Vector3|null, active: bool, dist: number }`.
Writes `S.prox/seen/stalked`.

**audio** → `VB.audio = { unlock(), master: GainNode, ctx, sfx(name, opts),
renderOffline(seconds, stateOverrides) }`. Must not create an `AudioContext`
before `start()`. `renderOffline` rebuilds the same graph inside an
`OfflineAudioContext` (mono, 44100) and resolves a `Float32Array` — that is the
only way anything in this loop can inspect the sound, since nobody here has
ears. Structure the synthesis so one function builds the graph against any
`BaseAudioContext` and both the live path and the offline path call it.

**hud** → `VB.hud = { texture: THREE.CanvasTexture, w, h }`. postfx composites
this **inside** the tape stage so the OSD degrades with the signal, exactly like
burned-in camcorder characters.

**postfx** → `renderField(scene, camera, field)` renders the scene for field
0/1 into its own buffer; `present()` weaves the two fields and runs the full
chain to the canvas; `repaint()` redraws the last presented frame. Boot calls
these — do not call `renderer.render` to the default framebuffer anywhere else.

**perf** → may set `VB.quality` (0..1) and read `VB.renderer.info`; other
modules should check `VB.quality` before doing expensive optional work.

## 6. The aesthetic bible — what "authentic" means

Read this as acceptance criteria, not flavour text. The critics score against it.

### The image is 4:3. Always.
Widescreen is the single loudest "this is a modern game" tell. Boot pillarboxes
the canvas. Never fight it.

### 29.97fps, interlaced
Boot simulates at 59.94 fields/s and presents 29.97 woven frames. Motion must
show **combing** — on a pan, odd and even scanlines disagree, producing a
horizontal feathering on vertical edges. Smooth 60fps motion is disqualifying.

### VHS is a *bandwidth* medium, not a filter
The chain that actually matters, in order:
1. **Luma** band-limited to ~240 lines / ~333 samples per active line: soft,
   but with **overshoot ringing** from the VCR's sharpening circuit — a bright
   halo on the right side of every dark→light edge. Missing ringing is the #1
   giveaway of a fake VHS shader.
2. **Chroma** is ~0.4 MHz — roughly **1/8 the horizontal resolution of luma**.
   Colour smears sideways across ~8–20 pixels, **lags to the right** of the
   luma edge it belongs to, and does not line up with object boundaries.
   Convert to YIQ/YUV, blur *only* the chroma, *only* horizontally.
3. **Chroma noise** — coloured speckle that lives in the dark and mid areas,
   biased to magenta/green, coarse and blocky, not per-pixel white noise.
4. **Luma noise** is *horizontally correlated* — short streaks, not TV snow.
5. **Head-switching noise** — the bottom ~6–10 scanlines of every frame are
   torn: displaced horizontally by a random amount and filled with noise. This
   is on literally every VHS capture ever made and almost no fake ever has it.
6. **Dropouts** — brief bright white horizontal dashes where oxide has shed.
7. **Time-base error** — each scanline horizontally jittered by a fraction of a
   pixel; low-frequency drift makes vertical edges wobble like jelly.
8. **Tracking error** — a band of displaced, noisy lines that travels vertically
   through the frame; worse on movement, on room entry, and as `wear` climbs.
9. **Levels** — blacks lifted and milky (never 0,0,0), highlights clipped and
   blooming, overall low saturation with a warm/green cast, hue drift over time.
10. **Trailing / smear** — bright areas leave a short comet tail to the right.

### The camcorder in front of the tape
Soft focus (a 1987 CCD is not sharp), lateral chromatic aberration in the
corners, heavy vignette, gate weave, auto-exposure **hunting** (walk toward a
bright light, the whole frame darkens a beat late then overshoots back), and
bloom that smears *horizontally* more than vertically.

### The room
Mono-yellow — the wallpaper is `#d8c96a`-ish but **never flat**: vertical
striping, a horizontal chair-rail, uneven damp staining darker toward the floor,
scuffs. Carpet is a slightly different, greyer yellow, damp-stained, with visible
weave at close range. Ceiling: 2x4 mineral-fibre tiles with a metal T-grid, some
sagging, some water-stained brown, some missing. Fluorescent troffers with a
prismatic diffuser, buzzing, a few dead or strobing.
Everything is **too regular and slightly wrong**: doorways that lead into
identical rooms, a corridor that is 30cm too narrow, a room where the ceiling is
40cm too low, a pillar grid that doesn't line up with the walls.

### Sound
Room tone is the star: 120Hz mains hum + its harmonics, fluorescent ballast
buzz that beats slightly against itself, tape hiss with head-thump at the
splice, muffled far-off footfalls that stop when you stop, HVAC rumble, and
distant unintelligible voices run through a formant filter and pitch wobble.
Everything goes through wow & flutter (slow ±0.4% pitch drift) and a band-limit
of roughly 100 Hz – 8 kHz, because that is what a hi-fi-less VHS linear audio
track sounds like. Mono. Always mono.

### The feeling
Nothing jumps out. The entity is **never fully shown** early: a shape at the far
end of a corridor that isn't there when the tracking recovers, a shadow crossing
a doorway 40m away, footsteps that aren't yours. Dread comes from the tape
knowing something the viewer doesn't — glitches that correlate with what's
off-screen.

## 7. Verifying your work

```
node build.mjs
node tools/shoot.mjs --out shots/mine --at 120,900,3600
node tools/shoot.mjs --out shots/motion --at 600 --sheet 3x3 --every 2
node tools/shoot.mjs --perf

node tools/listen.mjs --sec 12 --out shots/aud          # wav + spectrogram + stats
node tools/listen.mjs --sec 12 --state dread=0.9,wear=0.85
```

`--warp N` jumps the game clock N seconds with no rendering, so minute-20 tape
wear is one command away rather than 70000 software-rasterised fields.

Then **`Read` the PNGs you produced** and judge them with your own eyes. A module
that has never been looked at is not finished. `--at` counts fields
(1/59.94 s each), so `--at 3600` is one minute in — use it to check `wear`.

Exit code is non-zero if the page logged any error. Keep it at zero.
