/* Sample pet-pack generator — renders the "orbitian" mascot procedurally
   (pure Node, zero deps) and pipes raw RGBA frames into ffmpeg to encode
   VP9-alpha WebM clips (the same transparent-video format dsh-pet uses).

   v2 redesign: the mascot is now a little moon-spirit wearing a tilted
   orbital ring with a golden satellite circling it — the "orbit" in
   Orbitian finally made visible. Body gains an outline, rim highlight,
   belly crescent, hands and two-glint eyes.

   This doubles as the seed of a "make your own pet" pipeline: swap the
   draw*() functions for your own art (or a video-to-alpha pipeline) and keep
   pets/<pack>/pet.json as the contract.

   Usage: node tools/gen-sample-pet.js            render all anims to webm
          node tools/gen-sample-pet.js --preview  render one PNG contact
                                                  sheet per anim (no encode)
          node tools/gen-sample-pet.js --ascii idle 0.3   terminal preview
   Critical ffmpeg flags: -pix_fmt yuva420p -auto-alt-ref 0 — without
   auto-alt-ref 0, VP9 alt-reference frames drop the alpha channel. */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CW = 320, CH = 180, FPS = 30;

/* --- tiny SDF rasterizer ------------------------------------------------------ */

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, k) => a + (b - a) * k;

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];
}
const rgba = (c, a) => [c[0], c[1], c[2], Math.round(a * 255)];

/* ellipse with per-axis squash (sx, sy about its own centre) — the workhorse
   for breathing / squash-and-stretch without a real transform stack */
function ellipse(cx, cy, rx, ry, fill, { sx = 1, sy = 1 } = {}) {
  return {
    bbox: [cx - rx * sx - 2, cy - ry * sy - 2, cx + rx * sx + 2, cy + ry * sy + 2],
    sdf(x, y) {
      const qx = (x - cx) / sx, qy = (y - cy) / sy;
      const k = Math.hypot(qx / rx, qy / ry) - 1;
      return k * Math.min(rx * sx, ry * sy);
    },
    fill,
  };
}

/* circular-arc stroke; a0..a1 in radians (screen coords, y down) */
function arcStroke(cx, cy, r, a0, a1, w, fill) {
  return {
    bbox: [cx - r - w, cy - r - w, cx + r + w, cy + r + w],
    sdf(x, y) {
      const dx = x - cx, dy = y - cy;
      const ang = Math.atan2(dy, dx);
      let a = ang;
      // normalize a into [a0, a1] window (arcs here never exceed π)
      while (a < a0 - Math.PI) a += 2 * Math.PI;
      while (a > a1 + Math.PI) a -= 2 * Math.PI;
      if (a < a0 - 1e-6 || a > a1 + 1e-6) return 1e6;
      return Math.abs(Math.hypot(dx, dy) - r) - w / 2;
    },
    fill: () => fill,
  };
}

/* elliptical-arc stroke — same windowing as arcStroke but on an rx/ry ring;
   this is what the orbital ring (and the body rim-light) are drawn with.
   Distance is the true Euclidean distance to the curve (Newton-refined foot
   point). The cheap scaled-space pseudo-distance (hypot(q)-1)*min(rx,ry)
   lower-bounds it and culls far pixels, but must not paint by itself: on a
   squat ellipse it flares w*rx/min(rx,ry) past the end caps, and clipping
   that flare at the bbox is what used to slice the ring's sides flat. */
function ellipseArcStroke(cx, cy, rx, ry, a0, a1, w, fill) {
  const m = Math.min(rx, ry);
  const pad = w / 2 + 2;
  return {
    bbox: [cx - rx - pad, cy - ry - pad, cx + rx + pad, cy + ry + pad],
    sdf(x, y) {
      const P = (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * m;
      if (Math.abs(P) > w / 2 + 1.5) return 1e6;
      let a = Math.atan2((y - cy) / ry, (x - cx) / rx);
      while (a < a0 - Math.PI) a += 2 * Math.PI;
      while (a > a1 + Math.PI) a -= 2 * Math.PI;
      if (a < a0 - 1e-6 || a > a1 + 1e-6) return 1e6;
      let t = a;
      for (let i = 0; i < 3; i++) {
        const ct = Math.cos(t), st = Math.sin(t);
        const dx = x - (cx + rx * ct), dy = y - (cy + ry * st);
        const d1 = -dx * rx * st + dy * ry * ct;                       // (p-E)·E'
        const d2 = rx * rx * st * st + ry * ry * ct * ct + dx * rx * ct + dy * ry * st;
        if (Math.abs(d2) < 1e-6) break;
        t += Math.max(-0.4, Math.min(0.4, d1 / d2));
      }
      return Math.hypot(x - (cx + rx * Math.cos(t)), y - (cy + ry * Math.sin(t))) - w / 2;
    },
    fill: () => fill,
  };
}

function segment(x1, y1, x2, y2, w, fill) {
  const pad = w / 2 + 1;
  return {
    bbox: [Math.min(x1, x2) - pad, Math.min(y1, y2) - pad, Math.max(x1, x2) + pad, Math.max(y1, y2) + pad],
    sdf(x, y) {
      const dx = x2 - x1, dy = y2 - y1;
      const t = clamp01(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy));
      return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) - w / 2;
    },
    fill: () => fill,
  };
}

