# SUNSET TERRACE

A first-person Backrooms horror piece built to be indistinguishable from a 1987
camcorder tape that sat in a hot attic for thirty years.

Endless procedurally generated mono-yellow offices, a six-stage VHS signal
chain, and a presence that is never fully shown. **Every pixel, sound and mesh
is generated in code at runtime — there are no external assets.** The only
dependency is Three.js, from a CDN.

---

## Just play it

Open **`index.html`** in any browser. That is the whole game: one self-contained
file. Nothing to install, nothing to build, no server needed.

- **Desktop** — click to start, WASD to move, mouse to look, Shift to run, E to
  interact. If pointer lock is unavailable (an embedded frame will refuse it),
  click-and-drag to look instead.
- **Phone** — left thumb walks, drag anywhere else to look, push the stick to
  the end of its travel to run, tap to interact.

Nothing appears for the first 55 seconds, and the tape degrades the longer you
stay. Sound matters; use headphones.

## Rebuilding from source

`index.html` is generated. The sources are `src/*.js`, concatenated in filename
order.

```sh
node build.mjs              # -> index.html      (Three.js from CDN)
node build.mjs --inline     # -> play.html       (Three.js inlined, works offline)
node build.mjs --artifact   # -> artifact.html   (inlined, no document wrappers)
```

Only `index.html` is committed; the other two are derived and gitignored.

Inlining is not plain concatenation — a second `<script type="module">` cannot
share bindings with the first, so the build rewrites Three's single
`export { … }` statement into a namespace object inside the same module scope.

## Restoring the test tooling

The harnesses drive the *real shipped file* in headless Chromium. They need two
things that are deliberately not committed:

```sh
npm install                 # playwright (dev-only)
mkdir -p vendor && curl -o vendor/three.module.js \
  https://unpkg.com/three@0.160.0/build/three.module.js
```

`vendor/` exists so the harnesses run offline — they intercept the CDN request
and serve this copy, so what gets tested is byte-for-byte what ships.

```sh
node tools/shoot.mjs --out shots/x --at 300        # deterministic frame capture
node tools/shoot.mjs --out shots/x --at 300 --sheet 3x2   # motion contact sheet
node tools/shoot.mjs --perf                        # frame pacing, draw calls
node tools/forensics.mjs                           # VHS signal scorecard
node tools/listen.mjs --sec 10 --out shots/aud     # wav + spectrogram + stats
node tools/walk.mjs                                # collision integrity
node tools/mobile.mjs                              # emulated-phone smoke test
```

`--warp N` advances the game clock N seconds without rendering, so minute-20
tape wear is one command away instead of 70,000 software-rasterised fields.

## How it is put together

`CONTRACT.md` is the real documentation: the module system, the shared state
table, the event bus, the cross-module interfaces, and the authenticity criteria
every subsystem was written against. `CRITIC.md` is the hostile-review protocol.

Each file in `src/` is one module registering into a shared registry, and owns
exactly one concern:

| file | concern |
|---|---|
| `00_core.js` | registry, deterministic spatial RNG, shared state, event bus |
| `10_materials.js` | every surface, generated into a canvas at real physical scale |
| `15_layout.js` | endless procgen, doorways, collision, neighbourhood types |
| `20_lighting.js` | fluorescents, flicker, fog, pooled lights |
| `25_entity.js` | the presence — mostly a state machine, incidentally a mesh |
| `30_player.js` | handheld camera, head bob, breathing, mouse + touch input |
| `40_audio.js` | all sound, synthesised through a modelled tape chain |
| `60_postfx.js` | the VHS pipeline |
| `65_hud.js` | camcorder OSD, burned into the picture before the tape |
| `80_perf.js` | adaptive internal resolution |
| `99_boot.js` | renderer, director, and the 59.94Hz field clock |

Two structural decisions carry most of the authenticity, and both are easy to
undo by accident:

- **The clock.** Simulation runs at 59.94 fields/s and presents 29.97 woven
  frames, so motion *combs*. Silky 60fps is the loudest "this is a game" tell.
- **The signal domain.** The scene lands in an sRGB buffer and the weave stage
  re-encodes once; every stage after that operates on a gamma-encoded signal,
  because that is what a composite chain actually carries. Doing the Y/C split
  in linear light gives the wrong noise distribution and the wrong black lift.

## Known failures

Not a wishlist — these are measured and currently true.

- `tools/forensics.mjs` reports 12/13. The chroma-bandwidth check passes at
  **4.05 against a 4.0 threshold**, which is scene-dependent rather than a real
  margin — treat it as failing.
- **Chroma lag measures 0px where it should be 3–6px.** Ruled out: highlight
  clipping, chroma buffer filtering, the 8-bit quantisation floor, the metric's
  search range, and hard-edged noise blocks. Cause not yet found.
- **The hostile critic pass in `CRITIC.md` has never been run.**
- No blind A/B against real footage was ever performed, and the code should not
  be read as having passed one.
