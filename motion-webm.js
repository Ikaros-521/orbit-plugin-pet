/* motion-webm — the A/B double-buffered <video> playback engine.
   Extracted from pet.js so the same skeleton can host a Live2D backend
   instead. The old lesson stays load-bearing: a pending switch must NEVER
   hang — the 10s load guard, onerror and autoplay rejection all release it,
   because a stuck pending silently eats every later interaction.

   play(name) -> Promise<'playing'|'done'|'failed'|'stale'>
     loop animations settle at 'playing' once swapped in;
     one-shots settle at 'done' when the clip ends.
     'stale' means a newer switch superseded this one (caller should ignore).
   Semantic names: 'idle' (weighted pool pick), 'click' / 'walk' (by role),
   anything else matches an anim by name — the state contract
   working/thinking/waiting/celebrate/error rides on that. */
(function () {
  'use strict';

  window.PetMotion = window.PetMotion || {};

  window.PetMotion.webm = function createMotion(env) {
    const { cfg, assetBase } = env;
    const vids = [document.getElementById('va'), document.getElementById('vb')];
    let front = 0;
    let current = null;
    let gen = 0;
    let loadTimer = 0;

    const frontEl = () => vids[front];
    const backEl = () => vids[1 - front];

    const idlePool = () => cfg.anims.filter(a => (a.role === 'idle' || !a.role) && (a.weight || 0) > 0);

    function resolve(name) {
      if (name === 'idle') {
        const pool = idlePool();
        const cands = pool.filter(a => a.name !== current);
        const from = cands.length ? cands : pool;
        if (!from.length) return null;
        let sum = 0;
        for (const a of from) sum += Math.max(1, a.weight || 1);
        let r = Math.random() * sum;
        for (const a of from) { r -= Math.max(1, a.weight || 1); if (r <= 0) return { anim: a, once: false }; }
        return { anim: from[from.length - 1], once: false };
      }
      if (name === 'click' || name === 'walk') {
        const a = cfg.anims.find(x => x.role === name);
        return a ? { anim: a, once: name === 'click' } : null;
      }
      const a = cfg.anims.find(x => x.name === name);
      return a ? { anim: a, once: !!a.once } : null;
    }

    function play(name, forceOnce) {
      const r = resolve(name);
      if (!r) return Promise.resolve('failed');
      const { anim, once } = r;
      const isOnce = forceOnce === undefined ? once : (forceOnce || once);
      const myGen = ++gen;
      clearTimeout(loadTimer);
      const el = backEl();
      return new Promise(resolveP => {
        const giveUp = why => {
          if (myGen !== gen) return resolveP('stale');
          clearTimeout(loadTimer);
          console.warn('[desktop-pet] anim load failed:', anim.name, why);
          resolveP('failed');
        };
        loadTimer = setTimeout(() => giveUp('10s timeout'), 10000);
        el.onerror = () => giveUp('video error');
        const ready = () => {
          if (myGen !== gen) return resolveP('stale');
          clearTimeout(loadTimer);
          el.onerror = null;
          front = 1 - front;
          frontEl().classList.remove('back');
          backEl().classList.add('back');
          backEl().pause();
          current = anim.name;
          if (isOnce) {
            el.onended = () => { el.onended = null; resolveP(myGen === gen ? 'done' : 'stale'); };
          } else {
            el.onended = null;
            resolveP('playing');
          }
        };
        el.loop = !isOnce;
        el.src = assetBase + encodeURIComponent(anim.file);
        el.currentTime = 0;
        el.onloadeddata = ready;
        el.play().catch(() => giveUp('autoplay blocked'));
      });
    }

    return {
      engine: 'webm',
      ready: Promise.resolve(true), // boot checks truthiness — undefined read as a dead engine
      play,
      current: () => current,
      has: name => (name === 'idle' ? idlePool().length > 0 : !!resolve(name)),
      idle: () => play('idle'),
      state() {
        const el = frontEl();
        return {
          anim: current,
          playing: el && !el.paused && !el.ended,
          t: el ? Math.round(el.currentTime * 100) / 100 : 0,
          ready: el ? el.readyState : 0,
        };
      },
      layout() { /* CSS-driven buffers need nothing */ },
    };
  };
})();
