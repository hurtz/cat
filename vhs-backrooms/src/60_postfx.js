/* ============================================================================
   POSTFX — the tape.

   Structure (do not flatten these; each stage models a different physical
   thing and they must happen in this order):

     renderField()  scene -> rtField[field]           the CCD, twice per frame
     present()      weave two fields -> rtWeave       29.97fps interlaced frame
                    meter downsample -> rtMeter       what the AE circuit sees
                    optics pass      -> rtOptics      lens + sensor
                    chroma pre-pass  -> rtChroma      the 0.4MHz colour-under
                    tape pass        -> rtTape        Y/C, noise, tears, levels
                    display pass     -> canvas        scanlines, bloom, levels

   Signal-domain notes, because getting these wrong is what makes a fake:

   * The CCD buffers are SRGB8, so the GPU decodes to linear light on sample.
     The weave re-encodes ONCE via toSignal() and every stage after that
     operates on a gamma-encoded signal. NTSC luma is Y' of gamma-corrected
     primaries — the Y/C split, the noise distribution and the black lift are
     only right in that domain. Nothing downstream re-encodes.

   * Everything that is constant over a frame (head-switch amount, tracking
     band position, exposure, gate weave, hue drift) is computed in JS in
     `sig()` and handed to the shaders as uniforms. Per-pixel work is spent
     only on things that actually vary per pixel.

   * Vertical resampling is quantised to 2-pixel steps everywhere. 480 buffer
     rows are two interleaved 240-line fields; a sub-line vertical shift would
     bilinear-blend the two fields together and silently destroy the combing,
     which is the single most expensive thing to lose.
   ========================================================================== */
