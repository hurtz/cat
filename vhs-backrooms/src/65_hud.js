/* ============================================================================
   HUD — camcorder on-screen display, drawn to a canvas that postfx composites
   inside the tape stage so the characters degrade with the signal.
   ========================================================================== */
VB.def('hud', function (VB, THREE) {
  let c, g, tx;
  return {
    init() {
      c = document.createElement('canvas');
      c.width = 640; c.height = 480;
      g = c.getContext('2d');
      tx = new THREE.CanvasTexture(c);
      tx.minFilter = THREE.LinearFilter; tx.magFilter = THREE.LinearFilter;
      tx.generateMipmaps = false;
      VB.hud = { texture: tx, w: c.width, h: c.height };
    },
    lateUpdate() {
      g.clearRect(0, 0, c.width, c.height);
      g.font = 'bold 22px monospace';
      g.fillStyle = '#fff';
      g.fillText('REC', 62, 46);
      g.beginPath(); g.arc(46, 39, 8, 0, 7); g.fill();
      tx.needsUpdate = true;
    },
  };
}, 60);
