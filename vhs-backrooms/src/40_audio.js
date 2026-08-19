/* ============================================================================
   AUDIO — every sound in this piece is synthesised at runtime. There are no
   assets and there never will be.

   The model is deliberately physical rather than "a bunch of sfx":

     1. A ROOM exists. It has mains hum, fluorescent ballasts, an air handler,
        a carpeted reverberant corridor, and things moving in it.
     2. A CAMCORDER MIC hears that room, mono, badly.
     3. A 1987 VHS LINEAR AUDIO TRACK records it: ~100Hz-8kHz, wow & flutter,
        soft saturation, hiss, dropouts, head thumps.
     4. The tape has been sitting in an attic for thirty years, so as `S.wear`
        climbs every one of those defects gets worse.

   Signal flow (all mono, all of it):

     hum ┐
     buzz ┤
     hvac ┼─ bedSum ─ bedDuck ─┐
     hand ┘                    │
                               ├─ program ─ wow/flutter delay ─ saturator ─
     steps  ┐                  │            ─ tape EQ (HP x2, LP x4) ─
     farsteps├─ dry + reverb ──┘              ─ glitch LP ─ dropGain ─ jumpGain ─┐
     voices ┘                                                                    │
                                                                                 ├─ master ─ dest
     hiss ──── hiss EQ ─────────────────────────────────────────────────────────┤
     thump/splice ──── HP30 ────────────────────────────────────────────────────┘

   Hiss and head thumps sit OUTSIDE the program dropout gain on purpose: when
   the signal drops out you are left with bare tape noise, which is what a real
   dropout sounds like and is far more unsettling than silence.

   ONE function — buildGraph(ctx) — builds all of that against any
   BaseAudioContext. The live path and renderOffline() both call it, and both
   drive it through the same director, so what the spectrogram shows is what
   the player hears.
   ========================================================================== */