function plus(cx, cy, r, w, fill) {
  return [
    segment(cx - r, cy - r, cx + r, cy + r, w, fill),
    segment(cx - r, cy + r, cx + r, cy - r, w, fill),
  ];
}

function rect(x0, y0, x1, y1, fill) {
  const hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return {
    bbox: [x0 - 1, y0 - 1, x1 + 1, y1 + 1],
    sdf(x, y) {
      const qx = Math.abs(x - cx) - hw, qy = Math.abs(y - cy) - hh;
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
    },
    fill: typeof fill === 'function' ? fill : () => fill,
  };
}

/* paint one frame: shapes are drawn in order onto a transparent RGBA buffer */
function renderFrame(shapes) {
  const buf = Buffer.alloc(CW * CH * 4);
  for (const sh of shapes) {
    const [x0, y0, x1, y1] = sh.bbox;
    const r0 = Math.max(0, Math.floor(y0)), r1 = Math.min(CH - 1, Math.ceil(y1));
    const c0 = Math.max(0, Math.floor(x0)), c1 = Math.min(CW - 1, Math.ceil(x1));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const cov = clamp01(0.5 - sh.sdf(col + 0.5, row + 0.5));
        if (cov <= 0) continue;
        const [sr, sg, sb, sa] = sh.fill(col + 0.5, row + 0.5);
        const a = (sa / 255) * cov;
        if (a <= 0) continue;
        const i = (row * CW + col) * 4;
        const da = buf[i + 3] / 255;
        const outA = a + da * (1 - a);
        buf[i] = Math.round((sr * a + buf[i] * da * (1 - a)) / (outA || 1));
        buf[i + 1] = Math.round((sg * a + buf[i + 1] * da * (1 - a)) / (outA || 1));
        buf[i + 2] = Math.round((sb * a + buf[i + 2] * da * (1 - a)) / (outA || 1));
        buf[i + 3] = Math.round(outA * 255);
      }
    }
  }
  return buf;
}

/* --- mascot palette / layout --------------------------------------------------- */

const C = {
  bodyTop: hex('#9fd8ff'), bodyBot: hex('#b3a0ff'),
  bodyGrad: y => {
    const k = clamp01((y - 55) / 100);
    return [Math.round(mix(C.bodyTop[0], C.bodyBot[0], k)), Math.round(mix(C.bodyTop[1], C.bodyBot[1], k)), Math.round(mix(C.bodyTop[2], C.bodyBot[2], k)), 255];
  },
  outline: hex('#313d66'),
  dark: hex('#26304d'), glint: [255, 255, 255, 255],
  blush: rgba(hex('#ff9db4'), 0.5), mouth: hex('#26304d'),
  limb: hex('#8ec6f8'), limbDeep: hex('#6aa7e8'),
  bellyTop: hex('#f2f9ff'), bellyBot: hex('#dcedfb'),
  bellyGrad: y => {
    const k = clamp01((y - 121) / 30);
    return [Math.round(mix(C.bellyTop[0], C.bellyBot[0], k)), Math.round(mix(C.bellyTop[1], C.bellyBot[1], k)), Math.round(mix(C.bellyTop[2], C.bellyBot[2], k)), 235];
  },
  rim: rgba([255, 255, 255], 0.42),
  shadow: rgba(hex('#3c508c'), 0.13),
  gold: hex('#ffd166'),
  ring: rgba([255, 255, 255], 0.9),
  ringGlow: rgba([255, 255, 255], 0.16),
};

const BODY = { cx: 160, cy: 104, rx: 62, ry: 55 };
const EYE = { y: 94, dx: 21, rx: 7, ry: 9.5 };
const FLOOR = 158;
/* the tilted orbital ring worn around the head — front arc crosses the
   forehead, back arc passes behind the crown; sized so the back half
   visibly clears the head and reads as encircling it */
const RING = { cy: 52, rx: 78, ry: 17, w: 4.5 };

/* --- mascot parts -------------------------------------------------------------- */

