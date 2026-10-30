/* Sample pet-pack generator — renders the "orbitian" mascot procedurally
   (pure Node, zero deps) and pipes raw RGBA frames into ffmpeg to encode
   VP9-alpha WebM clips (the same transparent-video format dsh-pet uses).

   This doubles as the seed of a "make your own pet" pipeline: swap the
   draw*() functions for your own art (or a video-to-alpha pipeline) and keep
   pets/<pack>/pet.json as the contract.

   Usage: node tools/gen-sample-pet.js   (ffmpeg must be on PATH)
   Critical ffmpeg flags: -pix_fmt yuva420p -auto-alt-ref 0 — without
   auto-alt-ref 0, VP9 alt-reference frames drop the alpha channel. */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

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
    segment(cx - r, cy, cx + r, cy, w, fill),
    segment(cx, cy - r, cx, cy + r, w, fill),
  ];
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

/* --- mascot parts -------------------------------------------------------------- */

const C = {
  bodyTop: hex('#9fd8ff'), bodyBot: hex('#b8a9ff'),
  bodyGrad: y => {
    const k = clamp01((y - 60) / 100);
    return [Math.round(mix(C.bodyTop[0], C.bodyBot[0], k)), Math.round(mix(C.bodyTop[1], C.bodyBot[1], k)), Math.round(mix(C.bodyTop[2], C.bodyBot[2], k)), 255];
  },
  dark: hex('#2c3a55'), glint: [255, 255, 255, 255],
  blush: rgba(hex('#ff9db4'), 0.55), mouth: hex('#2c3a55'),
  foot: hex('#8fc3f2'), shadow: rgba(hex('#3c508c'), 0.16),
  gold: hex('#ffd966'),
};

const BODY = { cx: 160, cy: 104, rx: 62, ry: 55 };
const EYE = { y: 96, dx: 22, rx: 6.5, ry: 9 };
const FLOOR = 158;

function bodyShapes({ sx = 1, sy = 1, dy = 0, feet = null, shadow = 1 }) {
  const shapes = [];
  if (shadow > 0.05) {
    shapes.push(ellipse(BODY.cx, FLOOR + 6, 54 * shadow, 8 * shadow, () => C.shadow));
  }
  shapes.push(ellipse(BODY.cx, BODY.cy + dy, BODY.rx, BODY.ry, C.bodyGrad, { sx, sy }));
  if (feet) {
    const { liftL, liftR } = feet;
    const fy = 1 - Math.min(liftL, 20) / 26; // squash as the foot lifts, floored
    shapes.push(ellipse(BODY.cx - 26, FLOOR - 6 - liftL, 13, 10, () => C.foot, { sy: fy }));
    shapes.push(ellipse(BODY.cx + 26, FLOOR - 6 - liftR, 13, 10, () => C.foot, { sy: fy }));
  }
  return shapes;
}