VB.def('audio', function (VB, THREE) {
  const S = VB.S;
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ---------------------------------------------------- param scheduling --
     Wrapped because a throwing AudioParam would take the whole frame with it,
     and because live and offline must use the exact same calls. */
  function sv(p, v, t) { try { p.setValueAtTime(v, t > 0 ? t : 0); } catch (e) { } }
  function lr(p, v, t) { try { p.linearRampToValueAtTime(v, t > 0 ? t : 0); } catch (e) { } }
  function er(p, v, t) { try { p.exponentialRampToValueAtTime(v > 1e-5 ? v : 1e-5, t > 0 ? t : 0); } catch (e) { } }

  /* percussive envelope on a gain node: silence -> peak -> exponential decay */
  function env(g, t, peak, atk, dec) {
    sv(g.gain, 0.0001, t);
    lr(g.gain, peak, t + atk);
    er(g.gain, 0.0001, t + atk + dec);
    sv(g.gain, 0, t + atk + dec + 0.005);
  }

  /* =========================================================== NOISE BEDS ==
     Looped buffers, not ScriptProcessor / AudioWorklet: worklets need a module
     URL (dead in a single-file build) and ScriptProcessor does not run inside
     an OfflineAudioContext at all, which would make the whole thing
     un-inspectable. Buffers are deterministic from a seed so every offline
     render is bit-reproducible. */

  /* White. No loop click is possible — white noise has no correlation to break. */
  function whiteBuf(ctx, sec, seed) {
    const r = VB.rngFrom(seed >>> 0);
    const N = Math.max(64, Math.floor(sec * ctx.sampleRate));
    const b = ctx.createBuffer(1, N, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < N; i++) d[i] = r() * 2 - 1;
    return b;
  }

  /* Brown / red. Leaky random walk -> ~ -6dB/oct above 10Hz. This one WOULD
     click at the loop point, so the tail is crossfaded into the head. */
  function brownBuf(ctx, sec, seed) {
    const r = VB.rngFrom(seed >>> 0), sr = ctx.sampleRate;
    const N = Math.max(64, Math.floor(sec * sr));
    const f = Math.min(N >> 1, Math.floor(sr * 0.5));
    const tmp = new Float32Array(N + f);
    let v = 0;
    for (let i = 0; i < N + f; i++) { v = v * 0.99855 + (r() * 2 - 1) * 0.05; tmp[i] = v; }
    const b = ctx.createBuffer(1, N, sr), d = b.getChannelData(0);
    for (let i = 0; i < N; i++) d[i] = tmp[i];
    for (let i = 0; i < f; i++) { const w = i / f; d[i] = tmp[i] * w + tmp[N + i] * (1 - w); }
    let mx = 1e-6;
    for (let i = 0; i < N; i++) { const a = Math.abs(d[i]); if (a > mx) mx = a; }
    const g = 0.9 / mx;
    for (let i = 0; i < N; i++) d[i] *= g;
    return b;
  }

  /* --------------------------------------------------------------- the room
     A long, dark, carpeted impulse. Early reflections spaced for 2.6m cells
     and a 2.72m ceiling; the diffuse tail is progressively low-passed because
     mineral fibre tile and damp carpet eat treble long before they eat bass. */
  function corridorIR(ctx, seed) {
    const r = VB.rngFrom(seed >>> 0), sr = ctx.sampleRate;
    const LEN = 1.85, RT60 = 1.42;
    const N = Math.floor(LEN * sr);
    const b = ctx.createBuffer(1, N, sr), d = b.getChannelData(0);
    let lp = 0;
    for (let i = 0; i < N; i++) {
      const t = i / sr;
      const decay = Math.exp(-6.9078 * t / RT60);
      /* build-up: a real room's tail swells for the first ~25ms */
      const build = t < 0.022 ? t / 0.022 : 1;
      const cut = 240 + 3000 * Math.exp(-t * 1.35);
      const a = Math.exp(-TAU * cut / sr);
      lp = lp * a + (r() * 2 - 1) * (1 - a);
      d[i] = lp * decay * build * 3.4;
    }
    /* discrete early reflections: wall / wall / ceiling / far wall */
    const early = [[0.0068, 0.42], [0.0142, 0.34], [0.0187, 0.30], [0.0271, 0.25],
    [0.0352, 0.21], [0.0468, 0.17], [0.0611, 0.13], [0.0824, 0.10]];
    for (let k = 0; k < early.length; k++) {
      const i = Math.floor(early[k][0] * sr);
      const s = r() < 0.5 ? -1 : 1;
      /* smear each reflection over ~1ms so it is not a raw click */
      for (let j = 0; j < 48 && i + j < N; j++) d[i + j] += s * early[k][1] * (1 - j / 48) * (r() * 0.6 + 0.7) * 0.25;
    }
    return b;
  }

  /* --------------------------------------------------------- periodic waves
     A magnetic fluorescent ballast is a saturating iron-core inductor buzzing
     at twice mains: 120Hz fundamental, strong ODD harmonics (360, 600, 840,
     1080...) from the symmetric flux clipping, plus small even ones from core
     asymmetry. A pure 120Hz sine is the "fake hum" tell. */
  function ballastWave(ctx) {
    const N = 24;
    const re = new Float32Array(N), im = new Float32Array(N);
    const A = { 1: 1.00, 2: 0.145, 3: 0.44, 4: 0.062, 5: 0.255, 6: 0.038, 7: 0.165, 8: 0.024,
      9: 0.100, 10: 0.016, 11: 0.062, 13: 0.040, 15: 0.026, 17: 0.017, 19: 0.011, 21: 0.008 };
    for (const k in A) if (+k < N) im[+k] = A[k];
    return ctx.createPeriodicWave(re, im, { disableNormalization: true });
  }
  /* Pulse-ish modulator: the ballast strikes the arc twice per mains cycle, so
     the buzz is amplitude-gated by a narrow pulse train, not a sine. */
  function pulseWave(ctx) {
    const N = 14;
    const re = new Float32Array(N), im = new Float32Array(N);
    for (let k = 1; k < N; k++) im[k] = 1 / Math.pow(k, 0.72);
    return ctx.createPeriodicWave(re, im, { disableNormalization: true });
  }

  /* ------------------------------------------------------------- saturation
     Odd-symmetric tanh so it cannot generate DC. Drive is applied with a
     pre-gain rather than by swapping the curve, because swapping a WaveShaper
     curve mid-stream clicks. */
  function satCurve() {
    const n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 1.9) / Math.tanh(1.9);
    }
    return c;
  }

  /* ======================================================== GRAPH BUILDER ==
     Everything below runs identically in an AudioContext and an
     OfflineAudioContext. Nothing here reads VB.S — the director feeds it. */
  function buildGraph(ctx, seed) {
    seed = seed >>> 0;
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const bq = (type, f, q, gain) => {
      const n = ctx.createBiquadFilter();
      n.type = type; n.frequency.value = f; n.Q.value = q == null ? 0.7 : q;
      if (gain != null) n.gain.value = gain;
      return n;
    };
    const src = (buf, rate, loop) => {
      const n = ctx.createBufferSource();
      n.buffer = buf; n.loop = loop !== false;
      if (rate != null) n.playbackRate.value = rate;
      return n;
    };

    const rig = { ctx, seed, starters: [], p: {}, rng: VB.rngFrom(seed ^ 0xA5A5) };

    /* shared buffers (per-context: AudioBuffers are not portable across
       contexts with different sample rates) */
    const NW = whiteBuf(ctx, 8.0, seed ^ 0x1111);      // hiss / general white
    const NW2 = whiteBuf(ctx, 5.3, seed ^ 0x2222);     // decorrelated white
    const NS = whiteBuf(ctx, 2.7, seed ^ 0x3333);      // one-shot source
    const NB = brownBuf(ctx, 6.1, seed ^ 0x4444);      // rumble / slow drift
    rig.NW = NW; rig.NS = NS; rig.NB = NB;

    /* ------------------------------------------------------------ MASTER */
    const master = g(0.0);            // faded in by start()
    rig.master = master;
    master.channelCount = 1;
    master.channelCountMode = 'explicit';
    master.channelInterpretation = 'speakers';
    /* Safety soft-clip: transparent below ~0.7, catches a stacked transient
       without the pumping a compressor would add. It is AFTER the tape LP so
       it can generate a little >8k grit — hence the 11kHz cleanup pole. */
    const clip = ctx.createWaveShaper();
    clip.curve = (function () {
      const n = 2048, c = new Float32Array(n);
      for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 1.25) / Math.tanh(1.25); }
      return c;
    })();
    clip.oversample = '2x';
    const cleanup = bq('lowpass', 11000, 0.6);
    master.connect(clip); clip.connect(cleanup); cleanup.connect(ctx.destination);

    /* ============================================================ THE TAPE */
    /* program bus -> wow/flutter -> saturation -> band-limit -> dropouts */
    const program = g(1.0);
    rig.program = program;

    /* --- wow & flutter: a modulated delay is a Doppler pitch shifter.
       pitch deviation = 2*pi*f*depth, so ±0.4% at 0.31Hz needs ~2.05ms. */
    const wow = ctx.createDelay(0.25);
    wow.delayTime.value = 0.020;
    const wowOsc = ctx.createOscillator(); wowOsc.type = 'sine'; wowOsc.frequency.value = 0.312;
    const wowG = g(0.00205);                                  // ±0.40% @ 0.312Hz
    const wow2Osc = ctx.createOscillator(); wow2Osc.type = 'sine'; wow2Osc.frequency.value = 0.734;
    const wow2G = g(0.00054);                                 // ±0.25% @ 0.734Hz
    const flutOsc = ctx.createOscillator(); flutOsc.type = 'sine'; flutOsc.frequency.value = 6.83;
    const flutG = g(0.000030);                                // ±0.13% @ 6.83Hz
    const scrapeOsc = ctx.createOscillator(); scrapeOsc.type = 'sine'; scrapeOsc.frequency.value = 29.4;
    const scrapeG = g(0.0000035);                             // capstan scrape
    /* an unrepeating slow drift so the wow never sounds like an LFO */
    const driftSrc = src(NB, 0.017, true);
    const driftG = g(0.0016);
    /* event-driven pitch lurches (splices, glitch tears) live on their own
       ConstantSource so the continuous tick can never fight them */
    const lurch = ctx.createConstantSource(); lurch.offset.value = 0;
    wowOsc.connect(wowG); wow2Osc.connect(wow2G); flutOsc.connect(flutG);
    scrapeOsc.connect(scrapeG); driftSrc.connect(driftG);
    wowG.connect(wow.delayTime); wow2G.connect(wow.delayTime); flutG.connect(wow.delayTime);
    scrapeG.connect(wow.delayTime); driftG.connect(wow.delayTime); lurch.connect(wow.delayTime);
    rig.starters.push(wowOsc, wow2Osc, flutOsc, scrapeOsc, driftSrc, lurch);

    /* --- soft saturation */
    const satPre = g(1.0);
    const sat = ctx.createWaveShaper();
    sat.curve = satCurve(); sat.oversample = '2x';
    const satPost = g(1.0);

    /* --- the band-limit that IS VHS linear audio: ~100Hz - 8kHz.
       Two poles up top, four poles down top-end (24dB/oct) with a slight Q
       lift on the last stage for the little resonant shelf real decks have. */
    const hp1 = bq('highpass', 76, 0.55);
    const hp2 = bq('highpass', 92, 0.85);
    const lp1 = bq('lowpass', 7400, 0.51);
    const lp2 = bq('lowpass', 7400, 0.62);
    const lp3 = bq('lowpass', 7400, 0.95);
    const lp4 = bq('lowpass', 7400, 1.45);
    /* a mid presence dip — VHS linear audio is notably scooped */
    const scoop = bq('peaking', 2400, 1.1, -2.6);

    /* --- event-owned bandwidth collapse (glitch bursts, tape tears) */
    const glitchLP = bq('lowpass', 20000, 0.7);
    /* --- event-owned gain stages: dropouts and level jumps */
    const dropGain = g(1.0);
    const jumpGain = g(1.0);

    program.connect(wow); wow.connect(satPre); satPre.connect(sat); sat.connect(satPost);
    satPost.connect(hp1); hp1.connect(hp2); hp2.connect(lp1); lp1.connect(lp2);
    lp2.connect(lp3); lp3.connect(lp4); lp4.connect(scoop); scoop.connect(glitchLP);
    glitchLP.connect(dropGain); dropGain.connect(jumpGain); jumpGain.connect(master);

    /* ====================================================== ROOM REVERB ====
       Inside the program bus: the room reverberates, THEN the tape records it.
       Only positional sources are sent — hum/hiss/hvac are everywhere at once
       and reverberating them just turns the bed to mud. */
    const conv = ctx.createConvolver();
    conv.buffer = corridorIR(ctx, seed ^ 0x7777);
    conv.normalize = true;
    const revIn = g(1.0);
    const revOut = g(0.34);
    const revTone = bq('lowpass', 2600, 0.7);     // the far end of the corridor is dark
    const revHP = bq('highpass', 150, 0.7);
    revIn.connect(conv); conv.connect(revHP); revHP.connect(revTone);
    revTone.connect(revOut); revOut.connect(program);
    rig.revIn = revIn;

    /* ========================================================= ROOM TONE ====
       The star. Four continuous layers, summed into a duckable bed. */
    const bedSum = g(1.0);
    const bedDuck = g(1.0);           // event-owned: the air goes out of the room
    bedSum.connect(bedDuck); bedDuck.connect(program);

    /* --- 1. mains hum: 120Hz + odd harmonics, two slightly-detuned ballasts
       so the hum beats against itself at ~0.35Hz. */
    const bw = ballastWave(ctx);
    const humA = ctx.createOscillator(); humA.setPeriodicWave(bw); humA.frequency.value = 120.0;
    const humB = ctx.createOscillator(); humB.setPeriodicWave(bw); humB.frequency.value = 119.63;
    const humBg = g(0.42);
    const humTilt = bq('lowpass', 2100, 0.7);   // the upper harmonics are softer
    const humGain = g(0.050);
    /* mains frequency is not stable — nudge it around with the slow drift */
    const mainsDrift = src(NB, 0.0071, true);
    const mainsDG = g(0.35);
    mainsDrift.connect(mainsDG); mainsDG.connect(humA.frequency); mainsDG.connect(humB.frequency);
    humA.connect(humTilt); humB.connect(humBg); humBg.connect(humTilt);
    humTilt.connect(humGain); humGain.connect(bedSum);
    rig.starters.push(humA, humB, mainsDrift);

    /* --- 2. fluorescent ballast buzz: narrow-band noise gated by a 120Hz
       pulse train. Two voices at 119.4 / 120.9 Hz so they beat against each
       other about 1.5 times a second — the sound of two fixtures not agreeing.
       Level is driven by VB.lighting.buzzAt(). */
    const pw = pulseWave(ctx);
    function buzzVoice(nb, rate, cf, q, modHz, depth, base) {
      const n = src(nb, rate, true);
      const bp = bq('bandpass', cf, q);
      const am = g(base);
      const mo = ctx.createOscillator(); mo.setPeriodicWave(pw); mo.frequency.value = modHz;
      const mg = g(depth);
      n.connect(bp); bp.connect(am); mo.connect(mg); mg.connect(am.gain);
      rig.starters.push(n, mo);
      return am;
    }
    const buzzSum = g(1.0);
    buzzVoice(NW, 1.0, 1720, 2.6, 119.42, 0.55, 0.30).connect(buzzSum);
    buzzVoice(NW2, 0.93, 3180, 3.4, 120.87, 0.50, 0.24).connect(buzzSum);
    buzzVoice(NW2, 1.17, 620, 1.9, 240.31, 0.42, 0.22).connect(buzzSum);   // the low growl
    const buzzTone = bq('highpass', 380, 0.6);
    const buzzGain = g(0.030);
    buzzSum.connect(buzzTone); buzzTone.connect(buzzGain); buzzGain.connect(bedSum);

    /* --- 3. HVAC: a big air handler four floors away, through ductwork.
       Brown noise resonated at ~105Hz plus a slow-moving duct-hiss band. */
    const hvSrc = src(NB, 0.61, true);
    const hvLP1 = bq('lowpass', 240, 0.7);
    const hvLP2 = bq('lowpass', 152, 1.7);          // the resonant "throb"
    const hvGain = g(0.20);
    hvSrc.connect(hvLP1); hvLP1.connect(hvLP2); hvLP2.connect(hvGain); hvGain.connect(bedSum);
    /* very slow breathing of the fan */
    const hvLfo = ctx.createOscillator(); hvLfo.type = 'sine'; hvLfo.frequency.value = 0.043;
    const hvLfoG = g(0.045);
    hvLfo.connect(hvLfoG); hvLfoG.connect(hvGain.gain);
    /* moving air in the diffuser above your head */
    const airSrc = src(NW, 0.79, true);
    const airBP = bq('bandpass', 480, 0.55);
    const airLP = bq('lowpass', 1100, 0.7);
    const airGain = g(0.020);
    airSrc.connect(airBP); airBP.connect(airLP); airLP.connect(airGain); airGain.connect(bedSum);
    const airLfo = ctx.createOscillator(); airLfo.type = 'sine'; airLfo.frequency.value = 0.071;
    const airLfoG = g(220);
    airLfo.connect(airLfoG); airLfoG.connect(airBP.frequency);
    rig.starters.push(hvSrc, hvLfo, airSrc, airLfo);

    /* --- 4. camcorder handling noise: the operator's hand on a plastic body
       and a nylon jacket sleeve. Driven by turn/move. This is one of the
       loudest signatures of real handheld footage and costs almost nothing. */
    const hndSrc = src(NW2, 0.41, true);
    const hndLP = bq('lowpass', 420, 0.9);
    const hndHP = bq('highpass', 110, 0.7);
    const hndGain = g(0.0);
    hndSrc.connect(hndHP); hndHP.connect(hndLP); hndLP.connect(hndGain); hndGain.connect(bedSum);
    rig.starters.push(hndSrc);

    /* ============================================================== HISS ====
       Outside the program dropout gain, band-limited on its own, so it is a
       true constant noise floor that survives every dropout. Two decorrelated
       sources at incommensurate rates so the 8s loop never reveals itself. */
    const hsA = src(NW, 1.0, true);
    const hsB = src(NW2, 0.8709, true);
    const hsMix = g(1.0);
    const hsHP = bq('highpass', 900, 0.6);
    const hsTilt = bq('highshelf', 3200, 0.7, 3.5);     // tape noise leans bright
    const hsLP1 = bq('lowpass', 7600, 0.6);
    const hsLP2 = bq('lowpass', 7600, 0.9);
    const hsLP3 = bq('lowpass', 7600, 1.3);
    const hissGain = g(0.012);
    hsA.connect(hsMix); hsB.connect(hsMix);
    hsMix.connect(hsHP); hsHP.connect(hsTilt); hsTilt.connect(hsLP1);
    hsLP1.connect(hsLP2); hsLP2.connect(hsLP3); hsLP3.connect(hissGain); hissGain.connect(master);
    /* slow "modulation noise" — the hiss breathes as the oxide passes */
    const hsMod = src(NB, 0.031, true);
    const hsModG = g(0.0035);
    hsMod.connect(hsModG); hsModG.connect(hissGain.gain);
    rig.starters.push(hsA, hsB, hsMod);

    /* ============================================== HEAD / SPLICE THUMPS ====
       Mechanical, generated at the head, so also outside the program gain.
       Only lightly high-passed: a head thump is exactly the sub-100Hz event
       that DOES get through a VHS linear track. */
    const thumpBus = g(1.0);
    const thumpHP = bq('highpass', 33, 0.7);
    const thumpLP = bq('lowpass', 2400, 0.7);
    thumpBus.connect(thumpHP); thumpHP.connect(thumpLP); thumpLP.connect(master);
    rig.thumpBus = thumpBus;

    /* ------------------------------------------------------------ handles */
    rig.p = {
      humGain, buzzGain, hvGain, airGain, hissGain, hndGain,
      wowG, wow2G, flutG, driftG, lurch,
      satPre, satPost, hp1, hp2, lp1, lp2, lp3, lp4, scoop,
      hsLP1, hsLP2, hsLP3, hsHP,
      glitchLP, dropGain, jumpGain, bedDuck, revOut, revTone, master,
      humA, humB, buzzTone,
    };

    rig.start = function (t0) {
      for (let i = 0; i < rig.starters.length; i++) {
        try { rig.starters[i].start(t0); } catch (e) { }
      }
      /* 25ms fade so the graph does not begin with a step discontinuity */
      sv(master.gain, 0, t0);
      lr(master.gain, 0.92, t0 + 0.025);
      rig.t0 = t0;
    };
    return rig;
  }

  /* ============================================================== EVENTS ====
     Every one-shot builds its own short-lived subgraph. Chrome reclaims
     finished OscillatorNodes / AudioBufferSourceNodes automatically once they
     have stopped and nothing references them. */

  function noiseSrc(rig, t, dur, rate) {
    const ctx = rig.ctx;
    const n = ctx.createBufferSource();
    n.buffer = rig.NS;
    n.loop = true;
    n.playbackRate.value = rate || 1;
    /* random start offset so no two bursts are the same noise */
    const off = rig.rng() * (rig.NS.duration - 0.05);
    try { n.start(t, off); n.stop(t + dur + 0.02); } catch (e) { }
    return n;
  }
  function osc(rig, t, dur, type, f) {
    const o = rig.ctx.createOscillator();
    o.type = type; o.frequency.value = f;
    try { o.start(t); o.stop(t + dur + 0.02); } catch (e) { }
    return o;
  }
  function bqf(rig, type, f, q, gain) {
    const n = rig.ctx.createBiquadFilter();
    n.type = type; n.frequency.value = f; n.Q.value = q == null ? 0.7 : q;
    if (gain != null) n.gain.value = gain;
    return n;
  }
  function gn(rig, v) { const n = rig.ctx.createGain(); n.gain.value = v; return n; }

  /* ---------------------------------------------------------- FOOTSTEP ----
     Damp office carpet over concrete. Three parts, all randomised:
       body  — dull filtered noise thud, the heel compressing the pile
       floor — a short low sine, the slab underneath
       scuff — a late, quiet band of fibre noise, the sole dragging off
     Nothing here is ever identical twice: filter, level, decay, timing and
     the scuff's delay are all re-rolled per step. */
  function stepSound(rig, t, o) {
    const R = rig.rng;
    const spd = clamp((o.speed == null ? 2.0 : o.speed) / 2.35, 0.15, 1.9);
    const lvl = (o.gain == null ? 1 : o.gain) * (0.30 + spd * 0.42);
    const foot = o.foot ? 1 : 0;
    /* left and right shoes are not the same shoe */
    const asym = foot ? 1.09 : 0.93;

    /* body */
    const bDur = 0.085 + R() * 0.055;
    const nb = noiseSrc(rig, t, bDur + 0.05, 0.7 + R() * 0.6);
    const bLP = bqf(rig, 'lowpass', (300 + R() * 190) * asym * (0.85 + spd * 0.30), 1.15);
    const bHP = bqf(rig, 'highpass', 70 + R() * 40, 0.7);
    const bG = gn(rig, 0);
    nb.connect(bHP); bHP.connect(bLP); bLP.connect(bG);
    env(bG, t, lvl * (0.55 + R() * 0.25), 0.0035 + R() * 0.004, bDur);

    /* slab */
    const fF = (74 + R() * 30) * asym;
    const fo = osc(rig, t, 0.14, 'sine', fF);
    sv(fo.frequency, fF, t); er(fo.frequency, fF * 0.72, t + 0.10);
    const fG = gn(rig, 0);
    fo.connect(fG);
    env(fG, t, lvl * (0.20 + R() * 0.14), 0.004, 0.075 + R() * 0.045);

    /* scuff — starts a little after the impact, as the foot rolls */
    const sDel = 0.012 + R() * 0.030;
    const sDur = 0.09 + R() * 0.11;
    const ns = noiseSrc(rig, t + sDel, sDur + 0.05, 0.8 + R() * 0.7);
    const sBP = bqf(rig, 'bandpass', (1150 + R() * 1250) * asym, 0.75);
    const sG = gn(rig, 0);
    ns.connect(sBP); sBP.connect(sG);
    /* a scuff has a slow attack — it is friction, not impact */
    env(sG, t + sDel, lvl * (0.10 + R() * 0.13) * (0.5 + spd), 0.012 + R() * 0.020, sDur);

    const out = gn(rig, 1.0);
    bG.connect(out); fG.connect(out); sG.connect(out);
    out.connect(rig.program);
    const send = gn(rig, 0.16 + R() * 0.10);
    out.connect(send); send.connect(rig.revIn);
  }

  /* ------------------------------------------------- FOOTSTEPS THAT ARE NOT
     YOURS. The single most effective thing in this file.

     Physically: same event, but forty metres of corridor and at least one
     partition wall in between. That means (a) almost no treble, (b) a notch
     around 500Hz from the transmission path, (c) far more reverb than dry,
     (d) the low body survives better than the impact. Psychologically: the
     tempo is WRONG — usually slower than yours, occasionally faster — and it
     never quite locks to your stride. */
  function farStepSound(rig, t, o) {
    const R = rig.rng;
    const near = clamp(o.near == null ? 0.25 : o.near, 0, 1);     // 0 = very far
    const lvl = (o.gain == null ? 1 : o.gain) * (0.055 + near * 0.115);

    const dur = 0.16 + R() * 0.13;
    const n = noiseSrc(rig, t, dur + 0.08, 0.55 + R() * 0.4);
    /* through the wall: everything above ~350Hz is gone */
    const lp1 = bqf(rig, 'lowpass', 190 + near * 260 + R() * 60, 1.0);
    const lp2 = bqf(rig, 'lowpass', 240 + near * 420 + R() * 90, 0.9);
    const hp = bqf(rig, 'highpass', 52, 0.7);
    const notch = bqf(rig, 'peaking', 430 + R() * 220, 1.4, -8);   // partition resonance
    const ng = gn(rig, 0);
    n.connect(hp); hp.connect(lp1); lp1.connect(lp2); lp2.connect(notch); notch.connect(ng);
    env(ng, t, lvl * (0.8 + R() * 0.5), 0.010 + R() * 0.012, dur);

    /* structure-borne: it arrives through the floor slab a touch early and
       lower than it should, which is what makes it read as "heavy" */
    const bf = 44 + R() * 22;
    const bo = osc(rig, t - 0.004, 0.20, 'sine', bf);
    sv(bo.frequency, bf, t); er(bo.frequency, bf * 0.78, t + 0.14);
    const bg = gn(rig, 0);
    bo.connect(bg);
    env(bg, t, lvl * (0.5 + R() * 0.4), 0.008, 0.10 + R() * 0.07);

    /* a hint of the heel, only once it is close enough to matter */
    if (near > 0.45) {
      const c = noiseSrc(rig, t, 0.05, 1.0);
      const cb = bqf(rig, 'bandpass', 700 + R() * 500, 1.6);
      const cg = gn(rig, 0);
      c.connect(cb); cb.connect(cg);
      env(cg, t, lvl * (near - 0.45) * 0.5, 0.003, 0.035);
      cg.connect(rig.program);
      const cs = gn(rig, 0.5); cg.connect(cs); cs.connect(rig.revIn);
    }

    const out = gn(rig, 1.0);
    ng.connect(out); bg.connect(out);
    /* mostly reverb, barely any dry — that IS the sound of distance */
    const dry = gn(rig, 0.30 + near * 0.35);
    const wet = gn(rig, 0.85 - near * 0.25);
    out.connect(dry); dry.connect(rig.program);
    out.connect(wet); wet.connect(rig.revIn);
  }

  /* --------------------------------------------------------------- VOICE ---
     Not words. A glottal source (sawtooth + breath) driven through three
     parallel formant bandpasses whose centres jump between vowel targets at a
     syllable rate, with a falling prosodic contour. The ear's speech detector
     fires on formant motion, so this reads unmistakably as a human being
     talking while carrying no linguistic content at all. Then it is muffled
     through a wall, drowned in the corridor tail, and finally wowed by the
     tape — so you are never sure. */
  const VOWELS = [
    [730, 1090, 2440],  // a
    [530, 1840, 2480],  // e
    [270, 2290, 3010],  // i
    [570, 840, 2410],   // o
    [300, 870, 2240],   // u
    [640, 1190, 2390],  // ah
    [490, 1350, 1690],  // er
  ];
  function voiceSound(rig, t, o) {
    const R = rig.rng;
    const near = clamp(o.near == null ? 0.25 : o.near, 0, 1);
    const dur = o.dur == null ? (0.8 + R() * 2.1) : o.dur;
    const lvl = (o.gain == null ? 1 : o.gain) * (0.020 + near * 0.055);
    const female = R() < 0.42;
    let f0 = female ? 168 + R() * 55 : 96 + R() * 40;

    const saw = osc(rig, t, dur + 0.15, 'sawtooth', f0);
    /* vibrato + the tiny instability of a real larynx */
    const vib = osc(rig, t, dur + 0.15, 'sine', 4.4 + R() * 1.6);
    const vibG = gn(rig, f0 * 0.011);
    vib.connect(vibG); vibG.connect(saw.frequency);

    /* glottal spectral tilt — a real voice source falls ~12dB/oct */
    const tilt1 = bqf(rig, 'lowpass', 620 + R() * 260, 0.7);
    const tilt2 = bqf(rig, 'lowpass', 1500, 0.7);
    const srcG = gn(rig, 0.55);
    saw.connect(tilt1); tilt1.connect(tilt2); tilt2.connect(srcG);

    /* breath / aspiration */
    const br = noiseSrc(rig, t, dur + 0.1, 1.0);
    const brBP = bqf(rig, 'bandpass', 1400, 0.8);
    const brG = gn(rig, 0.055);
    br.connect(brBP); brBP.connect(brG);

    /* three formants in parallel */
    const F = [bqf(rig, 'bandpass', 600, 7), bqf(rig, 'bandpass', 1200, 9), bqf(rig, 'bandpass', 2500, 11)];
    const FG = [gn(rig, 1.0), gn(rig, 0.62), gn(rig, 0.26)];
    const vox = gn(rig, 0);
    for (let i = 0; i < 3; i++) {
      srcG.connect(F[i]); brG.connect(F[i]);
      F[i].connect(FG[i]); FG[i].connect(vox);
    }

    /* syllables: vowel targets, pitch contour, amplitude gate */
    let ct = t, prevV = (R() * VOWELS.length) | 0;
    let pitch = f0;
    sv(saw.frequency, pitch, t);
    sv(vox.gain, 0.0001, t);
    let syl = 0;
    while (ct < t + dur - 0.02 && syl < 24) {
      const len = 0.10 + R() * 0.20;
      const gap = R() < 0.20 ? 0.10 + R() * 0.28 : 0.012 + R() * 0.04;
      const v = VOWELS[(prevV + 1 + ((R() * (VOWELS.length - 1)) | 0)) % VOWELS.length];
      prevV = VOWELS.indexOf(v);
      /* formants glide into place over ~45ms — the glide is the "human" cue */
      for (let i = 0; i < 3; i++) lr(F[i].frequency, v[i] * (female ? 1.14 : 1.0), ct + 0.045);
      /* statements fall; the odd syllable is stressed */
      pitch *= 0.985 + R() * 0.045;
      pitch = clamp(pitch, f0 * 0.68, f0 * 1.45);
      lr(saw.frequency, pitch, ct + len * 0.6);
      const amp = (0.45 + R() * 0.55) * (syl === 0 ? 0.7 : 1);
      lr(vox.gain, amp, ct + 0.035);
      lr(vox.gain, amp * 0.7, ct + len);
      er(vox.gain, 0.0006, ct + len + Math.min(gap, 0.08));
      ct += len + gap;
      syl++;
    }
    er(vox.gain, 0.00005, ct + 0.10);

    /* through a wall, down a corridor */
    const mute1 = bqf(rig, 'lowpass', 700 + near * 1500, 0.8);
    const mute2 = bqf(rig, 'lowpass', 900 + near * 1900, 0.9);
    const mHP = bqf(rig, 'highpass', 190, 0.7);
    const out = gn(rig, lvl);
    vox.connect(mHP); mHP.connect(mute1); mute1.connect(mute2); mute2.connect(out);
    const dry = gn(rig, 0.35 + near * 0.4);
    const wet = gn(rig, 0.80 - near * 0.2);
    out.connect(dry); dry.connect(rig.program);
    out.connect(wet); wet.connect(rig.revIn);
  }

  /* ------------------------------------------------------- TAPE ARTEFACTS --- */

  /* Head thump at a splice: a mechanical whump at the drum, a short signal
     interruption, and a pitch lurch as the capstan recovers. */
  function thumpSound(rig, t, o) {
    const R = rig.rng;
    const amt = o.amt == null ? 0.6 + R() * 0.4 : o.amt;
    const f = 58 + R() * 26;
    const w = osc(rig, t, 0.22, 'sine', f);
    sv(w.frequency, f, t); er(w.frequency, f * 0.55, t + 0.13);
    const wg = gn(rig, 0);
    w.connect(wg);
    env(wg, t, 0.11 * amt, 0.004, 0.10 + R() * 0.07);
    wg.connect(rig.thumpBus);

    const n = noiseSrc(rig, t, 0.09, 1.0);
    const nb = bqf(rig, 'bandpass', 320 + R() * 420, 0.9);
    const ng = gn(rig, 0);
    n.connect(nb); nb.connect(ng);
    env(ng, t, 0.05 * amt, 0.002, 0.045 + R() * 0.035);
    ng.connect(rig.thumpBus);

    /* the tape stumbles */
    const P = rig.p;
    sv(P.dropGain.gain, 1, t);
    lr(P.dropGain.gain, 0.30 + R() * 0.25, t + 0.008);
    lr(P.dropGain.gain, 1, t + 0.055 + R() * 0.06);
    sv(P.lurch.offset, 0, t);
    lr(P.lurch.offset, (R() < 0.5 ? -1 : 1) * (0.0012 + R() * 0.0022), t + 0.05);
    lr(P.lurch.offset, 0, t + 0.42 + R() * 0.5);
  }

  /* The picture tears and the sound tears with it. Correlation is the whole
     point — an audio glitch that does not land on the same field as the video
     glitch reads as two separate bugs. */
  function glitchSound(rig, t, o) {
    const R = rig.rng;
    const amt = clamp(o.amt == null ? 0.6 : o.amt, 0.05, 1.2);
    const P = rig.p;

    /* RF / head-switching crackle */
    const dur = 0.05 + R() * 0.14 * amt;
    const n = noiseSrc(rig, t, dur + 0.05, 1.0);
    const bp = bqf(rig, 'bandpass', 900, 0.8);
    sv(bp.frequency, 400 + R() * 900, t);
    er(bp.frequency, 1800 + R() * 3200, t + dur);
    const ng = gn(rig, 0);
    n.connect(bp); bp.connect(ng);
    env(ng, t, 0.10 * amt, 0.001, dur);
    ng.connect(rig.program);

    /* bandwidth collapses and recovers */
    sv(P.glitchLP.frequency, 20000, t);
    lr(P.glitchLP.frequency, 1200 + (1 - amt) * 3000, t + 0.012);
    er(P.glitchLP.frequency, 20000, t + 0.12 + amt * 0.32);

    /* level tears */
    sv(P.dropGain.gain, 1, t);
    lr(P.dropGain.gain, 0.12 + R() * 0.3 * (1 - amt), t + 0.006);
    lr(P.dropGain.gain, 1.0 + amt * 0.35, t + 0.030 + R() * 0.04);
    lr(P.dropGain.gain, 1, t + 0.13 + R() * 0.14);

    /* and the transport lurches */
    sv(P.lurch.offset, 0, t);
    lr(P.lurch.offset, (R() < 0.55 ? 1 : -1) * (0.0018 + R() * 0.004) * amt, t + 0.03);
    lr(P.lurch.offset, 0, t + 0.30 + R() * 0.55);
  }

  /* Oxide shed: brief signal loss. Hiss survives it, which is the tell that
     it is the tape and not the world. */
  function dropoutSound(rig, t, o) {
    const R = rig.rng;
    const deep = o.deep;
    const P = rig.p;
    const len = deep ? 0.06 + R() * 0.16 : 0.012 + R() * 0.05;
    sv(P.dropGain.gain, 1, t);
    lr(P.dropGain.gain, deep ? 0.02 + R() * 0.05 : 0.18 + R() * 0.4, t + 0.004);
    sv(P.dropGain.gain, deep ? 0.02 : 0.25, t + len);
    lr(P.dropGain.gain, 1, t + len + 0.010 + R() * 0.03);
    if (deep) {
      /* the click of the signal coming back */
      const n = noiseSrc(rig, t + len, 0.02, 1.0);
      const b = bqf(rig, 'bandpass', 1400 + R() * 1800, 1.2);
      const g2 = gn(rig, 0);
      n.connect(b); b.connect(g2);
      env(g2, t + len, 0.05, 0.0008, 0.014);
      g2.connect(rig.thumpBus);
    }
  }

  /* Playback level wanders as the AGC hunts and the tape's coating varies. */
  function levelJump(rig, t, o) {
    const R = rig.rng;
    const P = rig.p;
    const up = R() < 0.45;
    const v = up ? 1.18 + R() * 0.30 : 0.52 + R() * 0.30;
    const hold = 0.35 + R() * 2.1;
    sv(P.jumpGain.gain, 1, t);
    lr(P.jumpGain.gain, v, t + 0.02 + R() * 0.05);
    sv(P.jumpGain.gain, v, t + hold);
    lr(P.jumpGain.gain, 1, t + hold + 0.15 + R() * 0.5);
  }

  /* ------------------------------------------------------------ WORLD SFX --- */

  /* A fluorescent tube striking / stuttering. Fires often, so it is quiet and
     short by design — a tick from the starter and a swell in the ballast. */
  function flickerSound(rig, t, o) {
    const R = rig.rng;
    const amt = clamp(o.amt == null ? 0.6 : o.amt, 0, 1);
    const n = noiseSrc(rig, t, 0.05, 1.0);
    const bp = bqf(rig, 'bandpass', 2200 + R() * 2400, 3.2);
    const g2 = gn(rig, 0);
    n.connect(bp); bp.connect(g2);
    env(g2, t, 0.030 * (0.4 + amt), 0.0012, 0.018 + R() * 0.030);
    g2.connect(rig.program);
    /* and a 120Hz burst as the arc restrikes */
    const o2 = osc(rig, t, 0.10, 'square', 120);
    const g3 = gn(rig, 0);
    const lp = bqf(rig, 'lowpass', 1600, 0.7);
    o2.connect(lp); lp.connect(g3);
    env(g3, t, 0.014 * (0.4 + amt), 0.004, 0.055 + R() * 0.05);
    g3.connect(rig.program);
  }

  /* Interaction — a hand on a door, a knock on hollow-core, a handle. */
  function knockSound(rig, t, o) {
    const R = rig.rng;
    const hit = o.hit != null;
    if (!hit) {
      /* nothing there: just the sleeve of the jacket moving */
      const n = noiseSrc(rig, t, 0.16, 1.0);
      const bp = bqf(rig, 'bandpass', 900 + R() * 900, 0.6);
      const g2 = gn(rig, 0);
      n.connect(bp); bp.connect(g2);
      env(g2, t, 0.030, 0.030, 0.11);
      g2.connect(rig.program);
      return;
    }
    /* hollow-core door: two inharmonic panel modes plus a knuckle transient */
    const modes = [148 + R() * 80, 268 + R() * 130, 470 + R() * 220];
    for (let i = 0; i < modes.length; i++) {
      const oo = osc(rig, t, 0.4, 'sine', modes[i]);
      const gg = gn(rig, 0);
      oo.connect(gg);
      env(gg, t, 0.075 / (i + 1.3), 0.003, 0.10 + R() * 0.22);
      gg.connect(rig.program);
      const s = gn(rig, 0.28); gg.connect(s); s.connect(rig.revIn);
    }
    const n = noiseSrc(rig, t, 0.06, 1.0);
    const bp = bqf(rig, 'bandpass', 1600 + R() * 1400, 1.1);
    const g2 = gn(rig, 0);
    n.connect(bp); bp.connect(g2);
    env(g2, t, 0.09, 0.0015, 0.030);
    g2.connect(rig.program);
    const s2 = gn(rig, 0.3); g2.connect(s2); s2.connect(rig.revIn);
  }

  /* Crossing a threshold: the room's acoustic changes before anything else
     tells you it has. */
  function roomEnterSound(rig, t, o) {
    const R = rig.rng;
    const P = rig.p;
    /* the tail lengthens/darkens for a moment */
    sv(P.revOut.gain, P.revOut.gain.value, t);
    lr(P.revOut.gain, 0.34 + 0.28, t + 0.10);
    lr(P.revOut.gain, 0.34, t + 1.6 + R() * 1.2);
    /* a low pressure shift as the air volume changes */
    const n = noiseSrc(rig, t, 0.9, 0.4);
    const lp = bqf(rig, 'lowpass', 190, 1.1);
    const g2 = gn(rig, 0);
    n.connect(lp); lp.connect(g2);
    env(g2, t, 0.055, 0.16, 0.55);
    g2.connect(rig.program);
  }

  /* A sighting. Not a sting — the opposite. The air handling stops, the hum
     collapses, the hiss comes up to fill the hole, and a thin tape whine
     appears that was not there before. Then everything comes back and you are
     left wondering whether it went away at all. */
  function sightingSound(rig, t, o) {
    const R = rig.rng;
    const st = clamp(o.strength == null ? 0.7 : o.strength, 0.1, 1);
    const P = rig.p;
    sv(P.bedDuck.gain, 1, t);
    lr(P.bedDuck.gain, 1 - st * 0.72, t + 0.22 + R() * 0.2);
    sv(P.bedDuck.gain, 1 - st * 0.72, t + 0.9 + st * 1.4);
    lr(P.bedDuck.gain, 1, t + 2.4 + st * 2.2);

    /* infrasonic swell — mostly removed by the tape's high-pass, which is
       exactly right: you feel the bottom of it and nothing more */
    const f = 34 + R() * 16;
    const so = osc(rig, t, 3.4, 'sine', f);
    sv(so.frequency, f, t); lr(so.frequency, f * 1.35, t + 3.0);
    const sg = gn(rig, 0);
    so.connect(sg);
    sv(sg.gain, 0.0001, t); lr(sg.gain, 0.22 * st, t + 1.1); er(sg.gain, 0.0001, t + 3.2);
    sg.connect(rig.thumpBus);

    /* thin whine, the sound of a head that has found something it should not */
    const wf = 2350 + R() * 700;
    const wo = osc(rig, t + 0.2, 2.6, 'sine', wf);
    const wv = osc(rig, t + 0.2, 2.6, 'sine', 0.7 + R() * 1.1);
    const wvg = gn(rig, wf * 0.006);
    wv.connect(wvg); wvg.connect(wo.frequency);
    const wg = gn(rig, 0);
    wo.connect(wg);
    sv(wg.gain, 0.0001, t + 0.2); lr(wg.gain, 0.020 * st, t + 1.0); er(wg.gain, 0.0001, t + 2.7);
    wg.connect(rig.program);
  }

  const EVENTS = {
    step: stepSound, farStep: farStepSound, voice: voiceSound,
    thump: thumpSound, glitch: glitchSound, dropout: dropoutSound,
    jump: levelJump, flicker: flickerSound, knock: knockSound,
    roomEnter: roomEnterSound, sighting: sightingSound,
  };
  function fire(rig, name, t, o) {
    const fn = EVENTS[name];
    if (!fn || !rig) return;
    try { fn(rig, t, o || {}); } catch (e) { console.error('[audio.sfx ' + name + ']', e); }
  }

  /* ============================================================ DIRECTOR ====
     Continuous parameter tracking + the autonomous schedulers. Driven
     identically by the live update() loop and by renderOffline()'s simulated
     timeline, so nothing can be true in one and false in the other. */
  function makeDirector(rig, seed) {
    const R = VB.rngFrom(seed >>> 0);
    const P = rig.p;
    let prevBuzz = 0.5;

    /* distant footsteps */
    const far = {
      on: false, timer: 0, iv: 0.66, left: 0, near: 0.2,
      cool: 4 + R() * 8, still: 0, halted: false, drift: 0,
    };
    /* other schedulers */
    let voiceCool = 22 + R() * 45;
    let thumpCool = 14 + R() * 30;
    let dropCool = 2 + R() * 5;
    let jumpCool = 18 + R() * 30;
    let flickCool = 0;

    function startFar(st) {
      far.on = true;
      far.halted = false;
      /* WRONG tempo. Your stride at full walk is ~0.495s. Theirs is not. */
      far.iv = R() < 0.72 ? 0.60 + R() * 0.24 : 0.355 + R() * 0.075;
      far.drift = (R() * 2 - 1) * 0.0035;
      far.left = 4 + ((R() * 11) | 0);
      far.near = clamp(0.06 + st.prox * 0.75 + st.stalked * 0.25 + R() * 0.18, 0, 1);
      far.timer = 0.10 + R() * 0.45;
    }

    return {
      far,
      /* ---- continuous tracking ---- */
      tick(dt, when, st) {
        const w = clamp(st.wear, 0, 1), d = clamp(st.dread, 0, 1), px = clamp(st.prox, 0, 1);
        const rmp = Math.max(dt * 1.5, 0.05);      // ramp length: smooth but not laggy
        const buzz = clamp(st.buzz, 0, 1);
        prevBuzz = buzz;

        /* room tone levels */
        lr(P.humGain.gain, 0.050 * (0.42 + 0.58 * buzz) * (1 - px * 0.30), when + rmp);
        lr(P.buzzGain.gain, 0.034 * (0.10 + 0.90 * buzz) * (1 + w * 0.30), when + rmp);
        /* the air handling dies when the entity is close. Nothing else in the
           mix says "wrong" as loudly as the HVAC simply not being there. */
        lr(P.hvGain.gain, 0.20 * (1 - px * 0.88) * (1 - w * 0.15), when + rmp);
        lr(P.airGain.gain, 0.020 * (1 - px * 0.7), when + rmp);
        /* handling noise tracks the operator's hands */
        lr(P.hndGain.gain, 0.0085 * (st.turn * 1.5 + st.move * 0.55 + d * 0.15), when + rmp);

        /* tape degradation */
        lr(P.hissGain.gain, 0.011 + w * 0.040 + st.burst * 0.045 + px * 0.010, when + rmp);
        const lpF = 7400 - w * 3150 - px * 700 - st.burst * 900;
        lr(P.lp1.frequency, lpF, when + rmp);
        lr(P.lp2.frequency, lpF, when + rmp);
        lr(P.lp3.frequency, lpF, when + rmp);
        lr(P.lp4.frequency, lpF, when + rmp);
        lr(P.hsLP1.frequency, lpF * 1.04, when + rmp);
        lr(P.hsLP2.frequency, lpF * 1.04, when + rmp);
        lr(P.hsLP3.frequency, lpF * 1.04, when + rmp);
        const hpF = 76 + w * 44;
        lr(P.hp1.frequency, hpF, when + rmp);
        lr(P.hp2.frequency, hpF * 1.21, when + rmp);

        /* wow & flutter get worse as the pack deforms */
        lr(P.wowG.gain, 0.00205 * (1 + w * 2.3), when + rmp);
        lr(P.wow2G.gain, 0.00054 * (1 + w * 2.8), when + rmp);
        lr(P.flutG.gain, 0.000030 * (1 + w * 3.6 + d * 0.6), when + rmp);
        lr(P.driftG.gain, 0.0016 * (1 + w * 2.2), when + rmp);

        /* and the coating saturates more easily */
        const pre = 1 + w * 1.55 + d * 0.35;
        lr(P.satPre.gain, pre, when + rmp);
        lr(P.satPost.gain, 1 / (1 + w * 0.85 + d * 0.22), when + rmp);

        lr(P.revOut.gain, 0.34 + st.roomPulse * 0.10 + d * 0.05, when + rmp);
      },

      /* ---- autonomous behaviour ---- */
      advance(dt, when, st) {
        const w = clamp(st.wear, 0, 1), d = clamp(st.dread, 0, 1);
        const px = clamp(st.prox, 0, 1), stk = clamp(st.stalked, 0, 1);

        /* -------------------------------- FOOTSTEPS THAT ARE NOT YOURS --- */
        const moving = st.move > 0.16;
        far.still = moving ? 0 : far.still + dt;
        far.cool -= dt;

        if (!far.on && far.cool <= 0 && moving) {
          const urge = 0.035 + d * 0.10 + stk * 0.20 + px * 0.30;
          if (R() < urge * dt * 3.0) startFar(st);
        }

        if (far.on) {
          /* THE RULE: they stop when you stop. Most of the time there is one
             more footfall after yours — the beat that makes people take their
             headphones off. */
          if (far.still > 0.30 && !far.halted) {
            far.halted = true;
            if (R() < 0.58) { far.left = 1; far.timer = far.iv * (0.8 + R() * 0.55); }
            else { far.left = 0; }
          }
          if (far.still <= 0.30 && far.halted && far.left > 0) far.halted = false;

          if (far.left <= 0) {
            far.on = false;
            far.cool = 6 + R() * 26 - d * 4 - px * 4;
          } else {
            far.timer -= dt;
            if (far.timer <= 0) {
              fire(rig, 'farStep', when, { near: far.near });
              far.left--;
              far.iv = clamp(far.iv + far.drift + (R() - 0.5) * 0.02, 0.30, 0.95);
              far.timer = far.iv;
              /* a limp: every so often the second foot lands too soon */
              if (R() < 0.10) fire(rig, 'farStep', when + far.iv * (0.30 + R() * 0.2), { near: far.near * 0.8 });
              /* and sometimes it simply stops mid-stride, for no reason */
              if (R() < 0.035 + px * 0.05) { far.left = 0; }
              /* closing in */
              far.near = clamp(far.near + (px * 0.05 - 0.004) * (1 + d), 0, 1);
            }
          }
        }

        /* ------------------------------------------------------ VOICES --- */
        voiceCool -= dt * (0.6 + d * 1.4 + stk * 1.0 + px * 1.6);
        if (voiceCool <= 0) {
          voiceCool = 30 + R() * 70;
          const near = clamp(0.05 + px * 0.55 + stk * 0.2 + R() * 0.22, 0, 1);
          fire(rig, 'voice', when, { near, dur: 0.7 + R() * 2.2 });
          /* two of them, sometimes, answering each other */
          if (R() < 0.22) fire(rig, 'voice', when + 1.0 + R() * 1.6, { near: near * 0.8, dur: 0.5 + R() * 1.2 });
        }

        /* ------------------------------------------- TAPE HOUSEKEEPING --- */
        thumpCool -= dt * (0.45 + w * 1.8);
        if (thumpCool <= 0) { thumpCool = 16 + R() * 46; fire(rig, 'thump', when, { amt: 0.35 + R() * 0.65 }); }

        dropCool -= dt * (0.5 + w * 3.4 + d * 0.5);
        if (dropCool <= 0) {
          dropCool = 1.1 + R() * 5.5;
          fire(rig, 'dropout', when, { deep: R() < 0.14 + w * 0.34 });
        }

        jumpCool -= dt * (0.3 + w * 2.2);
        if (jumpCool <= 0) { jumpCool = 12 + R() * 34; fire(rig, 'jump', when, {}); }

        if (flickCool > 0) flickCool -= dt;
      },

      /* rate-limit for light:flicker, which the lighting module fires often */
      wantFlicker(dt) {
        if (flickCool > 0) return false;
        flickCool = 0.42 + R() * 0.9;
        return true;
      },
    };
  }

  /* ======================================================== OFFLINE SIM ====
     A plausible twelve seconds of someone walking down a corridor: they walk,
     they stop, they walk again; they pass under fixtures so the ballast buzz
     swells and fades; the tape wears. Everything the live game feeds the
     director, this feeds the director. */
  function makeSim(ov, seed) {
    const R = VB.rngFrom(seed >>> 0);
    let moving = 1, moveT = 2.6 + R() * 2.0, move = 0;
    let dist = 0, stepPhase = 0, lastFoot = 0;
    let burst = 0, roomPulse = 0, turn = 0, turnT = 1.5;
    const get = (k, def) => (ov && ov[k] != null ? +ov[k] : def);

    return function (t, dt) {
      /* walk / pause cycle — the distant footsteps' stop-when-you-stop rule
         is only observable if the walker actually stops */
      moveT -= dt;
      if (moveT <= 0) {
        moving = moving ? 0 : 1;
        moveT = moving ? 2.4 + R() * 3.2 : 1.3 + R() * 1.9;
      }
      move = move + ((moving ? 1 : 0) - move) * (1 - Math.exp(-(moving ? 5 : 4.2) * dt));
      const spd = move * 2.35;
      dist += spd * dt;

      /* fixtures every two cells: buzz swells under each one */
      const b = 0.5 + 0.5 * Math.cos(dist * TAU / 5.2);
      const buzz = clamp(0.18 + 0.82 * b * (0.72 + 0.28 * VB.vnoise1(dist * 0.19, 91)), 0, 1);

      /* the operator looks around */
      turnT -= dt;
      if (turnT <= 0) { turnT = 0.8 + R() * 2.4; turn = R() < 0.45 ? 0.3 + R() * 0.6 : 0; }
      turn = turn * Math.exp(-2.4 * dt);

      burst = Math.max(0, burst - dt * 3.4);
      roomPulse = Math.max(0, roomPulse - dt * 1.25);

      stepPhase += spd * dt * 2.702;
      const foot = Math.floor(stepPhase / Math.PI);
      const stepped = foot !== lastFoot && move > 0.2;
      if (stepped) lastFoot = foot;

      return {
        t, move, running: 0, turn,
        wear: get('wear', clamp(0.06 + t * 0.004, 0, 1)),
        dread: get('dread', 0.28),
        prox: get('prox', 0),
        seen: get('seen', 0),
        stalked: get('stalked', get('prox', 0) * 0.6),
        anomaly: get('anomaly', 0.2),
        buzz: get('buzz', buzz),
        burst, roomPulse,
        _step: stepped, _foot: foot & 1, _spd: spd,
        _bump(v) { burst = Math.max(burst, v); },
        _pulse() { roomPulse = 1; },
      };
    };
  }

  /* ================================================================ LIVE ==== */
  let live = null;          // {ctx, rig, dir}
  let lastTick = -1;
  let lastStepAt = -1;

  function nowAt() { return live ? live.ctx.currentTime : 0; }
  function alive() { return !!(live && live.ctx && live.ctx.state !== 'closed'); }
  function running() { return !!(live && live.ctx && live.ctx.state === 'running'); }

  function liveState() {
    const buzz = (VB.lighting && VB.lighting.buzzAt)
      ? VB.lighting.buzzAt(S.pos ? S.pos.x : 0, S.pos ? S.pos.z : 0) : 0.6;
    return {
      t: S.t, move: S.move, running: S.running, turn: S.turn,
      wear: S.wear, dread: S.dread, prox: S.prox, seen: S.seen, stalked: S.stalked,
      anomaly: S.anomaly, buzz: buzz, burst: S.burst, roomPulse: S.roomPulse,
    };
  }

  function startLive() {
    if (live) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { return; }
    const seed = (S.seed ^ 0x1987BEEF) >>> 0;
    const rig = buildGraph(ctx, seed);
    const dir = makeDirector(rig, (seed ^ 0x9E3779B9) >>> 0);
    rig.start(ctx.currentTime + 0.03);
    live = { ctx, rig, dir };
    lastTick = ctx.currentTime;
    VB.audio.ctx = ctx;
    VB.audio.master = rig.master;
    if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(function () { });
  }

  /* =============================================================== MODULE ==== */
  return {
    init() {
      VB.audio = {
        ctx: null,
        master: null,
        unlock() {
          startLive();
          if (live && live.ctx.state === 'suspended' && live.ctx.resume) {
            live.ctx.resume().catch(function () { });
          }
        },
        sfx(name, opts) {
          if (!running()) return;
          const o = opts || {};
          const t = o.when != null ? o.when : live.ctx.currentTime + 0.012;
          fire(live.rig, name, t, o);
        },
        renderOffline,
        get state() { return live ? live.ctx.state : 'none'; },
      };

      /* ------------------------------------------------------ event wiring */
      VB.on('player:step', (e) => {
        if (!running()) return;
        const t = live.ctx.currentTime;
        if (t - lastStepAt < 0.07) return;
        lastStepAt = t;
        fire(live.rig, 'step', t + 0.010, { foot: e && e.foot, speed: e && e.speed });
      });

      VB.on('glitch:burst', (e) => {
        if (!running()) return;
        fire(live.rig, 'glitch', live.ctx.currentTime + 0.006, { amt: e && e.amt != null ? e.amt : 0.6 });
      });

      VB.on('light:flicker', (e) => {
        if (!running() || !live.dir.wantFlicker()) return;
        fire(live.rig, 'flicker', live.ctx.currentTime + 0.010, { amt: e && e.amt != null ? e.amt : 0.6 });
      });

      VB.on('room:enter', () => {
        if (!running()) return;
        fire(live.rig, 'roomEnter', live.ctx.currentTime + 0.010, {});
      });

      VB.on('player:interact', (e) => {
        if (!running()) return;
        fire(live.rig, 'knock', live.ctx.currentTime + 0.010, { hit: e && e.hit });
      });

      VB.on('entity:sighting', (e) => {
        if (!running()) return;
        const s = e && e.strength != null ? e.strength : 0.7;
        fire(live.rig, 'sighting', live.ctx.currentTime + 0.010, { strength: s });
        fire(live.rig, 'glitch', live.ctx.currentTime + 0.012, { amt: 0.35 + s * 0.5 });
      });

      VB.on('entity:near', (e) => {
        if (!running()) return;
        /* it is close enough to hear properly: force a short burst of steps */
        const dir = live.dir;
        if (!dir.far.on) {
          dir.far.on = true; dir.far.halted = false;
          dir.far.left = 2 + ((Math.random() * 4) | 0);
          dir.far.iv = 0.38 + Math.random() * 0.14;
          dir.far.near = 0.55 + Math.random() * 0.4;
          dir.far.timer = 0.05;
        }
      });

      VB.on('entity:spawn', () => { if (running()) fire(live.rig, 'thump', live.ctx.currentTime + 0.01, { amt: 0.45 }); });
    },

    /* Audio must not exist before a gesture — this is the gesture. */
    start() { startLive(); },

    update(dt) {
      if (!alive()) return;
      const ctx = live.ctx;
      const t = ctx.currentTime;
      /* A suspended context has a frozen clock; scheduling into it just piles
         up events at time 0. Only advance when the clock actually moves. */
      if (!(t > lastTick)) return;
      const adt = Math.min(0.25, t - lastTick);
      lastTick = t;
      const st = liveState();
      live.dir.tick(adt, t, st);
      live.dir.advance(adt, t + 0.02, st);
    },
  };

  /* ========================================================= RENDEROFFLINE ==
     Rebuilds the identical graph inside an OfflineAudioContext (mono, 44100),
     drives it with the same director over a simulated walk, and resolves the
     raw samples. This is the only window anyone in this loop has onto the
     sound, so it renders the real thing — bed plus a scattering of real
     events — not a test tone. */
  function renderOffline(seconds, stateOverrides) {
    seconds = Math.max(0.5, Math.min(180, +seconds || 10));
    const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OC) return Promise.reject(new Error('no OfflineAudioContext'));
    const SEED = 0x1987A0D0;
    const octx = new OC(1, Math.ceil(seconds * 44100), 44100);
    const rig = buildGraph(octx, SEED);
    const dir = makeDirector(rig, (SEED ^ 0x9E3779B9) >>> 0);
    const sim = makeSim(stateOverrides || {}, (SEED ^ 0x51ED) >>> 0);
    const R = VB.rngFrom((SEED ^ 0xC0FFEE) >>> 0);
    rig.start(0);

    /* Scripted beats as fractions of the render, so any duration shows the
       full vocabulary rather than whatever the random schedulers felt like. */
    const script = [
      [0.055, 'thump', { amt: 0.75 }],
      [0.140, 'farseq', { near: 0.30, n: 7, iv: 0.68 }],
      [0.300, 'flicker', { amt: 0.8 }],
      [0.330, 'glitch', { amt: 0.55 }],
      [0.400, 'knock', { hit: 1.4 }],
      [0.470, 'voice', { near: 0.34, dur: 1.9 }],
      [0.560, 'roomEnter', {}],
      [0.620, 'farseq', { near: 0.55, n: 6, iv: 0.41 }],
      [0.720, 'glitch', { amt: 0.9 }],
      [0.780, 'dropout', { deep: true }],
      [0.840, 'sighting', { strength: 0.8 }],
      [0.900, 'voice', { near: 0.5, dur: 1.3 }],
      [0.955, 'thump', { amt: 0.5 }],
    ];
    let si = 0;

    const DT = 1 / 40;
    const N = Math.floor((seconds - 0.05) / DT);
    for (let i = 0; i < N; i++) {
      const t = i * DT;
      const st = sim(t, DT);
      if (st._step) fire(rig, 'step', t, { foot: st._foot, speed: st._spd });

      while (si < script.length && script[si][0] * seconds <= t) {
        const name = script[si][1], o = script[si][2];
        if (name === 'farseq') {
          /* a whole sequence, so the tempo relationship is visible */
          const n = o.n, iv = o.iv;
          for (let k = 0; k < n; k++) {
            const jitter = (R() - 0.5) * 0.03;
            fire(rig, 'farStep', t + k * iv + jitter, { near: o.near });
          }
        } else if (name === 'glitch') {
          st._bump(0.8);
          fire(rig, name, t, o);
        } else if (name === 'roomEnter') {
          st._pulse();
          fire(rig, name, t, o);
        } else {
          fire(rig, name, t, o);
        }
        si++;
      }

      dir.tick(DT, t, st);
      dir.advance(DT, t, st);
    }
    /* let the last events breathe out */
    return octx.startRendering().then((b) => b.getChannelData(0));
  }
}, 40);