/* body: ground shadow -> outline -> gradient fill -> rim-light -> belly.
   The outline is a bigger ellipse painted under the fill (painter's trick —
   no boolean ops in this rasterizer). */
function bodyShapes({ sx = 1, sy = 1, dx = 0, dy = 0, shadow = 1, fill = C.bodyGrad, belly = true, rim = true, outline = true }) {
  const cx = BODY.cx + dx, cy = BODY.cy + dy;
  const shapes = [];
  if (shadow > 0.05) {
    shapes.push(ellipse(cx, FLOOR + 7, 54 * shadow, 7.5 * shadow, () => C.shadow));
  }
  if (outline) {
    shapes.push(ellipse(cx, cy, BODY.rx, BODY.ry, () => C.outline, { sx: sx * 1.045, sy: sy * 1.05 }));
  }
  shapes.push(ellipse(cx, cy, BODY.rx, BODY.ry, fill, { sx, sy }));
  if (rim) {
    // glossy rim highlight hugging the upper-left edge, inside the outline
    shapes.push(ellipseArcStroke(cx, cy, (BODY.rx - 6) * sx, (BODY.ry - 6) * sy, Math.PI * 1.06, Math.PI * 1.32, 7, C.rim));
  }
  if (belly) {
    shapes.push(ellipse(cx, cy + 32, 30 * sx, 15 * sy, C.bellyGrad));
  }
  return shapes;
}

/* hands: little rounded nubs with a glint so they detach from the body;
   pass rise/dx per side to swing or raise them */
function handShapes({ dx = 0, dy = 0, l = {}, r = {} }) {
  const mk = (side, o) => {
    const hx = BODY.cx + side * 60 + dx + (o.dx || 0);
    const hy = 119 + dy + (o.dy || 0);
    return [
      ellipse(hx, hy, 8, 6.8, () => C.outline, { sx: 1.18, sy: 1.2 }),
      ellipse(hx, hy, 8, 6.8, () => C.limb),
      ellipse(hx - 2.4, hy - 2.2, 3, 2.2, () => rgba([255, 255, 255], 0.55)),
    ];
  };
  return [...mk(-1, l), ...mk(1, r)];
}

function feetShapes({ dx = 0, liftL = 0, liftR = 0, fade = 0 }) {
  const fy = lift => 1 - Math.min(lift, 20) / 26; // squash as the foot lifts
  const vis = 1 - clamp01(fade); // airborne feet tuck away (fade out)
  const limbA = () => rgba(C.limb, vis);
  const outA = () => rgba(C.outline, vis);
  const mk = (side, lift) => {
    const fx = BODY.cx + side * 26 + dx;
    const fyy = FLOOR - 7 - lift;
    return [
      ellipse(fx, fyy, 12, 9, outA, { sx: 1.14, sy: 1.18 }),
      ellipse(fx, fyy, 12, 9, limbA, { sy: fy(lift) }),
      ellipse(fx - 3.5, fyy - 3.5, 4, 2.4, () => rgba([255, 255, 255], 0.45 * vis)),
    ];
  };
  return [...mk(-1, liftL), ...mk(1, liftR)];
}

/* eyeDx/eyeDy shift the whole eye pair (gaze direction); mouth stays put.
   eyes are bigger than v1 with a double glint so they read at small sizes. */
function faceShapes({ eye = 1, mouth = 'smile', dy = 0, dx = 0, eyeDx = 0, eyeDy = 0, blush = true, eyeFill = null }) {
  const shapes = [];
  for (const side of [-1, 1]) {
    const ex = BODY.cx + side * EYE.dx + dx + eyeDx;
    const ey = EYE.y + dy + eyeDy;
    if (eye > 0.25) {
      shapes.push(ellipse(ex, ey, EYE.rx, EYE.ry * eye, eyeFill ? () => eyeFill : () => C.dark));
      if (eye > 0.7) {
        shapes.push(ellipse(ex + 2.2, ey - 3, 2.4, 2.8, () => C.glint));
        shapes.push(ellipse(ex - 2.2, ey + 2.6, 1.1, 1.3, () => rgba([255, 255, 255], 0.8)));
      }
    } else {
      // blink / closed lid: gentle downward arc
      shapes.push(arcStroke(ex, ey, 7.5, Math.PI * 0.15, Math.PI * 0.85, 2.4, C.dark));
    }
  }
  if (blush) {
    shapes.push(ellipse(BODY.cx - 41 + dx, 112 + dy, 10, 6, () => C.blush));
    shapes.push(ellipse(BODY.cx + 41 + dx, 112 + dy, 10, 6, () => C.blush));
  }
  const mx = BODY.cx + dx;
  if (mouth === 'smile') {
    shapes.push(arcStroke(mx, 113 + dy, 13, Math.PI * 0.18, Math.PI * 0.82, 2.6, C.mouth));
  } else if (mouth === 'cat') {
    // two small arcs meeting in the middle — a classic cat mouth
    for (const s of [-1, 1]) {
      shapes.push(arcStroke(mx + s * 4.6, 111 + dy, 5.4, Math.PI * 0.08, Math.PI * 0.92, 2.2, C.mouth));
    }
  } else if (mouth === 'flat') {
    shapes.push(segment(mx - 8, 116 + dy, mx + 8, 116 + dy, 2.4, C.mouth));
  } else if (mouth === 'open') {
    shapes.push(ellipse(mx, 118 + dy, 7, 8, () => C.mouth));
    shapes.push(ellipse(mx, 121 + dy, 4.4, 4.6, () => rgba(hex('#ff8fa3'), 0.95)));
  } else if (mouth === 'o') {
    shapes.push(ellipse(mx, 117 + dy, 4.6, 5.2, () => C.mouth));
  }
  return shapes;
}

