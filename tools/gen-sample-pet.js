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

function bodyShapes({ sx = 1, sy = 1, dx = 0, dy = 0, feet = null, shadow = 1, fill = C.bodyGrad }) {
  const shapes = [];
  if (shadow > 0.05) {
    shapes.push(ellipse(BODY.cx + dx, FLOOR + 6, 54 * shadow, 8 * shadow, () => C.shadow));
  }
  shapes.push(ellipse(BODY.cx + dx, BODY.cy + dy, BODY.rx, BODY.ry, fill, { sx, sy }));
  if (feet) {
    const { liftL, liftR } = feet;
    const fy = 1 - Math.min(liftL, 20) / 26; // squash as the foot lifts, floored
    shapes.push(ellipse(BODY.cx - 26 + dx, FLOOR - 6 - liftL, 13, 10, () => C.foot, { sy: fy }));
    shapes.push(ellipse(BODY.cx + 26 + dx, FLOOR - 6 - liftR, 13, 10, () => C.foot, { sy: fy }));
  }
  return shapes;
}

/* eyeDx/eyeDy shift the whole eye pair (gaze direction); mouth stays put. */
function faceShapes({ eye = 1, mouth = 'smile', dy = 0, dx = 0, eyeDx = 0, eyeDy = 0 }) {
  const shapes = [];
  for (const side of [-1, 1]) {
    const ex = BODY.cx + side * EYE.dx + dx + eyeDx;
    const ey = EYE.y + dy + eyeDy;
    if (eye > 0.25) {
      shapes.push(ellipse(ex, ey, EYE.rx, EYE.ry * eye, () => C.dark));
      if (eye > 0.7) shapes.push(ellipse(ex + 2, ey - 3, 2.2, 2.6, () => C.glint));
    } else {
      // blink / closed lid: gentle downward arc
      shapes.push(arcStroke(ex, ey, 7, Math.PI * 0.15, Math.PI * 0.85, 2.4, C.dark));
    }
  }
  shapes.push(ellipse(BODY.cx - 42 + dx, 120 + dy, 11, 6.5, () => C.blush));
  shapes.push(ellipse(BODY.cx + 42 + dx, 120 + dy, 11, 6.5, () => C.blush));
  const mx = BODY.cx + dx;
  if (mouth === 'smile') {
    shapes.push(arcStroke(mx, 114 + dy, 12, Math.PI * 0.18, Math.PI * 0.82, 2.6, C.mouth));
  } else if (mouth === 'flat') {
    shapes.push(segment(mx - 8, 119 + dy, mx + 8, 119 + dy, 2.4, C.mouth));
  } else if (mouth === 'open') {
    shapes.push(ellipse(mx, 120 + dy, 7, 8, () => C.mouth));
    shapes.push(ellipse(mx, 123 + dy, 4.4, 4.6, () => rgba(hex('#ff8fa3'), 0.95)));
  } else if (mouth === 'o') {
    shapes.push(ellipse(mx, 119 + dy, 4.6, 5.2, () => C.mouth));
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

  /* ===== seasonal example ===== */

  /* 3s loop (season [10]): pumpkin suit — orange gradient body, green stem,
     triangle eyes, zigzag grin, flapping bat wings */
  halloween: { frames: 90, build(t) {
    const bob = 3 * Math.sin(TAU * 2 * t);
    const flap = Math.sin(TAU * 2 * t) * 0.5 + 0.5;
    const pumpkin = y => {
      const k = clamp01((y - 55) / 95);
      return [255, Math.round(mix(179, 110, k)), Math.round(mix(71, 26, k)), 255];
    };
    const shapes = [];
    // wings first so the body overlaps their roots
    for (const side of [-1, 1]) {
      const wy = BODY.cy - 6 + flap * 9;
      shapes.push(ellipse(BODY.cx + side * (BODY.rx + 8), wy, 17, 6.5, () => hex('#2b2334')));
      shapes.push(ellipse(BODY.cx + side * (BODY.rx + 20), wy + 5 - flap * 4, 11, 4.5, () => hex('#2b2334')));
    }
    shapes.push(rect(BODY.cx - 5, BODY.cy - BODY.ry - 9 + bob, BODY.cx + 5, BODY.cy - BODY.ry + 7 + bob, hex('#6b8f3a')));
    shapes.push(...bodyShapes({ sy: 1 + 0.02 * Math.sin(TAU * 2 * t), dy: bob, feet: { liftL: 0, liftR: 0 }, fill: pumpkin }));
    // triangle eyes (stroke outlines)
    for (const side of [-1, 1]) {
      const ex = BODY.cx + side * 22;
      const ty = EYE.y - 4 + bob, by = EYE.y + 7 + bob, s = 8;
      shapes.push(segment(ex - s, by, ex + s, by, 2.4, C.dark));
      shapes.push(segment(ex - s, by, ex, ty, 2.4, C.dark));
      shapes.push(segment(ex + s, by, ex, ty, 2.4, C.dark));
    }
    // zigzag grin
    const gy = 126 + bob;
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

  /* 3s loop: head sway, upward gaze, three thought dots rising at top right */
  thinking: { frames: 90, build(t) {
    const swx = 6 * Math.sin(TAU * t);
    const bob = 2 * Math.sin(TAU * 2 * t);
    const shapes = [
      ...bodyShapes({ sy: 1.01, dx: swx, dy: bob, feet: { liftL: 0, liftR: 0 } }),
      ...faceShapes({ eye: 1, dx: swx, dy: bob, eyeDx: -2, eyeDy: -4 }),
    ];
    for (let i = 0; i < 3; i++) {
      const p = (t + i / 3) % 1;
      const fade = Math.sin(Math.PI * p);
      shapes.push(ellipse(228 + i * 9, 70 - p * 16, 3.4, 3.4, () => rgba(C.gold, 0.9 * fade)));
    }
    return shapes;
  } },

  /* 1.2s loop: 2Hz typing bob, gaze at a small screen bottom-left with
     blinking code lines */
  working: { frames: 36, build(t) {
    const ph = t * 2;
    const bob = Math.abs(Math.sin(TAU * ph)) * 4;
    const swx = 1.5 * Math.sin(TAU * ph);
    const shapes = [
      rect(44, 112, 112, 160, rgba(hex('#22344d'), 0.96)),
    ];
    for (let i = 0; i < 4; i++) {
      const lit = ((t * 3 + i) % 1) > 0.45 ? 0.95 : 0.3;
      const len = i % 2 ? 44 : 30;
      shapes.push(segment(54, 122 + i * 9, 54 + len, 122 + i * 9, 2.6, rgba(hex('#9fe6b2'), lit)));
    }
    shapes.push(...bodyShapes({
      sy: 1 - 0.02 * Math.sin(TAU * ph), dx: swx, dy: -bob,
      feet: { liftL: 0, liftR: 0 }, shadow: 1 - bob / 22,
    }));
    shapes.push(...faceShapes({ eye: 1, dx: swx, dy: -bob, eyeDx: -9, eyeDy: 5, mouth: 'flat' }));
    return shapes;
  } },

  /* 4s loop: gentle left-right sway, half-lidded eyes, flat mouth — waiting */
  waiting: { frames: 120, build(t) {
    const swx = 10 * Math.sin(TAU * t);
    return [
      ...bodyShapes({ dx: swx, feet: { liftL: 0, liftR: 0 }, shadow: 1 - Math.abs(swx) / 80 }),
      ...faceShapes({ eye: 0.42, dx: swx, dy: 1, mouth: 'flat' }),
    ];
  } },

  /* 1.6s one-shot: two quick hops, star bursts and falling confetti */
  celebrate: { frames: 48, build(t) {
    const jump = Math.abs(Math.sin(2 * Math.PI * t));
    const dy = -36 * jump;
    const shapes = [
      ...bodyShapes({
        sy: 1 + 0.12 * jump, sx: 1 - 0.08 * jump, dy,
        feet: { liftL: 6 * jump, liftR: 6 * jump }, shadow: 1 - 0.5 * jump,
      }),
      ...faceShapes({ eye: 1, dy, mouth: 'open' }),
      ...plus(96, 66, 9 * jump, 3.2, rgba(C.gold, jump)).flat(),
      ...plus(226, 58, 8 * jump, 3, rgba(C.gold, 0.85 * jump)).flat(),
      ...plus(160, 36, 6.5 * jump, 2.6, rgba(C.gold, 0.8 * jump)).flat(),
    ];
    const conf = [hex('#ff9db4'), hex('#7fd0ff'), C.gold, hex('#9fe6b2')];
    for (let i = 0; i < 4; i++) {
      const ang = (i * Math.PI) / 2 + t * 2.2;
      const r = 16 + t * 58;
      shapes.push(ellipse(160 + Math.cos(ang) * r, 84 + Math.sin(ang) * r * 0.55, 2.8, 2.8, () => rgba(conf[i], Math.max(0, 1 - t * 1.1))));
    }
    return shapes;
  } },

  /* 1.6s one-shot: decaying shake, dimmed body, worried eyes, sweat drop */
  error: { frames: 48, build(t) {
    const shake = t < 0.5 ? Math.sin(t * TAU * 6) * 4 * (1 - t * 2) : 0;
    const dim = (x, y) => {
      const c = C.bodyGrad(x, y);
      return [Math.round(c[0] * 0.72), Math.round(c[1] * 0.7), Math.round(c[2] * 0.8), 255];
    };
    return [
      ...bodyShapes({ dx: shake, sy: 0.97, dy: 2, feet: { liftL: 0, liftR: 0 }, shadow: 0.9, fill: dim }),
      ...faceShapes({ eye: 0.45, dx: shake, dy: 2, mouth: 'o' }),
      ellipse(216 + shake, 58 + 7 * t, 4.6, 6.4, () => rgba(hex('#7fd0ff'), Math.max(0, 1 - t * 1.2))),
    ];
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
