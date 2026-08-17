/* ============================================================================
   POSTFX — the tape.

   Structure (do not flatten these; each stage models a different physical
   thing and they must happen in this order):

     renderField()  scene -> rtField[field]           the CCD, twice per frame
     present()      weave two fields -> rtWeave       29.97fps interlaced frame
                    optics pass      -> rtOptics      lens: soft, CA, vignette
                    tape pass        -> rtTape        Y/C bandwidth, noise, tears
                    display pass     -> canvas        scanlines, bloom, levels

   This is a structurally-complete baseline. The bandwidth model is real but
   thin — head-switching, dropouts, ringing and time-base error live here and
   are where the authenticity is won or lost.
   ========================================================================== */
VB.def('postfx', function (VB, THREE) {
  const S = VB.S, cfg = VB.cfg;
  const R = VB.renderer;

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(quadGeo, null);
  quadScene.add(quad);

  function rt(w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: true, stencilBuffer: false,
    });
  }

  let rtField = [], rtWeave, rtOptics, rtTape;

  /* The CCD buffers are sRGB-encoded so the scene lands in them gamma-encoded.
     Every stage after this operates on a gamma-encoded signal — which is not a
     shortcut, it is what a real composite chain does. NTSC luma is Y' of
     gamma-corrected primaries; doing the Y/C split in linear light would give
     the wrong noise distribution and the wrong black lift.
     The intermediate targets stay unconverted so no stage double-encodes. */
  function ccd(w, h) {
    const r = rt(w, h);
    r.texture.colorSpace = THREE.SRGBColorSpace;
    return r;
  }

  const COMMON = `
    precision highp float;
    varying vec2 vUv;
    float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
    /* The CCD targets are SRGB8, so the GPU hands us linear light on sample.
       Re-encode once, at the weave, and every stage downstream then operates on
       a gamma-encoded signal — which is what a composite chain actually carries. */
    vec3 toSignal(vec3 c){
      c = clamp(c, 0.0, 1.0);
      return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
    }
  `;
  const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }`;

  /* ------------------------------------------------------------ weave */
  const weaveMat = new THREE.ShaderMaterial({
    uniforms: { tA: { value: null }, tB: { value: null }, res: { value: new THREE.Vector2() } },
    vertexShader: VERT,
    fragmentShader: COMMON + `
      uniform sampler2D tA, tB; uniform vec2 res;
      void main(){
        float line = floor(vUv.y * res.y);
        /* odd lines from the older field, even from the newer: real combing */
        vec3 c = mod(line, 2.0) < 1.0 ? texture2D(tA, vUv).rgb : texture2D(tB, vUv).rgb;
        gl_FragColor = vec4(toSignal(c), 1.0);
      }`,
  });

  /* ----------------------------------------------------------- optics */
  const opticsMat = new THREE.ShaderMaterial({
    uniforms: {
      tD: { value: null }, res: { value: new THREE.Vector2() },
      t: { value: 0 }, wear: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: COMMON + `
      uniform sampler2D tD; uniform vec2 res; uniform float t, wear;
      void main(){
        vec2 uv = vUv;
        vec2 d = uv - 0.5;
        /* lateral chromatic aberration, zero in the centre, strong at the edge */
        float ca = (0.0016 + wear*0.0012) * dot(d,d) * 4.0;
        vec3 c;
        c.r = texture2D(tD, uv + d*ca).r;
        c.g = texture2D(tD, uv).g;
        c.b = texture2D(tD, uv - d*ca).b;
        /* a 1987 CCD is simply not sharp */
        vec2 px = 1.0/res;
        vec3 blur = (texture2D(tD, uv+vec2(px.x,0)).rgb + texture2D(tD, uv-vec2(px.x,0)).rgb
                   + texture2D(tD, uv+vec2(0,px.y)).rgb + texture2D(tD, uv-vec2(0,px.y)).rgb)*0.25;
        c = mix(c, blur, 0.42);
        /* vignette */
        float v = 1.0 - dot(d,d)*1.15;
        c *= clamp(v, 0.0, 1.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });

  /* ------------------------------------------------------------- tape */
  const tapeMat = new THREE.ShaderMaterial({
    uniforms: {
      tD: { value: null }, tHud: { value: null }, res: { value: new THREE.Vector2() },
      t: { value: 0 }, wear: { value: 0 }, turn: { value: 0 }, pulse: { value: 0 },
      burst: { value: 0 }, dread: { value: 0 }, dropout: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: COMMON + `
      uniform sampler2D tD, tHud; uniform vec2 res;
      uniform float t, wear, turn, pulse, burst, dread, dropout;

      const mat3 RGB2YIQ = mat3(0.299,0.596,0.211, 0.587,-0.274,-0.523, 0.114,-0.322,0.312);
      const mat3 YIQ2RGB = mat3(1.0,1.0,1.0, 0.956,-0.272,-1.106, 0.619,-0.647,1.703);

      vec3 sampleYIQ(vec2 uv){
        vec3 rgb = texture2D(tD, uv).rgb;
        vec4 h = texture2D(tHud, vec2(uv.x, 1.0-uv.y));
        rgb = mix(rgb, h.rgb, h.a);      /* OSD is burned in before the tape */
        return RGB2YIQ * rgb;
      }

      void main(){
        vec2 uv = vUv;
        float line = floor(uv.y * res.y);

        /* --- time base error: every scanline is horizontally mispositioned */
        float tbe = (hash21(vec2(line, floor(t*29.97)))-0.5) * (0.0006 + wear*0.0022);
        tbe += sin(uv.y*61.0 + t*3.1)*0.0004;

        /* --- tracking band travelling up the frame, worse on movement */
        float trackAmt = turn*0.6 + pulse*0.9 + wear*0.3;
        float bandPos = fract(-t*0.19);
        float band = smoothstep(0.10, 0.0, abs(fract(uv.y - bandPos + 0.5) - 0.5));
        float tear = band * trackAmt * 0.055;

        /* --- head switching: the bottom of every frame is torn. always. */
        float hs = smoothstep(0.030, 0.0, uv.y);
        float hsShift = hs * (0.02 + wear*0.05) * (0.6 + 0.4*sin(t*13.0));

        float xoff = tbe + tear + hsShift;

        /* --- luma: band-limited horizontally, with overshoot ringing */
        float px = 1.0/res.x;
        float y = 0.0;
        y += sampleYIQ(uv + vec2(xoff - 2.0*px,0)).x * 0.10;
        y += sampleYIQ(uv + vec2(xoff - 1.0*px,0)).x * 0.24;
        y += sampleYIQ(uv + vec2(xoff,0)).x           * 0.36;
        y += sampleYIQ(uv + vec2(xoff + 1.0*px,0)).x * 0.24;
        y += sampleYIQ(uv + vec2(xoff + 2.0*px,0)).x * 0.10;
        float sharp = sampleYIQ(uv + vec2(xoff,0)).x;
        y = y + (sharp - y) * (1.0 + 0.9);          /* VCR detail circuit */

        /* --- chroma: ~1/8 the bandwidth of luma, and it lags to the right */
        vec2 iq = vec2(0.0);
        float wsum = 0.0;
        for(int k=-8;k<=8;k++){
          float w = 1.0 - abs(float(k))/9.0;
          iq += sampleYIQ(uv + vec2(xoff + float(k)*px*1.6 - px*3.0, 0.0)).yz * w;
          wsum += w;
        }
        iq /= wsum;
        iq *= (1.0 - wear*0.35);                     /* colour dies with age */

        /* --- noise: luma streaky, chroma coarse and blotchy */
        float ln = (hash21(vec2(floor(uv.x*res.x*0.4), line + floor(t*59.94)))-0.5);
        y += ln * (0.020 + wear*0.055 + dread*0.02);
        vec2 cn = vec2(hash21(vec2(floor(uv.x*res.x*0.06), line*0.25 + floor(t*29.97))),
                       hash21(vec2(floor(uv.x*res.x*0.06)+31.0, line*0.25 + floor(t*29.97))))-0.5;
        iq += cn * (0.030 + wear*0.075);

        /* --- dropouts: bright dashes where the oxide has shed */
        float doLine = step(0.9975 - dropout*0.02 - wear*0.004, hash21(vec2(line, floor(t*29.97))));
        float doX = step(0.986, hash21(vec2(floor(uv.x*res.x*0.25), line+7.0)));
        y = mix(y, 1.05, doLine*doX);

        /* --- head switch noise fill */
        y = mix(y, hash21(vec2(uv.x*res.x, line+t*90.0)), hs * (0.35 + wear*0.4));

        /* --- static burst */
        if(burst > 0.001){
          float sb = hash21(vec2(floor(uv.x*res.x*0.5), line + floor(t*400.0)));
          float m = step(1.0-burst*0.7, hash21(vec2(line, floor(t*80.0))));
          y = mix(y, sb, m*burst*0.9);
          iq = mix(iq, (vec2(sb, 1.0-sb)-0.5)*0.6, m*burst*0.8);
        }

        vec3 rgb = YIQ2RGB * vec3(y, iq);

        /* --- tape levels: blacks lifted and milky, highlights clipped */
        rgb = clamp(rgb, -0.1, 1.6);
        rgb = rgb * (1.0 - wear*0.10) + 0.045 + wear*0.035;
        gl_FragColor = vec4(rgb, 1.0);
      }`,
  });

  /* ---------------------------------------------------------- display */
  const dispMat = new THREE.ShaderMaterial({
    uniforms: { tD: { value: null }, res: { value: new THREE.Vector2() }, t: { value: 0 }, wear: { value: 0 } },
    vertexShader: VERT,
    fragmentShader: COMMON + `
      uniform sampler2D tD; uniform vec2 res; uniform float t, wear;
      void main(){
        vec2 uv = vUv;
        vec3 c = texture2D(tD, uv).rgb;
        /* horizontal-only bloom, because that is how a tape smears */
        vec3 bl = vec3(0.0);
        for(int k=-4;k<=4;k++) bl += texture2D(tD, uv+vec2(float(k)/res.x*3.0,0.0)).rgb;
        bl /= 9.0;
        c += max(bl - 0.62, 0.0) * 0.85;
        /* scanlines */
        float sl = 0.90 + 0.10*cos(uv.y*res.y*3.14159*2.0);
        c *= sl;
        c = clamp(c, 0.0, 1.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });

  function blit(mat, target) {
    quad.material = mat;
    R.setRenderTarget(target || null);
    R.render(quadScene, quadCam);
  }

  function alloc(w, h) {
    for (const r of rtField) r && r.dispose();
    rtField = [ccd(w, h), ccd(w, h)];
    for (const r of [rtWeave, rtOptics, rtTape]) r && r.dispose();
    rtWeave = rt(w, h); rtOptics = rt(w, h); rtTape = rt(w, h);
    const v = new THREE.Vector2(w, h);
    weaveMat.uniforms.res.value = v;
    opticsMat.uniforms.res.value = v;
    tapeMat.uniforms.res.value = v;
    dispMat.uniforms.res.value = v;
  }

  return {
    get __rts() { return { fieldA: rtField[0], fieldB: rtField[1], weave: rtWeave, optics: rtOptics, tape: rtTape }; },
    init() { alloc(cfg.sceneW, cfg.sceneH); },
    resize(w, h) { alloc(w, h); },

    renderField(scene, camera, field) {
      R.setRenderTarget(rtField[field]);
      R.clear(true, true, false);
      R.render(scene, camera);
      R.setRenderTarget(null);
    },

    present() {
      weaveMat.uniforms.tA.value = rtField[0].texture;
      weaveMat.uniforms.tB.value = rtField[1].texture;
      blit(weaveMat, rtWeave);

      opticsMat.uniforms.tD.value = rtWeave.texture;
      opticsMat.uniforms.t.value = S.t;
      opticsMat.uniforms.wear.value = S.wear;
      blit(opticsMat, rtOptics);

      const u = tapeMat.uniforms;
      u.tD.value = rtOptics.texture;
      u.tHud.value = VB.hud ? VB.hud.texture : null;
      u.t.value = S.t; u.wear.value = S.wear; u.turn.value = S.turn;
      u.pulse.value = S.roomPulse; u.burst.value = S.burst;
      u.dread.value = S.dread; u.dropout.value = S.dropout;
      blit(tapeMat, rtTape);

      dispMat.uniforms.tD.value = rtTape.texture;
      dispMat.uniforms.t.value = S.t;
      dispMat.uniforms.wear.value = S.wear;
      blit(dispMat, null);
    },

    repaint() {
      dispMat.uniforms.tD.value = rtTape.texture;
      blit(dispMat, null);
    },
  };
}, 70);