/* the orbital ring, split into the half behind the head and the half in
   front; the satellite rides the ring at angle th and flips depth as it
   passes behind. opts tune per-animation behaviour. */
function ringShapes({ dx = 0, dy = 0, th, alpha = 1, satColor = null, satScale = 1, glow = 1 }) {
  const cx = BODY.cx + dx;
  const cy = RING.cy + dy;
  const A = a => rgba([255, 255, 255], a);
  const back = [], front = [];
  const backHalf = { arr: back, a0: Math.PI, a1: Math.PI * 2 };   // upper half — behind head
  const frontHalf = { arr: front, a0: 0, a1: Math.PI };           // lower half — in front
  const halves = [backHalf, frontHalf];
  for (const h of halves) {
    if (glow > 0.05) {
      h.arr.push(ellipseArcStroke(cx, cy, RING.rx, RING.ry, h.a0, h.a1, RING.w + 6, A(0.16 * alpha * glow)));
    }
    h.arr.push(ellipseArcStroke(cx, cy, RING.rx, RING.ry, h.a0, h.a1, RING.w, A(0.9 * alpha)));
    if (h === frontHalf) {
      // the head casts a soft shadow onto the near arc where they meet
      h.arr.push(ellipseArcStroke(cx, cy, RING.rx, RING.ry, Math.PI * 0.3, Math.PI * 0.7, RING.w, rgba(C.outline, 0.16 * alpha)));
    }
  }
  // end beads: tiny round caps on the ring's leftmost/rightmost points. The
  // two half-arcs butt exactly there; at display scale the seam can read as
  // a nick (and the satellite darkens it in passing) — beads close it.
  for (const side of [-1, 1]) {
    back.push(ellipse(cx + side * RING.rx, cy, RING.w * 0.78, RING.w * 0.78, () => A(Math.min(1, 0.92 * alpha))));
  }
  if (th != null) {
    const col = satColor || C.gold;
    const isFront = Math.sin(th) >= 0;
    // near pass: bigger and brighter with a short comet trail along the ring;
    // behind the head: slightly smaller and dimmer so the lap reads as 3D
    // (kept close to ring size — shrinking too much makes it look detached)
    const depth = isFront ? 1.16 : 0.92;
    const a = alpha * (isFront ? 1 : 0.62);
    if (isFront) {
      for (let k = 1; k <= 2; k++) {
        const tt = th - 0.13 * k;
        const tx = cx + RING.rx * Math.cos(tt);
        const ty = cy + RING.ry * Math.sin(tt);
        front.push(ellipse(tx, ty, 3.4 - k, 3.4 - k, () => rgba(col, (0.4 - 0.14 * k) * alpha)));
      }
    }
    const sx = cx + RING.rx * Math.cos(th);
    const syy = cy + RING.ry * Math.sin(th);
    const sr = 4.6 * depth * satScale;
    // no dark rim on the satellite: riding over the white ring it read as a
    // bite out of the line each time the dot passed an end bead
    const sat = [
      ellipse(sx, syy, sr + 4, sr + 4, () => rgba(col, 0.3 * a)),
      ellipse(sx, syy, sr, sr, () => rgba(col, a)),
      ellipse(sx - 1.2, syy - 1.4, 1.5, 1.7, () => rgba([255, 255, 255], 0.9 * a)),
    ];
    (isFront ? front : back).push(...sat);
  }
  return { back, front };
}

