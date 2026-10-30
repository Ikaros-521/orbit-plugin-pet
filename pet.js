/* desktop-pet sprite renderer.
   Runs inside the transparent window. Responsibilities:
   - A/B video double-buffer playback with load-failure release (the pending
     switch must never hang: a stuck pending silently eats every later click,
     a lesson adopted from dsh-pet's playback state machine)
   - weighted idle animation chain + one-shot animations from the menu
   - random walk along the floor of the current display (window moves, anim
     switches to the pack's walk clip, facing flips by direction)
   - drag with pointer capture; release computes a toss velocity and runs
     gravity/bounce physics until the pet settles
   - click-through: the window is mouse-transparent except over the pet body,
     toggled via setIgnoreMouseEvents(forward) enter/leave events

   Position truth: the main process owns window bounds; this side mirrors
   them (window.screenX/Y resync on every drag move, so main-side clamping
   can't accumulate drift). */
(function () {
  'use strict';

  const stage = document.getElementById('stage');
  const vids = [document.getElementById('va'), document.getElementById('vb')];
  let front = 0;

  let cfg = null;        // pack manifest (anims etc.)
  let assetBase = '';    // plugin://<id>/pets/<pack>/
  let prefs = { size: 240, autoWalk: true };
  let displays = [];

  /* --- playback ---------------------------------------------------------- */

  let current = null;    // anim name currently up front
  let gen = 0;           // switch generation: stale async results die silently
  let loadTimer = 0;
  let onceDone = null;   // callback after a one-shot finishes
  let idleTimer = 0;     // pacing between idle anims
  let walkTimer = 0;

  const frontEl = () => vids[front];
  const backEl = () => vids[1 - front];

  function weightedPick(pool, exclude) {
    const cands = pool.filter(a => a.name !== exclude);
    if (!cands.length) return pool[0] || null;
    let sum = 0;
    for (const a of cands) sum += Math.max(1, a.weight || 1);
    let r = Math.random() * sum;
    for (const a of cands) { r -= Math.max(1, a.weight || 1); if (r <= 0) return a; }
    return cands[cands.length - 1];
  }

  /* Swap in `name`. Loads in the back buffer, swaps when it has frames, and
     always releases the pending slot on failure/timeout so later switches
     still work. onEnd fires when a one-shot finishes (or fails). */
  function switchTo(name, once, onEnd) {
    const a = cfg.anims.find(x => x.name === name);
    if (!a) { if (onEnd) onEnd(); return; }
    if (name === current) { if (onEnd) onEnd(); return; } // 防重：目标已在播
    const myGen = ++gen;
    clearTimeout(loadTimer);
    onceDone = onEnd || null;
    const el = backEl();
    const src = assetBase + encodeURIComponent(a.file);
    const giveUp = why => {
      if (myGen !== gen) return;
      clearTimeout(loadTimer);
      if (onceDone) { const cb = onceDone; onceDone = null; cb(); }
      console.warn('[desktop-pet] anim load failed:', name, why);
    };
    loadTimer = setTimeout(() => giveUp('10s timeout'), 10000);
    el.onerror = () => giveUp('video error');
    const ready = () => {
      if (myGen !== gen) return;
      clearTimeout(loadTimer);
      el.onerror = null;
      front = 1 - front;
      frontEl().classList.remove('back');
      backEl().classList.add('back');
      backEl().pause();
      current = name;
      if (a.once || once) {
        el.onended = () => { el.onended = null; if (myGen === gen && onceDone) { const cb = onceDone; onceDone = null; cb(); } };
      } else {
        el.onended = null;
      }
    };
    el.loop = !(a.once || once);
    el.src = src;
    el.currentTime = 0;
    el.onloadeddata = ready;
    el.play().catch(() => giveUp('autoplay blocked'));
  }

  function idle() {
    if (!cfg) return;
    const pool = cfg.anims.filter(a => (a.role === 'idle' || !a.role) && (a.weight || 0) > 0);
    if (!pool.length) return;
    const pick = weightedPick(pool, current);
    if (pick) switchTo(pick.name, false, null);
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!dragging && !airborne && !walking) idle(); }, 6000 + Math.random() * 8000);
  }

  /* --- window position ------------------------------------------------------ */

  /* The renderer owns a shadow position while the pet is under animation:
     window.screenX lags pending setBounds round-trips, and integrating
     movement from a stale read rubber-bands the window. Raw pointermove can
     fire 125-1000x/s — faster than DWM can move a layered window — so drag
     requests coalesce into one IPC per frame; rAF-driven walks/tosses send
     directly (already frame-aligned). */
  let shadowX = 0, shadowY = 0;
  let moveRaf = 0, movePending = false;

  function moveNow(x, y) {
    shadowX = x; shadowY = y;
    window.pet.setBounds({ x: Math.round(x), y: Math.round(y) });
  }

  function requestMove(x, y) {
    shadowX = x; shadowY = y;
    movePending = true;
    if (!moveRaf) {
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (movePending) { movePending = false; window.pet.setBounds({ x: Math.round(shadowX), y: Math.round(shadowY) }); }
      });
    }
  }

  /* --- walking ----------------------------------------------------------- */

  let walking = false;
  let walkRaf = 0;

  function currentDisplay() {
    const cx = shadowX + window.innerWidth / 2;
    const cy = shadowY + window.innerHeight / 2;
    let best = displays[0];
    let bestD = Infinity;
    for (const d of displays) {
      const b = d.workArea || d.bounds;
      const dx = Math.max(b.x - cx, 0, cx - (b.x + b.width));
      const dy = Math.max(b.y - cy, 0, cy - (b.y + b.height));
      const dist = dx * dx + dy * dy;
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  }

  function setFacing(dirRight) {
    const facesRight = (cfg.defaultFacing || 'right') === 'right';
    // videos face their authored direction; flip when walking against it
    stage.classList.toggle('flip', dirRight !== facesRight);
  }

  function floorY() {
    const wa = (currentDisplay() || {}).workArea;
    return wa ? wa.y + wa.height - window.innerHeight : window.screenY;
  }

  function walkTo(targetX) {
    const walkAnim = cfg.anims.find(a => a.role === 'walk');
    if (!walkAnim) return;
    walking = true;
    switchTo(walkAnim.name, false, null);
    const speed = Math.max(60, prefs.size * 0.9); // px/s
    let last = performance.now();
    const step = now => {
      if (!walking) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const x = shadowX;
      const dir = targetX > x ? 1 : -1;
      setFacing(dir > 0);
      const next = x + dir * speed * dt;
      const arrived = dir > 0 ? next >= targetX : next <= targetX;
      // stay glued to the floor while walking
      moveNow(arrived ? targetX : next, floorY());
      if (arrived) { endWalk(); return; }
      walkRaf = requestAnimationFrame(step);
    };
    walkRaf = requestAnimationFrame(step);
  }

  function endWalk() {
    walking = false;
    cancelAnimationFrame(walkRaf);
    idle();
    scheduleIdle();
    scheduleWalk();
  }

  function scheduleWalk() {
    clearTimeout(walkTimer);
    if (!prefs.autoWalk) return;
    walkTimer = setTimeout(() => {
      if (dragging || airborne || walking || !cfg) { scheduleWalk(); return; }
      const wa = (currentDisplay() || {}).workArea;
      if (!wa) return;
      const margin = prefs.size * 0.6;
      const lo = wa.x + margin;
      const hi = wa.x + wa.width - window.innerWidth - margin;
      if (hi <= lo) return;
      walkTo(lo + Math.random() * (hi - lo));
    }, 30000 + Math.random() * 60000);
  }

  /* --- toss physics -------------------------------------------------------- */

  let airborne = false;
  let physRaf = 0;
  const G = 3000;          // px/s²
  const REST = 0.42;       // floor bounce retention
  const WALL = 0.5;        // side bounce retention

  function toss(vx, vy) {
    airborne = true;
    let last = performance.now();
    const step = now => {
      if (!airborne) return;
      const dt = Math.min(0.04, (now - last) / 1000);
      last = now;
      vy += G * dt;
      shadowX += vx * dt;
      shadowY += vy * dt;
      const wa = (currentDisplay() || {}).workArea;
      const floor = floorY();
      const ceil = wa ? wa.y : 0;
      if (shadowY >= floor) {
        shadowY = floor;
        if (Math.abs(vy) < 140 && Math.abs(vx) < 60) { settle(); return; }
        vy = -vy * REST; vx *= 0.72;
      }
      if (shadowY < ceil) { shadowY = ceil; vy = Math.abs(vy) * REST; }
      if (wa) {
        if (shadowX < wa.x) { shadowX = wa.x; vx = Math.abs(vx) * WALL; }
        if (shadowX > wa.x + wa.width - window.innerWidth) { shadowX = wa.x + wa.width - window.innerWidth; vx = -Math.abs(vx) * WALL; }
      }
      moveNow(shadowX, shadowY);
      physRaf = requestAnimationFrame(step);
    };
    physRaf = requestAnimationFrame(step);
  }

  function settle() {
    airborne = false;
    cancelAnimationFrame(physRaf);
    moveNow(shadowX, floorY());
    idle();
    scheduleIdle();
    scheduleWalk();
  }

  /* --- drag & click -------------------------------------------------------- */

  let dragging = false;
  let downAt = 0;
  let downSX = 0, downSY = 0, downWX = 0, downWY = 0;
  let moved = 0;
  let samples = []; // {t, sx, sy} — velocity window over the last ~120ms

  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    dragging = true;
    stage.classList.add('dragging');
    stopLoops();
    if (!movePending) { shadowX = window.screenX; shadowY = window.screenY; } // idle = OS is the authority
    downAt = performance.now();
    downSX = e.screenX; downSY = e.screenY;
    downWX = shadowX; downWY = shadowY; // anchor from shadow: window.screenX may lag a just-settled toss
    moved = 0;
    samples = [{ t: downAt, sx: downSX, sy: downSY }];
    try { stage.setPointerCapture(e.pointerId); } catch { /* untrusted/synthetic event — listeners on stage suffice */ }
  });

  stage.addEventListener('pointermove', e => {
    if (!dragging) return;
    samples.push({ t: performance.now(), sx: e.screenX, sy: e.screenY });
    while (samples.length > 2 && performance.now() - samples[0].t > 120) samples.shift();
    // absolute positioning from the press anchor; requestMove coalesces the
    // raw (up to 1000Hz) event stream into one bounds IPC per frame
    const nx = downWX + (e.screenX - downSX);
    const ny = downWY + (e.screenY - downSY);
    moved = Math.max(moved, Math.abs(e.screenX - downSX) + Math.abs(e.screenY - downSY));
    requestMove(nx, ny);
  });

  const endDrag = e => {
    if (!dragging) return;
    dragging = false;
    stage.classList.remove('dragging');
    try { stage.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    const dt = performance.now() - downAt;
    if (moved < 6 && dt < 400) {
      // click: Q弹 + one-shot reaction anim, then back to idle
      stage.classList.remove('squash');
      void stage.offsetWidth; // restart the keyframe animation
      stage.classList.add('squash');
      const clickAnim = cfg.anims.find(a => a.role === 'click');
      if (clickAnim) switchTo(clickAnim.name, true, () => { idle(); scheduleIdle(); });
      else scheduleIdle();
      scheduleWalk();
      return;
    }
    // toss: velocity from the freshest sample window (px/ms → px/s)
    const first = samples[0];
    const last = samples[samples.length - 1];
    const ms = Math.max(1, last.t - first.t);
    const vx = (last.sx - first.sx) / ms * 1000;
    const vy = (last.sy - first.sy) / ms * 1000;
    if (Math.hypot(vx, vy) > 250) toss(vx, vy);
    else settle();
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);

  stage.addEventListener('contextmenu', e => {
    e.preventDefault();
    window.pet.contextMenu();
  });

  function stopLoops() {
    walking = false;
    cancelAnimationFrame(walkRaf);
    airborne = false;
    cancelAnimationFrame(physRaf);
    clearTimeout(walkTimer);
    clearTimeout(idleTimer);
  }

  /* --- click-through -------------------------------------------------------- */

  // The whole window ignores the mouse except over the pet; `forward` keeps
  // enter/leave firing so the toggle stays in sync.
  let bodyHover = false;
  const setIgnore = on => { if (!dragging) window.pet.setIgnore(on && !bodyHover); };
  stage.addEventListener('mouseenter', () => { bodyHover = true; window.pet.setIgnore(false); });
  stage.addEventListener('mouseleave', () => { bodyHover = false; setIgnore(true); });

  /* --- status heartbeat (tests / future companions read this via the panel) - */

  setInterval(() => {
    const el = frontEl();
    // at rest the main process is the authority (it may have clamped us on a
    // display change) — fold its position back into the shadow so the next
    // drag/toss starts from where the window really is
    if (!dragging && !walking && !airborne && !movePending) {
      shadowX = window.screenX; shadowY = window.screenY;
    }
    window.pet.status({
      anim: current,
      playing: el && !el.paused && !el.ended,
      t: el ? Math.round(el.currentTime * 100) / 100 : 0,
      ready: el ? el.readyState : 0,
      x: Math.round(shadowX), y: Math.round(shadowY),
      walking, airborne,
    });
  }, 700);

  /* --- boot ------------------------------------------------------------------ */

  function start() {
    current = null;
    shadowX = window.screenX; shadowY = window.screenY;
    const first = cfg.anims.find(a => (a.role === 'idle' || !a.role)) || cfg.anims[0];
    switchTo(first.name, false, null);
    scheduleIdle();
    scheduleWalk();
    setIgnore(true); // transparent until the cursor meets the pet
  }

  window.pet.onInit(init => {
    cfg = init.pack;
    assetBase = init.assetBase;
    prefs = { ...prefs, ...init.prefs };
    displays = init.displays || [];
    start();
  });
  window.pet.onPrefs(p => { prefs = { ...prefs, ...p }; });
  window.pet.onPlay(({ anim, once }) => {
    stopLoops();
    switchTo(anim, once, () => { idle(); scheduleIdle(); scheduleWalk(); });
  });
  window.pet.onDisplays(list => { displays = list; });

  window.pet.ready();
})();
