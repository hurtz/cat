/* ============================================================================
   ENTITY — placeholder. Owns S.prox / S.seen / S.stalked.
   ========================================================================== */
VB.def('entity', function (VB, THREE) {
  return {
    init() { VB.entity = { pos: null, active: false, dist: Infinity }; },
    update(dt) {
      VB.S.prox = VB.approach(VB.S.prox, 0, 1, dt);
    },
  };
}, 25);
