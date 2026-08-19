/* ============================================================================
   PERF — keep the tape running at 29.97 on hardware that cannot afford it.

   The pipeline is expensive by design: two scene renders per presented frame
   (that is what makes motion comb) plus six fullscreen passes. A desktop GPU
   does not notice. A phone very much does.

   The order things are given up in matters, because some of them are the
   authenticity and some are only resolution:
     1. internal resolution — cheapest to lose. 640x480 is already far above
        what VHS resolves, so dropping toward 320x240 costs almost nothing
        visually; the tape chain is scaled in buffer-relative units so every
        artifact keeps its physical size.
     2. field rendering — LAST resort. Rendering one scene pass per presented
        frame halves the cost, but the two woven fields then come from the same
        instant and the combing disappears. That is the single most valuable
        cue in the whole piece, so it only goes when nothing else is left.
   ========================================================================== */
VB.def('perf', function (VB, THREE) {
  const S = VB.S, cfg = VB.cfg;

  /* 4:3 rungs. Heights stay even so the two field parities survive. */
  const RUNGS = [[640, 480], [512, 384], [416, 312], [320, 240], [256, 192]];
  let rung = 0;

  const HIST = 45;
  const dt = new Float32Array(HIST);
  let n = 0, filled = false, last = 0;
  let cooldown = 2.5;                 // settle before judging anything
  let sinceChange = 0;

  /* A coarse "this is a phone" signal. Used only to pick a starting rung —
     the measured frame time is what actually drives adaptation. */
  function isHandheld() {
    if (typeof navigator === 'undefined') return false;
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent || '')
      || (navigator.maxTouchPoints > 1 && window.innerWidth < 1100);
  }

  function apply(next) {
    next = VB.clamp(next, 0, RUNGS.length - 1);
    if (next === rung) return;
    rung = next;
    const [w, h] = RUNGS[rung];
    cfg.sceneW = w; cfg.sceneH = h;
    VB.renderer.setSize(w, h, false);
    const px = VB.mods.postfx;
    if (px && px.resize) px.resize(w, h);
    VB.quality = 1 - rung / (RUNGS.length - 1);
    sinceChange = 0;
    console.log('[perf] internal resolution -> ' + w + 'x' + h);
  }

  function median() {
    const a = Array.prototype.slice.call(dt, 0, filled ? HIST : n).sort((x, y) => x - y);
    return a.length ? a[a.length >> 1] : 0;
  }

  return {
    init() {
      VB.quality = 1;
      VB.perf = {
        get rung() { return rung; },
        get medianMs() { return median(); },
        setRung: apply,
        rungs: RUNGS.length,
      };
      /* Phones start two rungs down rather than discovering it the hard way
         through several seconds of stutter. */
      if (isHandheld()) apply(2);
    },

    update(step) {
      /* Wall-clock, not the fixed sim step — we are measuring the machine. */
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      if (last) {
        dt[n++ % HIST] = now - last;
        if (n >= HIST) filled = true;
      }
      last = now;

      cooldown -= step; sinceChange += step;
      if (cooldown > 0 || (!filled && n < HIST) || sinceChange < 1.8) return;

      const m = median();
      /* Two fields are presented per frame, so a 29.97fps frame is ~16.7ms of
         field time. Give real headroom before reacting either way — thrashing
         the render targets is worse than being one rung too low. */
      if (m > 21 && rung < RUNGS.length - 1) apply(rung + 1);
      else if (m < 11 && rung > 0) apply(rung - 1);
    },
  };
}, 90);