/* a "Z" glyph from three strokes, floating up with phase p (0..1) */
function zGlyph(cx, cy, s, w, alpha) {
  const fill = rgba(C.gold, alpha);
  return [
    segment(cx - s, cy - s, cx + s, cy - s, w, fill),
    segment(cx - s, cy - s, cx + s, cy + s, w, fill),
    segment(cx - s, cy + s, cx + s, cy + s, w, fill),
  ];
}

/* --- animations -------------------------------------------------------------- */

const TAU = Math.PI * 2;

const ANIMS = {
  /* 4s loop: two breath cycles, two blinks, satellite lapping once per loop */
  idle: { frames: 120, build(t) {
    const ph = t * 2;
    const sy = 1 + 0.035 * Math.sin(TAU * ph);
    const dy = 2 * Math.sin(TAU * ph);
    const blink = (t > 0.44 && t < 0.50) || (t > 0.94 && t < 1.0);
    const ring = ringShapes({ dy, th: TAU * t });
    return [
      ...ring.back,
      ...bodyShapes({ sy, dy }),
      ...feetShapes({}),
      ...ring.front,
      ...handShapes({ dy }),
      ...faceShapes({ eye: blink ? 0.1 : 1, dy, mouth: 'cat' }),
    ];
  } },

  /* 1.6s loop: 2Hz step bob, swinging hands, satellite circling once per lap */
  walk: { frames: 48, build(t) {
    const ph = t * 2;
    const bob = Math.abs(Math.sin(TAU * ph)) * 5;
    const liftL = Math.max(0, Math.sin(TAU * ph)) * 8;
    const liftR = Math.max(0, -Math.sin(TAU * ph)) * 8;
    const dy = -bob;
    const ring = ringShapes({ dy, th: TAU * t });
    return [
      ...ring.back,
      ...bodyShapes({ sy: 1 - 0.03 * Math.sin(TAU * ph), dy, shadow: 1 - bob / 22 }),
      ...feetShapes({ liftL, liftR }),
      ...ring.front,
      ...handShapes({ dy, l: { dx: 4 * Math.sin(TAU * ph) }, r: { dx: -4 * Math.sin(TAU * ph) } }),
      ...faceShapes({ eye: 1, dy, mouth: 'smile' }),
    ];
  } },

  /* 1.6s one-shot: single jump arc, hands up, open mouth, sparkles. Jump is
     capped so the ring's top never leaves the canvas; feet fade as the
     body leaves the ground (tucked in flight, not pasted on the belly) */
  happy: { frames: 48, build(t) {
    const jump = Math.sin(Math.PI * t);
    const dy = -32 * jump;
    const ring = ringShapes({ dy, th: TAU * t });
    return [
      ...ring.back,
      ...bodyShapes({
        sy: 1 + 0.16 * jump, sx: 1 - 0.12 * jump, dy,
        shadow: 1 - 0.45 * jump,
      }),
      ...feetShapes({ liftL: 34 * jump, liftR: 34 * jump, fade: jump * 1.15 }),
      ...ring.front,
      ...handShapes({
        dy, l: { dy: -30 * jump, dx: -6 * jump }, r: { dy: -30 * jump, dx: 6 * jump },
      }),
      ...faceShapes({ eye: 1, dy, mouth: 'open' }),
      ...plus(254, 56, 9 * jump, 3.4, rgba(C.gold, jump)).flat(),
      ...plus(66, 64, 7 * jump, 3, rgba(C.gold, 0.85 * jump)).flat(),
      ...plus(160, 30, 5.5 * jump, 2.6, rgba(C.gold, 0.7 * jump)).flat(),
    ];
  } },

  /* 4s loop: slow breathing, closed eyes, o-mouth, rising Z stream; the ring
     dims and the satellite parks at the top of the ring like a little moon */
  sleep: { frames: 120, build(t) {
    const sy = 1 + 0.022 * Math.sin(TAU * t);
    const dy = 4;
    const pulse = 0.55 + 0.45 * Math.sin(TAU * t * 2);
    const ring = ringShapes({ dy, th: -Math.PI / 2, alpha: 0.4, satScale: 1.1 });
    const shapes = [
      ...ring.back,
      ...bodyShapes({ sy, dy, shadow: 0.8, belly: true }),
      ...feetShapes({}),
      ...ring.front,
      // parked satellite gets its own slow twinkle on top of the parked glow
      ellipse(BODY.cx, RING.cy + dy - RING.ry, 8.5 * (0.9 + 0.2 * pulse), 8.5 * (0.9 + 0.2 * pulse), () => rgba(C.gold, 0.18 * pulse)),
      ...handShapes({ dy }),
      ...faceShapes({ eye: 0, dy, mouth: 'o' }),
    ];
    for (let i = 0; i < 3; i++) {
      const p = (t + i / 3) % 1; // three Z's staggered -> seamless loop
      const fade = Math.sin(Math.PI * p);
      shapes.push(...zGlyph(198 + p * 26, 72 - p * 32, 5 + i * 1.6 + p * 3, 2.6, 0.85 * fade));
    }
    return shapes;
  } },

  /* ===== seasonal example ===== */

  /* 3s loop (season [10]): pumpkin suit — orange gradient body, green stem,
     triangle eyes, zigzag grin, flapping bat wings; the satellite turns into
     a glowing jack-o'-lantern light on an amber ring */
  halloween: { frames: 90, build(t) {
    const bob = 3 * Math.sin(TAU * 2 * t);
    const flap = Math.sin(TAU * 2 * t) * 0.5 + 0.5;
    const pumpkin = y => {
      const k = clamp01((y - 50) / 95);
      return [255, Math.round(mix(179, 110, k)), Math.round(mix(71, 26, k)), 255];
    };
    const ring = ringShapes({ dy: bob, th: TAU * t * 0.75, satColor: hex('#ff9d4d') });
    const shapes = [];
    // wings first so the body overlaps their roots; three segments each so
    // they read as wings, not fins
    for (const side of [-1, 1]) {
      const wy = BODY.cy - 6 + flap * 9;
      shapes.push(ellipse(BODY.cx + side * (BODY.rx + 8), wy, 19, 7.5, () => hex('#2b2334')));
      shapes.push(ellipse(BODY.cx + side * (BODY.rx + 24), wy + 6 - flap * 5, 14, 5.5, () => hex('#2b2334')));
      shapes.push(ellipse(BODY.cx + side * (BODY.rx + 37), wy + 13 - flap * 9, 9, 4, () => hex('#2b2334')));
    }
    shapes.push(...ring.back);
    shapes.push(rect(BODY.cx - 5, BODY.cy - BODY.ry - 11 + bob, BODY.cx + 5, BODY.cy - BODY.ry + 7 + bob, hex('#6b8f3a')));
    shapes.push(...bodyShapes({ sy: 1 + 0.02 * Math.sin(TAU * 2 * t), dy: bob, fill: pumpkin }));
    shapes.push(...feetShapes({ dy: bob }));
    shapes.push(...ring.front);
    shapes.push(...handShapes({ dy: bob }));
    // triangle eyes (stroke outlines)
    for (const side of [-1, 1]) {
      const ex = BODY.cx + side * 21;
      const ty = EYE.y - 5 + bob, by = EYE.y + 7 + bob, s = 8;
      shapes.push(segment(ex - s, by, ex + s, by, 2.4, C.dark));
      shapes.push(segment(ex - s, by, ex, ty, 2.4, C.dark));
      shapes.push(segment(ex + s, by, ex, ty, 2.4, C.dark));
    }
    // zigzag grin
    const gy = 128 + bob;
    const xs = [-24, -12, 0, 12, 24];
    for (let i = 0; i < xs.length - 1; i++) {
      shapes.push(segment(
        BODY.cx + xs[i], gy + (i % 2 ? 4 : -3),
        BODY.cx + xs[i + 1], gy + ((i + 1) % 2 ? 4 : -3),
        2.8, C.mouth,
      ));
    }
    return shapes;
  } },

  /* ===== state animations (workflow / agent linkage, role:state) ===== */

  /* 3s loop: head sway, upward gaze, satellite hesitating back and forth on
     the ring while three thought dots rise top right */
  thinking: { frames: 90, build(t) {
    const swx = 6 * Math.sin(TAU * t);
    const bob = 2 * Math.sin(TAU * 2 * t);
    // satellite rocks ±35° around the ring's top, deciding
    const th = -Math.PI / 2 + 0.6 * Math.sin(TAU * t * 1.5);
    const ring = ringShapes({ dx: swx, dy: bob, th });
    const shapes = [
      ...ring.back,
      ...bodyShapes({ sy: 1.01, dx: swx, dy: bob }),
      ...feetShapes({ dx: swx }),
      ...ring.front,
      ...handShapes({ dx: swx, dy: bob }),
      ...faceShapes({ eye: 1, dx: swx, dy: bob, eyeDx: -2, eyeDy: -4 }),
    ];
    for (let i = 0; i < 3; i++) {
      const p = (t + i / 3) % 1;
      const fade = Math.sin(Math.PI * p);
      shapes.push(ellipse(232 + i * 9, 66 - p * 16, 3.4, 3.4, () => rgba(C.gold, 0.9 * fade)));
    }
    return shapes;
  } },

  /* 1.2s loop: 2Hz typing bob, one hand tapping a small screen bottom-left
     with blinking code lines */
  working: { frames: 36, build(t) {
    const ph = t * 2;
    const bob = Math.abs(Math.sin(TAU * ph)) * 4;
    const swx = 1.5 * Math.sin(TAU * ph);
    const tap = 2 * (Math.sin(TAU * ph * 2) > 0 ? 1 : 0);
    const ring = ringShapes({ dx: swx, dy: -bob, th: TAU * t / 3 });
    const shapes = [
      rect(42, 112, 112, 160, rgba(hex('#22344d'), 0.96)),
    ];
    for (let i = 0; i < 4; i++) {
      const lit = ((t * 3 + i) % 1) > 0.45 ? 0.95 : 0.3;
      const len = i % 2 ? 44 : 30;
      shapes.push(segment(52, 122 + i * 9, 52 + len, 122 + i * 9, 2.6, rgba(hex('#9fe6b2'), lit)));
    }
    shapes.push(...ring.back);
    shapes.push(...bodyShapes({
      sy: 1 - 0.02 * Math.sin(TAU * ph), dx: swx, dy: -bob,
      shadow: 1 - bob / 22,
    }));
    shapes.push(...feetShapes({ dx: swx }));
    shapes.push(...ring.front);
    shapes.push(...handShapes({
      dx: swx, dy: -bob,
      // left hand rests on the screen edge and taps; right hand stays put
      l: { dx: -24, dy: -2 - tap }, r: {},
    }));
    shapes.push(...faceShapes({ eye: 1, dx: swx, dy: -bob, eyeDx: -10, eyeDy: 5, mouth: 'flat' }));
    return shapes;
  } },

  /* 4s loop: gentle left-right sway, half-lidded eyes, flat mouth — waiting
     (and the satellite takes its sweet time, too) */
  waiting: { frames: 120, build(t) {
    const swx = 10 * Math.sin(TAU * t);
    const ring = ringShapes({ dx: swx, th: TAU * t / 3 });
    return [
      ...ring.back,
      ...bodyShapes({ dx: swx, shadow: 1 - Math.abs(swx) / 80 }),
      ...feetShapes({ dx: swx }),
      ...ring.front,
      ...handShapes({ dx: swx, dy: 1 }),
      ...faceShapes({ eye: 0.42, dx: swx, dy: 1, mouth: 'flat' }),
    ];
  } },

  /* 1.6s one-shot: two quick hops, hands up, satellite lapping with a fading
     comet trail, star bursts and falling confetti */
  celebrate: { frames: 48, build(t) {
    const jump = Math.abs(Math.sin(2 * Math.PI * t));
    const dy = -28 * jump;
    const th = TAU * t;
    const shapes = [
      ...ringShapes({ dy, th: th - 0.55, alpha: 0.3, glow: 0 }).back,
      ...ringShapes({ dy, th: th - 0.28, alpha: 0.55, glow: 0 }).back,
    ];
    const ring = ringShapes({ dy, th });
    shapes.push(...ring.back);
    shapes.push(...bodyShapes({
      sy: 1 + 0.14 * jump, sx: 1 - 0.1 * jump, dy,
      shadow: 1 - 0.5 * jump,
    }));
    shapes.push(...feetShapes({ liftL: 6 * jump, liftR: 6 * jump, fade: jump * 1.1 }));
    shapes.push(...ring.front);
    shapes.push(...handShapes({
      dy, l: { dy: -34 * jump, dx: -8 * jump }, r: { dy: -34 * jump, dx: 8 * jump },
    }));
    shapes.push(...faceShapes({ eye: 1, dy, mouth: 'open' }));
    shapes.push(...plus(96, 64, 9 * jump, 3.2, rgba(C.gold, jump)).flat());
    shapes.push(...plus(228, 56, 8 * jump, 3, rgba(C.gold, 0.85 * jump)).flat());
    shapes.push(...plus(160, 32, 6.5 * jump, 2.6, rgba(C.gold, 0.8 * jump)).flat());
    const conf = [hex('#ff9db4'), hex('#7fd0ff'), C.gold, hex('#9fe6b2')];
    for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI) / 2 + t * 2.2;
      const r = 16 + t * 58;
      shapes.push(ellipse(160 + Math.cos(ang) * r, 84 + Math.sin(ang) * r * 0.55, 2.8, 2.8, () => rgba(conf[i], Math.max(0, 1 - t * 1.1))));
    }
    return shapes;
  } },

  /* 1.6s one-shot: decaying shake, dimmed body, worried eyes, sweat drop;
     the satellite turns warning-red and jitters around the ring */
  error: { frames: 48, build(t) {
    const shake = t < 0.5 ? Math.sin(t * TAU * 6) * 4 * (1 - t * 2) : 0;
    const jitter = t < 0.5 ? Math.sin(t * TAU * 24) * 0.18 : 0;
    const dim = (x, y) => {
      const c = C.bodyGrad(x, y);
      return [Math.round(c[0] * 0.72), Math.round(c[1] * 0.7), Math.round(c[2] * 0.8), 255];
    };
    const red = hex('#ff5d5d');
    const ring = ringShapes({ dy: 2, th: TAU * t * 1.5 + jitter, alpha: 0.7, satColor: red, glow: 0.4 });
    return [
      ...ring.back,
      ...bodyShapes({ dx: shake, sy: 0.97, dy: 2, shadow: 0.9, fill: dim }),
      ...feetShapes({ dx: shake }),
      ...ring.front,
      ...handShapes({ dx: shake, dy: 2, l: { dx: 6, dy: -4 }, r: { dx: -6, dy: -4 } }),
      ...faceShapes({ eye: 0.45, dx: shake, dy: 2, mouth: 'o' }),
      ellipse(218 + shake, 54 + 7 * t, 4.6, 6.4, () => rgba(hex('#7fd0ff'), Math.max(0, 1 - t * 1.2))),
    ];
  } },
};

