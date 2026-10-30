/* motion-live2d — the WebGL Live2D backend (pixi v7 + pixi-live2d-display
   cubism4 + Live2D Cubism Core, all vendored locally).
   Same motion interface as motion-webm so the pet skeleton (drag physics,
   wander, slingshot, lock, receipts, bubbles) never learns which engine is
   driving the body. Mapping lives in the pack: live2d.motions entries are
   {group, index} playbacks or {expression} switches; semantic names
   idle/click/walk/working/thinking/waiting/celebrate/error resolve there.

   Vendor script loading is done by pet.js before this file runs. */
(function () {
  'use strict';

  window.PetMotion = window.PetMotion || {};

  const PRI_IDLE = 1;
  const PRI_FAW = 2;

  window.PetMotion.live2d = function createMotion(env) {
    const { cfg, modelUrl } = env;
    const map = cfg.live2d || {};
    const stage = document.getElementById('stage');

    let app = null;
    let model = null;
    let loaded = false;
    let currentName = null;
    let idleGen = 0;

    function layout() {
      if (!model || !app) return;
      const w = stage.clientWidth, h = stage.clientHeight;
      app.renderer.resize(w, h);
      app.view.style.width = w + 'px';
      app.view.style.height = h + 'px';
      const iw = model.internalModel.width || w;
      const ih = model.internalModel.height || h;
      const fit = (typeof map.fit === 'number' ? map.fit : 0.95);
      const s = fit * Math.min(w / iw, h / ih);
      model.scale.set(s);
      model.anchor.set(0.5, 1);
      model.x = w / 2;
      model.y = h * (typeof map.footY === 'number' ? map.footY : 1);
    }

    const ready = (async () => {
      app = new PIXI.Application({
        width: stage.clientWidth || 10, height: stage.clientHeight || 10,
        backgroundAlpha: 0, antialias: false, autoDensity: false,
      });
      app.view.classList.add('pet-body');
      stage.appendChild(app.view);
      model = await PIXI.live2d.Live2DModel.from(modelUrl, {
        autoInteract: true, // gaze follow + tap response on the canvas
        motionPreload: 'ALL',
      });
      app.stage.addChild(model);
      loaded = true;
      layout();
      window.addEventListener('resize', layout);
      startIdle();
      return true;
    })().catch(err => {
      console.warn('[desktop-pet] live2d model failed to load:', err && err.message || err);
      return false;
    });

    /* idle keeps the model breathing: when one motion ends, roll another. */
    function startIdle() {
      const seq = ++idleGen;
      const idle = map.idle;
      if (!loaded || !idle || !idle.group) return;
      const roll = () => {
        if (seq !== idleGen || !model) return;
        const idx = Array.isArray(idle.index) ? idle.index[Math.floor(Math.random() * idle.index.length)] : (idle.index || 0);
        Promise.resolve(model.motion(idle.group, idx, PRI_IDLE)).then(() => {
          if (seq !== idleGen) return;
          currentName = 'idle';
          if (idle.keep !== false) setTimeout(roll, 400 + Math.random() * 1200);
        }).catch(() => {});
      };
      roll();
    }

    async function play(name, forceOnce) {
      await ready;
      if (!model || !loaded) return 'failed';
      const entry = map[name] || (name === 'idle' ? map.idle : null);
      if (!entry) return 'failed';
      if (entry.expression !== undefined) {
        try {
          model.expression(entry.expression);
          currentName = name;
          const hold = entry.hold || 4000;
          await new Promise(r => setTimeout(r, hold));
          return 'done';
        } catch { return 'failed'; }
      }
      if (!entry.group) return 'failed';
      currentName = name;
      const priority = (forceOnce || entry.once || name !== 'idle') ? PRI_FAW : PRI_IDLE;
      const idx = Array.isArray(entry.index) ? entry.index[Math.floor(Math.random() * entry.index.length)] : (entry.index || 0);
      const okPlayed = await Promise.resolve(model.motion(entry.group, idx, priority)).then(() => true).catch(() => false);
      return okPlayed ? 'done' : 'failed';
    }

    return {
      engine: 'live2d',
      ready,
      play,
      current: () => currentName,
      has: name => name === 'idle' ? !!map.idle : !!map[name],
      idle: () => { startIdle(); return Promise.resolve('playing'); },
      state() {
        return {
          anim: currentName,
          playing: loaded && !!currentName, // the canvas is live whenever a pose runs
          t: 0,
          ready: loaded ? 4 : 1, // >=2 reads as "has frames" to the smoke tests
        };
      },
      layout,
    };
  };
})();