VB.def('postfx', function (VB, THREE) {
  const S = VB.S, cfg = VB.cfg;
  const R = VB.renderer;
  const clamp = VB.clamp;

  const quadGeo = new THREE.PlaneGeometry(2, 2);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(quadGeo, null);
  quadScene.add(quad);

  /* VHS chroma is ~0.4MHz against ~3MHz luma. Carrying it in a buffer 1/8 the
     width is not an optimisation, it *is* the bandwidth model — the 8-pixel
     box on the way in and the bilinear spread on the way out are the filter. */
  const CDIV = 8;
  /* Auto-exposure metering grid. Coarse on purpose: a 1987 AE circuit is a
     photodiode behind a centre-weighted mask, not a histogram. */
  const MW = 128, MH = 4;

  function rt(w, h, depth) {
    return new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
      depthBuffer: !!depth, stencilBuffer: false,
    });
  }
  function ccd(w, h) {
    const r = rt(w, h, true);
    r.texture.colorSpace = THREE.SRGBColorSpace;
    return r;
  }

  let rtField = [], rtWeave, rtOptics, rtChroma, rtTape, rtMeter;
  let meterBuf = new Uint8Array(MW * MH * 4);

  const COMMON = `
    precision highp float;
    varying vec2 vUv;
    float hash21(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
    /* smooth 1-D value noise — used for anything that must be correlated
       along a scanline instead of per-pixel */
    float vnx(float x, float s){
      float i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
      return mix(hash21(vec2(i, s)), hash21(vec2(i+1.0, s)), f);
    }
    /* NTSC Y'IQ. Columns are R, G, B. */
    const mat3 RGB2YIQ = mat3(0.299,0.596,0.211, 0.587,-0.274,-0.523, 0.114,-0.322,0.312);
    const mat3 YIQ2RGB = mat3(1.0,1.0,1.0, 0.956,-0.272,-1.106, 0.619,-0.647,1.703);
    /* The CCD targets are SRGB8, so the GPU hands us linear light on sample.
       Re-encode once, at the weave, and every stage downstream then operates on
       a gamma-encoded signal — which is what a composite chain actually carries. */
    vec3 toSignal(vec3 c){
      c = clamp(c, 0.0, 1.0);
      return mix(c*12.92, 1.055*pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c));
    }
  `;
  const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy,0.0,1.0); }`;

  /* ------------------------------------------------------------ weave
     Field 0 lands on even raster rows, field 1 on odd, and the two were
     simulated 1/59.94s apart. That temporal disagreement IS the combing;
     nothing downstream is allowed to average across the parity. */
  const weaveMat = new THREE.ShaderMaterial({
    uniforms: { tA: { value: null }, tB: { value: null }, res: { value: new THREE.Vector2() } },
    vertexShader: VERT,
    fragmentShader: COMMON + `
      uniform sampler2D tA, tB; uniform vec2 res;
      void main(){
        float line = floor(vUv.y * res.y);
        vec3 c = mod(line, 2.0) < 1.0 ? texture2D(tA, vUv).rgb : texture2D(tB, vUv).rgb;
        gl_FragColor = vec4(toSignal(c), 1.0);
      }`,
  });

  /* ------------------------------------------------------------- meter
     One coarse cell = 5 x 120 source pixels. rgb = mean (auto-exposure reads
     this back on the CPU), a = peak luma in the column slice (the optics pass
     turns that into CCD vertical smear). */
  const meterMat = new THREE.ShaderMaterial({
    uniforms: { tD: { value: null }, cell: { value: new THREE.Vector2(1 / MW, 1 / MH) } },
    vertexShader: VERT,
    fragmentShader: COMMON + `
      uniform sampler2D tD; uniform vec2 cell;
      void main(){
        vec2 base = floor(vUv/cell);
        vec3 sum = vec3(0.0); float mx = 0.0;
        for(int j=0;j<8;j++){
          for(int i=0;i<4;i++){
            vec2 o = (vec2(float(i)/4.0, float(j)/8.0) + vec2(0.125, 0.0625));
            vec3 c = texture2D(tD, (base + o)*cell).rgb;
            sum += c;
            mx = max(mx, dot(c, vec3(0.299,0.587,0.114)));
          }
        }
        gl_FragColor = vec4(sum/32.0, mx);
      }`,
  });

  /* ----------------------------------------------------------- optics
     The camcorder in front of the tape: soft CCD, lateral CA, vignette, gate
     weave, sensor smear, and the auto-iris. Everything here is pre-recording.  */
  const opticsMat = new THREE.ShaderMaterial({
    uniforms: {
      tD: { value: null }, tMeter: { value: null }, res: { value: new THREE.Vector2() },
      wear: { value: 0 }, expo: { value: 1 }, gate: { value: new THREE.Vector2() },
      smear: { value: 0.055 },
    },
    vertexShader: VERT,
    fragmentShader: COMMON + `
      uniform sampler2D tD, tMeter; uniform vec2 res, gate;
      uniform float wear, expo, smear;

      void main(){
        vec2 px = 1.0/res;
        /* gate weave — the whole image wanders. gate.y arrives already
           quantised to 2 rows so the field parity survives the resample. */
        vec2 uv = vUv + gate*px;
        vec2 d = uv - 0.5;
        float r2 = dot(d,d);

        /* lateral chromatic aberration: a radial scale error, zero at the
           optical axis, ~2px at the corners, worse as the tape ages (it isn't
           really the lens by then, but the eye reads it as one artifact) */
        float ca = (0.0075 + wear*0.0045) * r2;
        vec2 uvR = uv + d*ca, uvB = uv - d*ca;

        /* 1987 CCD + its optical low-pass: soft, and softer horizontally than
           vertically. Vertical taps are 2 rows out so they stay inside one
           field — blurring across parity would kill the combing. */
        vec3 c;
        c.r = 0.5*texture2D(tD, uvR).r + 0.25*texture2D(tD, uvR+vec2(px.x,0.0)).r + 0.25*texture2D(tD, uvR-vec2(px.x,0.0)).r;
        c.g = 0.5*texture2D(tD, uv ).g + 0.25*texture2D(tD, uv +vec2(px.x,0.0)).g + 0.25*texture2D(tD, uv -vec2(px.x,0.0)).g;
        c.b = 0.5*texture2D(tD, uvB).b + 0.25*texture2D(tD, uvB+vec2(px.x,0.0)).b + 0.25*texture2D(tD, uvB-vec2(px.x,0.0)).b;
        vec3 vv = texture2D(tD, uv+vec2(0.0, 2.0*px.y)).rgb + texture2D(tD, uv-vec2(0.0, 2.0*px.y)).rgb;
        c = mix(c, vv*0.5, 0.22);

        /* interline transfer smear: a bright source bleeds a soft column all
           the way up and down the sensor. Pure 1980s CCD. */
        float col = 0.0;
        for(int j=0;j<4;j++) col = max(col, texture2D(tMeter, vec2(uv.x, (float(j)+0.5)/4.0)).a);
        c += smear * smoothstep(0.72, 1.0, col);

        /* heavy vignette — cheap wide lens, wide open indoors */
        float vig = pow(clamp(1.0 - r2*0.95, 0.0, 1.0), 0.85);
        c *= vig;

        /* auto-iris. expo is driven on the CPU by a delayed, under-damped
           response to the meter, so it always arrives a beat late and
           overshoots before it settles. */
        c *= expo;

        /* sensor saturation: soft knee, then a hard ceiling */
        vec3 k = max(c - 0.78, 0.0);
        c = min(c, 0.78) + k/(1.0 + k*1.5);
        gl_FragColor = vec4(min(c, 1.18), 1.0);
      }`,
  });

  /* ----------------------------------------------------------- chroma
     The colour-under channel, carried at 1/CDIV the luma width. The 8-pixel
     box on the way in is the 0.4MHz brick wall; 'lag' is the group delay of
     the chroma filter, which is why colour arrives to the RIGHT of the luma
     edge it belongs to. Chroma noise is generated here so that it inherits
     the same smear and comes out coarse and blotchy instead of speckled. */
  const chromaMat = new THREE.ShaderMaterial({
    uniforms: {
      tD: { value: null }, res: { value: new THREE.Vector2() },
      cres: { value: new THREE.Vector2() }, sd: { value: new THREE.Vector4() },
      wear: { value: 0 }, lag: { value: 5.0 }, dread: { value: 0 }, frameN: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: COMMON + `
      uniform sampler2D tD; uniform vec2 res, cres; uniform vec4 sd;
      uniform float wear, lag, dread, frameN;
      void main(){
        vec2 uv = vUv;
        float sl = floor((1.0-uv.y)*res.y);
        float ipx = 1.0/res.x;
        /* four bilinear taps = an exact 8-pixel box, displaced left by 'lag' */
        vec3 a = texture2D(tD, uv + vec2((-3.0-lag)*ipx, 0.0)).rgb;
        vec3 b = texture2D(tD, uv + vec2((-1.0-lag)*ipx, 0.0)).rgb;
        vec3 c = texture2D(tD, uv + vec2(( 1.0-lag)*ipx, 0.0)).rgb;
        vec3 e = texture2D(tD, uv + vec2(( 3.0-lag)*ipx, 0.0)).rgb;
        vec3 yiq = RGB2YIQ * ((a+b+c+e)*0.25);
        vec2 iq = yiq.yz;

        /* colour-under phase error: the chroma subcarrier is re-heterodyned
           off a wobbly reference, so hue rotates a little line to line */
        float ph = (vnx(sl*0.31 + frameN*0.09, 11.0) - 0.5) * (0.10 + wear*0.55);
        float cs = cos(ph), sn = sin(ph);
        iq = mat2(cs, sn, -sn, cs) * iq;

        /* chroma noise: coarse blocks (2 chroma texels x 2 lines), biased hard
           onto the green/magenta axis, living in the darks and mids */
        vec2 cellv = vec2(floor(uv.x*cres.x*0.5), floor(sl*0.5) + frameN);
        float n1 = hash21(cellv) - 0.5;
        float n2 = hash21(cellv + 37.7) - 0.5;
        vec2 gm = vec2(0.464, 0.886);              /* magenta(+) / green(-) */
        float amp = (0.030 + wear*0.105 + dread*0.012);
        float wgt = (1.0 - 0.82*smoothstep(0.34, 0.92, yiq.x)) * (0.45 + 0.55*smoothstep(0.0, 0.10, yiq.x));
        iq += (gm*n1*1.15 + vec2(-gm.y, gm.x)*n2*0.42) * amp * wgt;

        gl_FragColor = vec4(0.5 + iq*0.8, 0.0, 1.0);
      }`,
  });

  /* ------------------------------------------------------------- tape
     Where the authenticity is won or lost. In order: work out where this
     scanline actually landed (time-base error, tracking band, head switch),
     sample luma through the VCR's band-limit + detail circuit, fetch the
     colour-under, add tape noise, burn in dropouts, then apply tape levels. */
  const tapeMat = new THREE.ShaderMaterial({
    uniforms: {
      tD: { value: null }, tHud: { value: null }, tChroma: { value: null },
      res: { value: new THREE.Vector2() },
      t: { value: 0 }, wear: { value: 0 }, burst: { value: 0 }, dread: { value: 0 },
      dropout: { value: 0 }, prox: { value: 0 }, frameN: { value: 0 },
      /* per-frame signal geometry, computed on the CPU */
      tbe: { value: new THREE.Vector3() },     /* x: per-line jitter, y: jelly, z: whole-frame */
      hs: { value: new THREE.Vector4() },      /* x: edge uv, y: shift, z: slope, w: noise */
      track: { value: new THREE.Vector3() },   /* x: centre, y: amount, z: noise gain */
      vshift: { value: 0 }, hue: { value: 0 }, sat: { value: 0.8 },
      ring: { value: 0.9 },
    },
    vertexShader: VERT,
    fragmentShader: COMMON + `
      uniform sampler2D tD, tHud, tChroma; uniform vec2 res;
      uniform float t, wear, burst, dread, dropout, prox, frameN;
      uniform vec3 tbe, track; uniform vec4 hs;
      uniform float vshift, hue, sat, ring;

      /* the signal as it reaches the record head: picture with the character
         generator already burned into it (that is why the OSD wears out too) */
      float SIGY(vec2 uv){
        vec3 rgb = texture2D(tD, uv).rgb;
        vec4 h = texture2D(tHud, uv);
        rgb = mix(rgb, h.rgb, h.a);
        return dot(rgb, vec3(0.299, 0.587, 0.114));
      }

      void main(){
        vec2 uv = vUv;
        float sl = floor((1.0-uv.y)*res.y);        /* raster line, 0 at the top */
        float ipx = 1.0/res.x, ipy = 1.0/res.y;

        /* ---- 1. time-base error --------------------------------------- */
        /* per-line random displacement, sub-pixel on a good tape */
        float x = (hash21(vec2(sl, frameN)) - 0.5) * tbe.x;
        /* velocity error: smooth in line index and crawling in time, so
           vertical edges wobble like jelly instead of buzzing */
        x += (vnx(sl*0.055 + tbe.z*7.0, 3.0) - 0.5) * tbe.y;
        x += tbe.z;                                 /* whole frame breathes */

        /* ---- 2. tracking band ----------------------------------------- */
        float dy = abs(fract(uv.y - track.x + 0.5) - 0.5);
        float bandW = 1.0 - smoothstep(0.0, 0.090, dy);   /* displaced */
        float bandC = 1.0 - smoothstep(0.0, 0.024, dy);   /* pure noise core */
        float trk = bandW * track.y;
        x += trk * (0.010 + 0.030*hash21(vec2(sl, frameN + 3.0))) * (0.45 + bandC);

        /* ---- 3. head switching ---------------------------------------- */
        /* The head swaps mid-line at the bottom of every field, so the last
           few lines are displaced and full of off-track noise, and the
           boundary between good and torn signal runs slightly diagonally. */
        float edge = hs.x + (uv.x - 0.5)*hs.z + sin(uv.x*7.3 + t)*0.6*ipy;
        float hsv = 1.0 - smoothstep(edge - 3.0*ipy, edge, uv.y);
        float hsx = hsv*hsv;                        /* the classic bottom flag */
        x += hsx * hs.y * (0.55 + 0.75*hsx);
        x += hsx * (hash21(vec2(sl, frameN+9.0)) - 0.5) * 0.020;

        /* vertical: the torn lines are lifted off a different part of the
           track. Quantised to whole line pairs so the fields stay separate. */
        float vy = vshift + floor(hsx*hs.w*3.0 + 0.5)*2.0;
        vec2 o = vec2(x, vy*ipy);

        /* ---- 4. luma: band limit + the VCR detail circuit -------------- */
        /* Eight taps do triple duty: a 5-tap low-pass at the sample point, a
           wide low-pass 3.5px to the LEFT, and a one-sided smear tail. */
        float s_7 = SIGY(uv + o + vec2(-7.0*ipx, 0.0));
        float s_5 = SIGY(uv + o + vec2(-5.0*ipx, 0.0));
        float s_35= SIGY(uv + o + vec2(-3.5*ipx, 0.0));
        float s_2 = SIGY(uv + o + vec2(-2.0*ipx, 0.0));
        float s_1 = SIGY(uv + o + vec2(-1.0*ipx, 0.0));
        float s0  = SIGY(uv + o);
        float s1  = SIGY(uv + o + vec2( 1.0*ipx, 0.0));
        float s2  = SIGY(uv + o + vec2( 2.0*ipx, 0.0));

        float y  = 0.13*s_2 + 0.22*s_1 + 0.30*s0 + 0.22*s1 + 0.13*s2;
        float yd = 0.30*s_2 + 0.40*s_35 + 0.30*s_5;   /* delayed by ~3.5px */

        /* Overshoot: out = y + k*(y - y_delayed). On a dark->light edge the
           delayed term is still dark, so the pixels immediately to the RIGHT
           of the transition ring bright; on light->dark they undershoot.
           Cored so it sharpens picture detail and not tape noise, and limited
           the way a real peaking circuit limits. */
        float dv = y - yd;
        dv = sign(dv) * max(abs(dv) - 0.010, 0.0);
        y += clamp(dv * ring, -0.30, 0.34);

        /* trailing smear: bright things drag a short comet tail rightwards */
        float tail = max(s_35-0.55,0.0)*0.30 + max(s_5-0.55,0.0)*0.20 + max(s_7-0.55,0.0)*0.11;
        y += tail * (0.55 + wear*0.5);

        /* ---- 5. chroma ------------------------------------------------- */
        float cpx = float(${CDIV})*ipx;
        vec2 cuv = uv + o;
        vec3 c0 = texture2D(tChroma, cuv).rgb;
        vec3 cl = texture2D(tChroma, cuv - vec2(cpx, 0.0)).rgb;
        vec3 cr = texture2D(tChroma, cuv + vec2(cpx, 0.0)).rgb;
        vec2 iq = ((c0.rg*0.5 + cl.rg*0.28 + cr.rg*0.22) - 0.5)/0.8;

        /* ---- 6. tape noise --------------------------------------------- */
        /* horizontally correlated: streaks along the line, independent per
           line. Never per-pixel snow — that reads as digital, not as tape. */
        float nx = uv.x*res.x;
        float ns = (vnx(nx*0.17, sl + frameN*3.0) - 0.5)*0.85
                 + (vnx(nx*0.42, sl + frameN*3.0 + 91.0) - 0.5)*0.45;
        float nAmp = 0.022 + wear*0.070 + dread*0.020 + prox*0.030;
        y += ns * nAmp * (0.72 + 0.75*(1.0 - clamp(y,0.0,1.0)));

        /* ---- 7. tracking + head-switch noise fill ---------------------- */
        float bandNoise = hash21(vec2(nx*0.5, sl + frameN*17.0));
        float fill = clamp(bandC*track.y*track.z, 0.0, 1.0);
        y = mix(y, 0.28 + bandNoise*0.55, fill*0.85);
        iq *= (1.0 - fill*0.9);

        float hsn = hsx * (0.45 + wear*0.45);
        y = mix(y, 0.20 + hash21(vec2(nx, sl + frameN*29.0))*0.72, hsn);
        iq *= (1.0 - hsx*0.95);                     /* no burst = no colour */

        /* ---- 8. dropouts ----------------------------------------------- */
        /* shed oxide: a short bright dash, sometimes two lines tall */
        float dl = hash21(vec2(floor(sl*0.5), frameN*1.7));
        /* A real tape does not shed oxide five times a frame. At rest this is
           well under one dropout per frame; the dropout event only lifts it to
           a couple. Frequency is the whole difference between "damaged tape"
           and "decorative white dashes". */
        float thr = 0.9992 - dropout*0.0125 - wear*0.0040;
        if (dl > thr){
          float cxr = hash21(vec2(floor(sl*0.5), frameN*1.7 + 5.0));
          /* squared so short dashes dominate and long ones are rare */
          float wr = hash21(vec2(floor(sl*0.5), frameN*1.7 + 13.0));
          float wdt = 0.006 + 0.075*wr*wr;
          float d = 1.0 - smoothstep(wdt*0.42, wdt*0.5, abs(uv.x - cxr));
          /* most are the classic bright dash, but a minority drop to black —
             which is what actually happens when the head loses RF entirely */
          float dark = step(0.78, hash21(vec2(floor(sl*0.5), frameN*1.7 + 29.0)));
          y = mix(y, mix(1.06, 0.04, dark), d);
          iq *= (1.0 - d);
        }

        /* ---- 9. static burst ------------------------------------------- */
        if (burst > 0.001){
          float sb = hash21(vec2(floor(nx*0.4), sl + floor(t*400.0)));
          float m = step(1.0 - burst*0.75, hash21(vec2(sl, floor(t*80.0))));
          y = mix(y, sb, m*burst*0.9);
          iq = mix(iq, (vec2(sb, 1.0-sb)-0.5)*0.5, m*burst*0.85);
        }

        /* ---- 10. tape levels -------------------------------------------- */
        /* slow hue drift + the colour dying towards grey-green with age */
        float hc = cos(hue), hsn2 = sin(hue);
        iq = mat2(hc, hsn2, -hsn2, hc) * iq;
        iq *= sat;
        iq += vec2(0.012, -0.011) * (0.6 + 0.4*wear);          /* warm cast */
        iq += vec2(-0.274, -0.523) * wear * 0.030;             /* green wash */

        y = min(y, 1.02);
        vec3 rgb = YIQ2RGB * vec3(y, iq);
        rgb = max(rgb, -0.05);
        /* blacks never reach zero on tape — they sit on a milky pedestal */
        rgb = rgb*(0.955 - wear*0.075) + vec3(0.044, 0.049, 0.046) + wear*0.030;
        gl_FragColor = vec4(rgb, 1.0);
      }`,
  });

  /* ---------------------------------------------------------- display
     The monitor this was played back on, and the capture of it. */
  const dispMat = new THREE.ShaderMaterial({
    uniforms: {
      tD: { value: null }, res: { value: new THREE.Vector2() },
      wear: { value: 0 }, phase: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: COMMON + `
      uniform sampler2D tD; uniform vec2 res; uniform float wear, phase;
      void main(){
        vec2 uv = vUv;
        vec3 c = texture2D(tD, uv).rgb;

        /* bloom smears horizontally far more than vertically — the video
           amplifier has no idea what a scanline above it is doing */
        vec3 bl = vec3(0.0);
        for(int k=1;k<=4;k++){
          float d = float(k)*2.5/res.x;
          bl += texture2D(tD, uv+vec2(d,0.0)).rgb + texture2D(tD, uv-vec2(d,0.0)).rgb;
        }
        bl *= 0.125;
        c += max(bl - 0.60, 0.0) * 0.95;
        /* a little vertical halation, kept inside one field */
        vec3 vb = texture2D(tD, uv+vec2(0.0, 2.0/res.y)).rgb + texture2D(tD, uv-vec2(0.0, 2.0/res.y)).rgb;
        c += max(vb*0.5 - 0.74, 0.0) * 0.35;

        /* ~240 visible scanlines. The dark rows swap parity every frame,
           exactly as the two fields alternate on a real interlaced display. */
        float row = mod(floor(uv.y*res.y) + phase, 2.0);
        c *= mix(1.045, 0.855 - wear*0.03, row);

        c = clamp(c, 0.004, 1.0);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });

  function blit(mat, target) {
    quad.material = mat;
    R.setRenderTarget(target || null);
    R.render(quadScene, quadCam);
  }

  /* ======================================================================
     The CPU-side signal model. Everything frame-constant lives here.
     ====================================================================== */
  const AE_DELAY = 7;                     /* ~0.23s of pure lag before the iris moves */
  const M = {
    frameN: 0,
    measured: 0.38, meterAge: 99,
    expo: 1, expoV: 0, aeQ: new Float32Array(AE_DELAY), aeI: 0, aePrimed: false,
    trackY: 0.63, trackAmt: 0,
    hsAmt: 0.02, hsLines: 7, hsSlope: 0,
    hue: 0, vshift: 0, drift: 0,
  };
  for (let i = 0; i < AE_DELAY; i++) M.aeQ[i] = 0.38;

  const AE_SET = 0.455;                   /* what the meter is aiming for */
  const V2 = new THREE.Vector2(), V3 = new THREE.Vector3(), V4 = new THREE.Vector4();

  function meter() {
    meterMat.uniforms.tD.value = rtWeave.texture;
    blit(meterMat, rtMeter);
    try {
      R.readRenderTargetPixels(rtMeter, 0, 0, MW, MH, meterBuf);
      let sum = 0, wsum = 0;
      for (let yy = 0; yy < MH; yy++) {
        const dy = (yy + 0.5) / MH - 0.5;
        for (let xx = 0; xx < MW; xx++) {
          const i = (yy * MW + xx) * 4;
          const l = (meterBuf[i] * 0.299 + meterBuf[i + 1] * 0.587 + meterBuf[i + 2] * 0.114) / 255;
          const dx = (xx + 0.5) / MW - 0.5;
          /* centre-weighted average metering, like every camcorder ever */
          const w = 1 / (1 + 7 * (dx * dx + dy * dy));
          sum += l * w; wsum += w;
        }
      }
      M.measured = sum / wsum;
      M.meterAge = 0;
    } catch (e) {
      /* readback unavailable — hold the last measurement rather than throw */
      M.meterAge = 99;
    }
  }

  /* Auto-exposure: a delayed, under-damped second-order response. It cannot
     be right on time and it cannot arrive without overshooting, which is
     exactly how a 1987 auto-iris behaves when you walk into a lit room. */
  function updateExposure(dt) {
    M.aeQ[M.aeI] = M.measured;
    M.aeI = (M.aeI + 1) % AE_DELAY;
    const lagged = M.aeQ[M.aeI];                  /* AE_DELAY frames old */
    const target = clamp(AE_SET / Math.max(lagged, 0.04), 0.62, 1.85);
    if (!M.aePrimed) { M.expo = target; M.aePrimed = true; }
    /* w0 ~ 5.8 rad/s, zeta ~ 0.42 -> visible overshoot, settles in ~1.5s */
    M.expoV += ((target - M.expo) * 34.0 - M.expoV * 4.9) * dt;
    M.expo = clamp(M.expo + M.expoV * dt, 0.35, 2.3);
  }

  function sig(dt) {
    const t = S.t, wear = S.wear;
    M.frameN = (M.frameN + 1) % 8192;
    const fN = M.frameN;

    updateExposure(dt);

    /* gate weave: the whole picture wanders a couple of pixels */
    const gx = (VB.fbm1(t * 0.53, 3, 91) - 0.47) * 3.0;
    let gy = (VB.fbm1(t * 0.37, 3, 57) - 0.47) * 2.6;
    gy = Math.round(gy * 0.5) * 2;                 /* keep the field parity */
    opticsMat.uniforms.gate.value.set(gx, gy);

    /* tracking band: crawls upward, spikes on fast pans, room entry and wear */
    const want = clamp(S.turn * 0.55 + S.roomPulse * 0.85 + wear * 0.30
      + S.burst * 0.45 + S.dread * 0.12 + S.prox * 0.20, 0, 1.25);
    M.trackAmt = VB.approach(M.trackAmt, want, want > M.trackAmt ? 9 : 1.1, dt);
    M.trackY -= dt * (0.055 + 0.16 * M.trackAmt + wear * 0.03);
    if (M.trackY < 0) M.trackY += 1;

    /* head switching: on every frame, always. Amount rattles frame to frame
       and gets openly unstable as the tape wears. */
    const hr = VB.hashf(fN, 7, 13), hr2 = VB.hashf(fN, 23, 91);
    const unstable = hr2 > (0.985 - wear * 0.10) ? 1 : 0;
    M.hsLines = 6.5 + wear * 3.5 + unstable * 4;
    M.hsAmt = (0.0125 + wear * 0.028) * (0.55 + 0.85 * hr) * (1 + unstable * 1.4);
    M.hsSlope = (2.4 + wear * 2.0 + unstable * 3.0) / cfg.sceneH;

    /* vertical hold wander — a couple of lines, and only when the tape is bad */
    const vs = (VB.vnoise1(t * 1.6, 21) - 0.5) * (wear * 3.4 + S.burst * 7.0);
    M.vshift = Math.round(vs * 0.5) * 2;

    /* hue drift: slow, never quite settling */
    M.hue = (VB.fbm1(t * 0.055, 3, 5) - 0.47) * 0.55 + Math.sin(t * 0.021) * 0.10;
    M.drift = VB.fbm1(t * 0.23, 3, 77) - 0.47;

    /* ---- push everything at the shaders ---- */
    const uo = opticsMat.uniforms;
    uo.tD.value = rtWeave.texture;
    uo.tMeter.value = rtMeter.texture;
    uo.wear.value = wear;
    uo.expo.value = M.expo;
    uo.smear.value = 0.05 + wear * 0.02;

    const uc = chromaMat.uniforms;
    uc.tD.value = rtOptics.texture;
    uc.frameN.value = fN;
    uc.wear.value = wear;
    uc.dread.value = S.dread;
    uc.lag.value = 4.5 + wear * 2.5;

    const u = tapeMat.uniforms;
    u.tD.value = rtOptics.texture;
    u.tChroma.value = rtChroma.texture;
    u.tHud.value = VB.hud ? VB.hud.texture : null;
    u.t.value = t; u.wear.value = wear; u.burst.value = S.burst;
    u.dread.value = S.dread; u.dropout.value = S.dropout; u.prox.value = S.prox;
    u.frameN.value = fN;
    u.tbe.value.set(
      (0.0011 + wear * 0.0034),                    /* per-line jitter */
      (0.0009 + wear * 0.0026 + S.turn * 0.0012),  /* jelly */
      M.drift * (0.0016 + wear * 0.0030));         /* whole-frame drift */
    u.hs.value.set(M.hsLines / cfg.sceneH, M.hsAmt, M.hsSlope, 1.0 + wear);
    u.track.value.set(M.trackY, M.trackAmt, 0.55 + wear * 0.55);
    u.vshift.value = M.vshift;
    u.hue.value = M.hue;
    u.sat.value = clamp(1.22 - wear * 0.44, 0.30, 1.35);
    u.ring.value = 0.95 + wear * 0.25;

    const ud = dispMat.uniforms;
    ud.tD.value = rtTape.texture;
    ud.wear.value = wear;
    ud.phase.value = fN % 2;
  }

  function alloc(w, h) {
    for (const r of rtField) r && r.dispose();
    for (const r of [rtWeave, rtOptics, rtChroma, rtTape, rtMeter]) r && r.dispose();
    rtField = [ccd(w, h), ccd(w, h)];
    rtWeave = rt(w, h); rtOptics = rt(w, h); rtTape = rt(w, h);
    rtChroma = rt(Math.max(8, Math.round(w / CDIV)), h);
    rtMeter = rt(MW, MH);
    meterBuf = new Uint8Array(MW * MH * 4);
    const v = new THREE.Vector2(w, h);
    weaveMat.uniforms.res.value = v;
    opticsMat.uniforms.res.value = v;
    chromaMat.uniforms.res.value = v;
    chromaMat.uniforms.cres.value = new THREE.Vector2(rtChroma.width, h);
    tapeMat.uniforms.res.value = v;
    dispMat.uniforms.res.value = v;
  }

  return {
    get __rts() {
      return {
        fieldA: rtField[0], fieldB: rtField[1], weave: rtWeave,
        optics: rtOptics, chroma: rtChroma, tape: rtTape,
      };
    },
    get __sig() { return M; },

    init() { alloc(cfg.sceneW, cfg.sceneH); },
    resize(w, h) { alloc(w, h); },

    renderField(scene, camera, field) {
      R.setRenderTarget(rtField[field]);
      R.clear(true, true, false);
      R.render(scene, camera);
      R.setRenderTarget(null);
    },

    present() {
      const q = (VB.quality == null ? 1 : VB.quality);

      weaveMat.uniforms.tA.value = rtField[0].texture;
      weaveMat.uniforms.tB.value = rtField[1].texture;
      blit(weaveMat, rtWeave);

      /* The meter costs a GPU->CPU readback, so it runs at a fraction of the
         frame rate. That is not a compromise: a real AE circuit is slow, and
         the extra latency feeds straight into the hunting. */
      const every = q < 0.5 ? 6 : 2;
      if (M.frameN % every === 0 || M.meterAge > 90) meter();
      M.meterAge++;

      sig(Math.min(0.1, (S.dt || 1 / 59.94) * 2));

      blit(opticsMat, rtOptics);
      blit(chromaMat, rtChroma);
      blit(tapeMat, rtTape);
      blit(dispMat, null);
    },

    repaint() {
      dispMat.uniforms.tD.value = rtTape.texture;
      blit(dispMat, null);
    },
  };
}, 70);