/* --- encode / preview ---------------------------------------------------------- */

function encode(name, frames, build) {
  return new Promise((resolveP, rejectP) => {
    const out = path.join(__dirname, '..', 'pets', 'orbitian', `${name}.webm`);
    const ff = spawn('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${CW}x${CH}`, '-r', String(FPS),
      '-i', 'pipe:0',
      '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0',
      '-crf', '24', '-b:v', '0', '-deadline', 'good', '-cpu-used', '2',
      '-an', out,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    ff.on('error', rejectP);
    ff.on('close', code => (code === 0 ? resolveP() : rejectP(new Error(`ffmpeg exited ${code} for ${name}`))));
    for (let i = 0; i < frames; i++) {
      const shapes = build(i / frames);
      ff.stdin.write(renderFrame(shapes.flat()));
    }
    ff.stdin.end();
    console.log(`[gen] ${name}: ${frames} frames -> ${out}`);
  });
}

/* contact sheet: one PNG per anim holding 4 evenly spaced frames */
function previewSheet(name, spec) {
  const dir = path.join(__dirname, '..', 'pets', 'orbitian', '_preview');
  fs.mkdirSync(dir, { recursive: true });
  const picks = [0.05, 0.35, 0.65, 0.9].map(p => Math.floor(p * spec.frames));
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${CW}x${CH}`, '-r', '1',
    '-i', 'pipe:0', '-frames:v', '4',
    '-filter_complex', `[0]tile=4x1[out]`,
    '-map', '[out]', '-pix_fmt', 'rgba', path.join(dir, `${name}.png`),
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  return new Promise((res, rej) => {
    ff.on('error', rej);
    ff.on('close', c => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`))));
    for (const i of picks) ff.stdin.write(renderFrame(spec.build(i / spec.frames).flat()));
    ff.stdin.end();
    console.log(`[preview] ${name} -> _preview/${name}.png`);
  });
}