function faceShapes({ eye = 1, mouth = 'smile', dy = 0 }) {
  const shapes = [];
  for (const side of [-1, 1]) {
    const ex = BODY.cx + side * EYE.dx;
    if (eye > 0.25) {
      shapes.push(ellipse(ex, EYE.y + dy, EYE.rx, EYE.ry * eye, () => C.dark));
      if (eye > 0.7) shapes.push(ellipse(ex + 2, EYE.y - 3 + dy, 2.2, 2.6, () => C.glint));
    } else {
      // blink / closed lid: gentle downward arc
      shapes.push(arcStroke(ex, EYE.y + dy, 7, Math.PI * 0.15, Math.PI * 0.85, 2.4, C.dark));
    }
  }
  shapes.push(ellipse(BODY.cx - 42, 120 + dy, 11, 6.5, () => C.blush));
  shapes.push(ellipse(BODY.cx + 42, 120 + dy, 11, 6.5, () => C.blush));
  if (mouth === 'smile') {
    shapes.push(arcStroke(BODY.cx, 114 + dy, 12, Math.PI * 0.18, Math.PI * 0.82, 2.6, C.mouth));
  } else if (mouth === 'open') {
    shapes.push(ellipse(BODY.cx, 120 + dy, 7, 8, () => C.mouth));
    shapes.push(ellipse(BODY.cx, 123 + dy, 4.4, 4.6, () => rgba(hex('#ff8fa3'), 0.95)));
  } else if (mouth === 'o') {
    shapes.push(ellipse(BODY.cx, 119 + dy, 4.6, 5.2, () => C.mouth));
  }
  return shapes;
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
  /* 4s loop: two breath cycles, two blinks */
  idle: { frames: 120, build(t) {
    const ph = t * 2; // two full cycles
    const sy = 1 + 0.035 * Math.sin(TAU * ph);
    const dy = 2 * Math.sin(TAU * ph);
    const blink = (t > 0.44 && t < 0.50) || (t > 0.94 && t < 1.0);
    return [
      ...bodyShapes({ sy, dy, feet: { liftL: 0, liftR: 0 } }),
      ...faceShapes({ eye: blink ? 0.1 : 1, dy }),
    ];
  } },

  /* 1.6s loop: 2Hz step bob, alternating feet */
  walk: { frames: 48, build(t) {
    const ph = t * 2;
    const bob = Math.abs(Math.sin(TAU * ph)) * 5;
    const liftL = Math.max(0, Math.sin(TAU * ph)) * 8;
    const liftR = Math.max(0, -Math.sin(TAU * ph)) * 8;
    return [
      ...bodyShapes({
        sy: 1 - 0.03 * Math.sin(TAU * ph), dy: -bob,
        feet: { liftL, liftR }, shadow: 1 - bob / 22,
      }),
      ...faceShapes({ eye: 1, dy: -bob, mouth: 'smile' }),
    ];
  } },

  /* 1.6s one-shot: single jump arc, open mouth, sparkles */
  happy: { frames: 48, build(t) {
    const jump = Math.sin(Math.PI * t);
    const dy = -46 * jump;
    return [
      ...bodyShapes({
        sy: 1 + 0.1 * jump, sx: 1 - 0.07 * jump, dy,
        // feet ride along with the jumping body (46px body lift + slight tuck),
        // otherwise they strand down by the shadow
        feet: { liftL: 54 * jump, liftR: 54 * jump }, shadow: 1 - 0.45 * jump,
      }),
      ...faceShapes({ eye: 1, dy, mouth: 'open' }),
      ...plus(252, 62, 9 * jump, 3.4, rgba(C.gold, jump)).flat(),
      ...plus(74, 52, 7 * jump, 3, rgba(C.gold, 0.85 * jump)).flat(),
      ...plus(160, 34, 5.5 * jump, 2.6, rgba(C.gold, 0.7 * jump)).flat(),
    ];
  } },

  /* 4s loop: slow breathing, closed eyes, o-mouth, rising Z stream */
  sleep: { frames: 120, build(t) {
    const sy = 1 + 0.022 * Math.sin(TAU * t);
    const shapes = [
      ...bodyShapes({ sy, dy: 4, feet: { liftL: 0, liftR: 0 }, shadow: 0.8 }),
      ...faceShapes({ eye: 0, dy: 4, mouth: 'o' }),
    ];
    for (let i = 0; i < 3; i++) {
      const p = (t + i / 3) % 1; // three Z's staggered -> seamless loop
      const fade = Math.sin(Math.PI * p);
      shapes.push(...zGlyph(196 + p * 26, 74 - p * 34, 5 + i * 1.6 + p * 3, 2.6, 0.85 * fade));
    }
    return shapes;
  } },
};

/* --- encode ------------------------------------------------------------------ */

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

(async () => {
  for (const [name, spec] of Object.entries(ANIMS)) {
    await encode(name, spec.frames, spec.build);
  }
  console.log('done.');
})().catch(err => { console.error(err); process.exit(1); });
