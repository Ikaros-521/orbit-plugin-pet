/* desktop-pet sprite renderer — engine-agnostic skeleton.
   The body itself is rendered by a pluggable motion module: motion-webm.js
   (A/B double-buffered VP9-alpha video, the default) or motion-live2d.js
   (pixi + Cubism, for user Live2D models loaded from an external dir).
   Everything else here never learns which engine runs: drag physics, wander,
   slingshot, spring home, bubbles/voice, todo badge, click-through hit
   testing, lock, playback receipts, status heartbeat.

   Position truth: the renderer owns a shadow position while moving
   (window.screenX lags pending IPC and rubber-bands if integrated from);
   raw pointermove coalesces into one bounds request per animation frame. */
(function () {
  'use strict';

  const stage = document.getElementById('stage');

  let cfg = null;        // pack manifest
  let assetBase = '';    // webm: plugin://<id>/pets/<pack>/ ; live2d: @models/
  let prefs = { size: 240, autoWalk: true };
  let displays = [];
  let motion = null;     // engine instance (motion-webm / motion-live2d)

  const loadScript = src => new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('script load failed: ' + src));
    document.head.appendChild(s);
  });

  /* --- idle / walk self-scheduling ------------------------------------------- */

  let idleTimer = 0;
  let walkTimer = 0;

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (prefs.locked || !motion) return; // takeover owns the stage; onLock(false) reschedules
    idleTimer = setTimeout(() => {
      if (!dragging && !airborne && !walking && !slingMode && !prefs.locked) motion.idle();
    }, 6000 + Math.random() * 8000);
  }

  /* --- window position ------------------------------------------------------ */

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
    stage.classList.toggle('flip', dirRight !== facesRight);
  }

  function floorY() {
    const wa = (currentDisplay() || {}).workArea;
    return wa ? wa.y + wa.height - window.innerHeight : window.screenY;
  }

  function walkTo(targetX) {
    walking = true;
    motion.play('walk'); // no walk mapping just means the body stays idle while gliding
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
      moveNow(arrived ? targetX : next, floorY());
      if (arrived) { endWalk(); return; }
      walkRaf = requestAnimationFrame(step);
    };
    walkRaf = requestAnimationFrame(step);
  }

  function endWalk() {
    walking = false;
    cancelAnimationFrame(walkRaf);
    motion.idle();
    scheduleIdle();
    scheduleWalk();
  }

  function scheduleWalk() {
    clearTimeout(walkTimer);
    if (!prefs.autoWalk || prefs.locked) return;
    walkTimer = setTimeout(() => {
      if (dragging || airborne || walking || !cfg || prefs.locked) { scheduleWalk(); return; }
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
  const G = 3000;
  const REST = 0.42;
  const WALL = 0.5;

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
    if (motion) motion.idle();
    scheduleIdle();
    scheduleWalk();
  }

  /* --- spring home -------------------------------------------------------------- */

  let springRaf = 0;
  function springTo(tx, ty) {
    if (dragging || airborne || !cfg) return;
    stopLoops();
    const K = 16, D = 9;
    let vx = 0, vy = 0, last = performance.now();
    const step = now => {
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      vx += ((tx - shadowX) * K - vx * D) * dt;
      vy += ((ty - shadowY) * K - vy * D) * dt;
      moveNow(shadowX + vx * dt, shadowY + vy * dt);
      if (Math.hypot(tx - shadowX, ty - shadowY) < 1.5 && Math.hypot(vx, vy) < 40) {
        moveNow(tx, ty);
        scheduleIdle();
        scheduleWalk();
        return;
      }
      springRaf = requestAnimationFrame(step);
    };
    cancelAnimationFrame(springRaf);
    springRaf = requestAnimationFrame(step);
  }

  /* --- drag, click, slingshot -------------------------------------------------- */

  let dragging = false;
  let downAt = 0;
  let downSX = 0, downSY = 0, downWX = 0, downWY = 0;
  let moved = 0;
  let samples = [];

  const slingEl = document.getElementById('sling');
  let slingMode = false;
  let slingExit = 0;

  const slingAnchor = () => ({
    x: window.innerWidth / 2,
    y: marginH + (window.innerHeight - marginH) * 0.55,
  });

  function hideSlingBand() { slingEl.style.display = 'none'; }

  function leaveSling() {
    slingMode = false;
    clearTimeout(slingExit);
    document.body.classList.remove('slingready');
    hideSlingBand();
  }

  function enterSling() {
    if (dragging || airborne || walking) return;
    slingMode = true;
    document.body.classList.add('slingready');
    clearTimeout(slingExit);
    slingExit = setTimeout(leaveSling, 4000);
    showBubble('拉我呀～');
  }

  function drawSlingBand(cx, cy) {
    const a = slingAnchor();
    const dx = cx - a.x, dy = cy - a.y;
    const len = Math.min(300, Math.hypot(dx, dy));
    const ang = Math.atan2(dy, dx) * 180 / Math.PI;
    slingEl.style.display = 'block';
    slingEl.style.left = a.x + 'px';
    slingEl.style.top = a.y + 'px';
    slingEl.style.width = len + 'px';
    slingEl.style.transform = `rotate(${ang}deg)`;
  }

  function spin() {
    stage.classList.remove('spin');
    void stage.offsetWidth;
    stage.classList.add('spin');
    setTimeout(() => stage.classList.remove('spin'), 700);
  }

  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    dragging = true;
    stage.classList.add('dragging');
    window.pet.touch();
    stopVoice();
    stopLoops();
    if (!movePending) { shadowX = window.screenX; shadowY = window.screenY; }
    downAt = performance.now();
    downSX = e.screenX; downSY = e.screenY;
    downWX = shadowX; downWY = shadowY;
    moved = 0;
    samples = [{ t: downAt, sx: downSX, sy: downSY }];
    try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic events — stage listeners suffice */ }
  });

  stage.addEventListener('pointermove', e => {
    if (!dragging) return;
    samples.push({ t: performance.now(), sx: e.screenX, sy: e.screenY });
    while (samples.length > 2 && performance.now() - samples[0].t > 120) samples.shift();
    if (slingMode) {
      moved = Math.max(moved, Math.abs(e.screenX - downSX) + Math.abs(e.screenY - downSY));
      drawSlingBand(e.clientX, e.clientY);
      return;
    }
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
    if (slingMode) {
      const a = slingAnchor();
      const px = e.clientX - a.x, py = e.clientY - a.y;
      leaveSling();
      if (Math.hypot(px, py) > 40) { spin(); toss(-px * 5, -py * 5); }
      else { settle(); }
      return;
    }
    const dt = performance.now() - downAt;
    if (moved < 6 && dt < 400) {
      // click: Q弹 + the pack's click reaction, then back to idle
      stage.classList.remove('squash');
      void stage.offsetWidth;
      stage.classList.add('squash');
      if (motion.has('click')) motion.play('click', true).then(st => { if (st !== 'stale') { motion.idle(); scheduleIdle(); } });
      else scheduleIdle();
      scheduleWalk();
      return;
    }
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
  stage.addEventListener('dblclick', enterSling);

  stage.addEventListener('contextmenu', e => {
    e.preventDefault();
    window.pet.contextMenu();
  });

  function stopLoops() {
    walking = false;
    cancelAnimationFrame(walkRaf);
    airborne = false;
    cancelAnimationFrame(physRaf);
    cancelAnimationFrame(springRaf);
    clearTimeout(walkTimer);
    clearTimeout(idleTimer);
  }

  /* --- bubble & voice (EdgeTTS audioUrl when the backend supplies one,
       system speechSynthesis as fallback) -------------------------------------- */

  let marginH = 0;
  const bubble = document.getElementById('bubble');
  let bubbleVisible = false;
  let bubbleTimer = 0;
  let activeAudio = null;

  function applyMargin() {
    marginH = prefs.margin || 0;
    document.documentElement.style.setProperty('--margin', marginH + 'px');
  }

  function stopVoice() {
    if (activeAudio) {
      try {
        activeAudio.pause();
        activeAudio.currentTime = 0;
      } catch { /* ignore */ }
      activeAudio = null;
    }
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
    }
  }

  const fallbackSpeak = text => {
    if (!('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = prefs.lang === 'en' ? 'en-US' : 'zh-CN';
      const rateOffset = Number(prefs.voiceRate) || 0;
      u.rate = Math.max(0.5, Math.min(2.0, 1.0 + (rateOffset / 100)));
      window.speechSynthesis.speak(u);
    } catch { /* no voice device: bubble only */ }
  };

  const speak = (text, audioUrl, onAudioEnd) => {
    if (!prefs.voiceOn) return;
    stopVoice();

    if (audioUrl) {
      try {
        const audio = new Audio(audioUrl);
        activeAudio = audio;
        audio.onended = () => {
          if (activeAudio === audio) activeAudio = null;
          if (onAudioEnd) onAudioEnd();
        };
        audio.onerror = () => {
          if (activeAudio === audio) activeAudio = null;
          fallbackSpeak(text);
        };
        audio.play().catch(() => fallbackSpeak(text));
        return;
      } catch {
        fallbackSpeak(text);
        return;
      }
    }

    fallbackSpeak(text);
  };

  function hideBubble() {
    if (!bubbleVisible) return;
    bubbleVisible = false;
    clearTimeout(bubbleTimer);
    bubble.classList.remove('on');
    stopVoice();
  }

  function showBubble(text, audioUrl) {
    if (!prefs.bubbleOn || !text || dragging) return;
    stopVoice();
    bubble.textContent = text;
    bubble.classList.add('on');
    bubbleVisible = true;
    clearTimeout(bubbleTimer);

    if (audioUrl && prefs.voiceOn) {
      const maxTimer = setTimeout(hideBubble, 15000);
      speak(text, audioUrl, () => {
        clearTimeout(maxTimer);
        bubbleTimer = setTimeout(hideBubble, 1200);
      });
    } else {
      bubbleTimer = setTimeout(hideBubble, Math.min(9000, Math.max(2600, text.length * (prefs.lang === 'en' ? 70 : 150))));
      if (prefs.voiceOn) speak(text, null);
    }
  }

  bubble.addEventListener('click', hideBubble);

  /* --- todo badge ------------------------------------------------------------- */

  const tasksEl = document.getElementById('tasks');
  window.pet.onTasks(({ count } = {}) => {
    if (count > 0) {
      tasksEl.querySelector('span').textContent = count > 9 ? '9+' : String(count);
      tasksEl.classList.remove('hidden');
    } else {
      tasksEl.classList.add('hidden');
    }
  });
  tasksEl.addEventListener('click', () => window.pet.tasksClick());

  /* --- click-through -------------------------------------------------------- */

  let ignoring = null;
  const inRect = (el, x, y) => {
    const r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  function overBody(x, y) {
    if (bubbleVisible && inRect(bubble, x, y)) return true;
    if (!tasksEl.classList.contains('hidden') && inRect(tasksEl, x, y)) return true;
    return y >= marginH;
  }
  window.addEventListener('mousemove', e => {
    if (dragging) return;
    const wantIgnore = !overBody(e.clientX, e.clientY);
    if (wantIgnore !== ignoring) {
      ignoring = wantIgnore;
      window.pet.setIgnore(wantIgnore);
    }
  });

  /* --- status heartbeat -------------------------------------------------------- */

  setInterval(() => {
    if (!dragging && !walking && !airborne && !movePending) {
      shadowX = window.screenX; shadowY = window.screenY;
    }
    const ms = motion ? motion.state() : { anim: null, playing: false, t: 0, ready: 0 };
    window.pet.status({
      anim: ms.anim, playing: ms.playing, t: ms.t, ready: ms.ready,
      x: Math.round(shadowX), y: Math.round(shadowY),
      walking, airborne, bubble: bubbleVisible,
    });
  }, 700);

  /* --- boot ------------------------------------------------------------------ */

  async function bootMotion(init) {
    const engine = (init.pack && init.pack.engine === 'live2d') ? 'live2d' : 'webm';
    const pb = init.pluginBase || '';
    const sb = init.scriptsBase || (pb ? `${pb}/vendor` : 'vendor');
    await loadScript(pb ? `${pb}/motion-${engine}.js` : `motion-${engine}.js`);
    if (engine === 'live2d') {
      await loadScript(`${sb}/live2dcubismcore.min.js`);
      await loadScript(`${sb}/pixi.min.js`);
      await loadScript(`${sb}/l2d-display-cubism4.min.js`);
    }
    const m = window.PetMotion[engine]({
      cfg: init.pack,
      assetBase: init.assetBase,
      modelUrl: init.modelUrl || null,
      model3: init.model3 || null,
      getPrefs: () => prefs,
    });
    const up = await m.ready;
    if (!up) {
      // dead engine must not kill the window: keep the bubble telling the story
      showBubble('模型加载失败，检查模型目录设置');
    }
    return m;
  }

  function start() {
    shadowX = window.screenX; shadowY = window.screenY;
    if (motion) motion.idle();
    scheduleIdle();
    scheduleWalk();
    window.pet.setIgnore(true); ignoring = true;
  }

  let booting = null;
  window.pet.onInit(init => {
    cfg = init.pack;
    assetBase = init.assetBase;
    prefs = { ...prefs, ...init.prefs };
    displays = init.displays || [];
    applyMargin();
    if (cfg.bubbleAnchor && Number.isFinite(cfg.bubbleAnchor.x)) {
      bubble.style.left = Math.round(Math.min(1, Math.max(0, cfg.bubbleAnchor.x)) * 100) + '%';
    }
    booting = bootMotion(init).then(m => {
      motion = m;
      start();
    }).catch(err => {
      console.warn('[desktop-pet] motion engine boot failed:', err.message);
      showBubble('我起不来了…（引擎加载失败）');
    });
  });
  window.pet.onPrefs(p => {
    const prevMargin = prefs.margin;
    prefs = { ...prefs, ...p };
    if (p.margin !== undefined && p.margin !== prevMargin) applyMargin();
    if (p.bubbleOn === false) hideBubble();
    if (p.voiceOn === false) stopVoice();
  });
  window.pet.onBubble(({ text, audioUrl } = {}) => showBubble(text, audioUrl));
  window.pet.onPlay(({ anim, once, playbackId }) => {
    if (!motion) return;
    stopLoops();
    const p = once === undefined ? motion.play(anim) : motion.play(anim, !!once);
    Promise.resolve(p).then(st => {
      if (st === 'stale') return; // a newer switch owns the stage now
      if (playbackId) window.pet.reportPlayback(playbackId, st === 'failed' ? 'failed' : (st === 'playing' ? 'playing' : 'done'));
      if (st === 'done' || st === 'failed') { motion.idle(); scheduleIdle(); scheduleWalk(); }
    });
    if (!once) scheduleIdle(); // self-heal: a run that never finishes must not strand the pet
  });
  window.pet.onLock(({ locked } = {}) => {
    prefs.locked = !!locked;
    if (!prefs.locked) { scheduleIdle(); scheduleWalk(); }
  });
  window.pet.onSpring(({ x, y } = {}) => springTo(x, y));
  window.pet.onDisplays(list => { displays = list; });

  window.pet.ready();
})();