/* terminal preview: downsample a frame into a luminance ASCII ramp — the
   only way to "see" the mascot without a display */
function asciiPreview(name, t) {
  const spec = ANIMS[name];
  if (!spec) throw new Error(`unknown anim: ${name}`);
  const buf = renderFrame(spec.build(t).flat());
  const cols = 78, rows = 36;
  const ramp = ' .:-=+*#%@';
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const x = Math.floor((c + 0.5) * CW / cols);
      const y = Math.floor((r + 0.5) * CH / rows);
      const i = (y * CW + x) * 4;
      const a = buf[i + 3] / 255;
      const lum = (buf[i] * 0.3 + buf[i + 1] * 0.59 + buf[i + 2] * 0.11) / 255;
      const v = a * (0.15 + 0.85 * lum);
      line += ramp[Math.min(ramp.length - 1, Math.floor(v * ramp.length))];
    }
    console.log(line);
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--ascii') { asciiPreview(args[1] || 'idle', parseFloat(args[2]) || 0.3); return; }
  if (args[0] === '--preview') {
    for (const [name, spec] of Object.entries(ANIMS)) await previewSheet(name, spec);
    console.log('previews done.');
    return;
  }
  for (const [name, spec] of Object.entries(ANIMS)) {
    await encode(name, spec.frames, spec.build);
  }
  console.log('done.');
})().catch(err => { console.error(err); process.exit(1); });
