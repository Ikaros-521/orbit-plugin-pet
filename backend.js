/* desktop-pet backend.
   Owns the transparent always-on-top sprite window, discovers pet packs
   under pets/, and exposes the petApi service on a cordis-lite pseudo-ctx
   (see compat/pseudo-ctx.js) so the panel, the window and future DSH-derived
   companions all talk to one route table.

   Window geometry: the window is exactly the pet video (size pref = displayed
   width). The renderer drives movement via throttled set-bounds requests and
   runs toss physics itself; this side clamps every request into a real
   display's work area so a vanished monitor can't strand the pet off-screen.
   Rendering techniques (A/B video swap, forward-mode click-through, topmost
   watchdog) are adopted from dsh-pet's desktop runtime (MIT). */

const { ipcMain, screen, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { createPseudoCtx } = require('./compat/pseudo-ctx');

const P = 'desktop-pet:'; // ipc channel namespace for the sprite window
const TOPMOST_TICK_MS = 8000;

let teardown = null; // set by activate; deactivate runs it

module.exports = {
  activate(ctx) {
    /* --- prefs + packs ------------------------------------------------------ */

    const prefs = {
      pack: 'orbitian',
      size: 240,
      visible: true,
      autoWalk: true,
      bubbleOn: true,
      voiceOn: false,
      wfOn: true,          // react to workflow runs with state animations
      lang: null,          // panel fills 'zh' | 'en' from the host UI language
      x: null,
      y: null,
      ...ctx.data.get(),
    };
    const savePrefs = () => ctx.data.set({ ...prefs });

    /* A pack is pets/<id>/pet.json + its webm files. Entries whose files are
       missing are dropped here, not at play time. */
    function scanPacks() {
      const root = path.join(ctx.root, 'pets');
      const packs = [];
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* no pets dir */ }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        let cfg;
        try { cfg = JSON.parse(fs.readFileSync(path.join(root, ent.name, 'pet.json'), 'utf8')); }
        catch { console.warn(`[desktop-pet] pets/${ent.name}: pet.json missing/invalid, skipped`); continue; }
        const anims = (Array.isArray(cfg.anims) ? cfg.anims : []).filter(a =>
          a && typeof a.name === 'string' && typeof a.file === 'string'
          && fs.existsSync(path.join(root, ent.name, a.file)));
        if (!anims.length) { console.warn(`[desktop-pet] pets/${ent.name}: no playable anims, skipped`); continue; }
        packs.push({
          id: cfg.id || ent.name,
          dirName: ent.name,
          cfg: { ...cfg, anims },
        });
      }
      return packs;
    }

    let packs = scanPacks();
    const packById = id => packs.find(p => p.id === id || p.dirName === id) || null;
    let pack = packById(prefs.pack) || packs[0] || null;
    if (!pack) throw new Error('no pet pack found under pets/');

    /* --- sprite window ------------------------------------------------------ */

    let petWin = null;
    let topmostTimer = null;
    let savePosTimer = null;
    let lastStatus = null; // latest renderer status, surfaced for tests/panel
    let lastBoundsKey = null; // "x,y,w,h": the renderer pumps up to 60 moves/s
    let lastBoundsAt = 0;     // watchdog stays off while moves are flowing

    const marginH = size => Math.round(size * 0.5);
    const winSize = size => {
      const canvas = pack.cfg.canvas || { w: 320, h: 180 }; // live: pack swaps at runtime
      return { width: Math.round(size), height: Math.round(size * canvas.h / canvas.w) + marginH(size) };
    };

    /* Single funnel for every window move/resize: clamp into a display, drop
       duplicates, and take the cheap setPosition path when only x/y changed
       (setBounds drags the resize machinery through DWM on every call). */
    function applyBounds(x, y, width, height) {
      if (!petWin || petWin.isDestroyed()) return null;
      const pos = clampPos(x, y, width, height);
      const key = `${pos.x},${pos.y},${width},${height}`;
      if (key !== lastBoundsKey) {
        lastBoundsKey = key;
        lastBoundsAt = Date.now();
        try {
          const cur = petWin.getBounds();
          if (cur.width === width && cur.height === height) petWin.setPosition(pos.x, pos.y);
          else petWin.setBounds({ x: pos.x, y: pos.y, width, height });
        } catch { /* raced close */ }
      }
      return pos;
    }

    function displays() {
      return screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        workArea: d.workArea,
      }));
    }

    /* Keep x,y inside some display's work area. Pets walk the floor, so the
       clamp is "nearest display to the requested point", not just the primary. */
    function clampPos(x, y, w, h) {
      const pt = { x: Math.round(x + w / 2), y: Math.round(y + h / 2) };
      const d = screen.getDisplayNearestPoint(pt) || screen.getPrimaryDisplay();
      const wa = d.workArea;
      return {
        x: Math.min(Math.max(Math.round(x), wa.x), wa.x + wa.width - w),
        y: Math.min(Math.max(Math.round(y), wa.y), wa.y + wa.height - h),
      };
    }

    function defaultPos(w, h) {
      const wa = screen.getPrimaryDisplay().workArea;
      return { x: wa.x + wa.width - w - 24, y: wa.y + wa.height - h - 12 };
    }

    function ensureWindow() {
      if (petWin && !petWin.isDestroyed()) return petWin;
      const { width, height } = winSize(prefs.size);
      const pos = Number.isFinite(prefs.x) && Number.isFinite(prefs.y)
        ? clampPos(prefs.x, prefs.y, width, height)
        : defaultPos(width, height);
      petWin = ctx.windows.create({
        x: pos.x, y: pos.y, width, height,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        // unfocused pets must keep animating: throttling would freeze the walk loop
        webPreferences: { preload: 'pet-preload.js', backgroundThrottling: false },
      });
      petWin.setAlwaysOnTop(true, 'screen-saver');
      lastBoundsKey = `${pos.x},${pos.y},${width},${height}`;
      lastBoundsAt = Date.now();
      petWin.loadURL(ctx.url('pet.html'));
      // showInactive: appearing must never steal focus from whatever the user is typing in
      if (prefs.visible) petWin.once('ready-to-show', () => { if (!petWin.isDestroyed()) petWin.showInactive(); });
      const savePos = () => {
        if (!petWin || petWin.isDestroyed()) return;
        const [x, y] = petWin.getPosition();
        prefs.x = x; prefs.y = y;
        clearTimeout(savePosTimer);
        savePosTimer = setTimeout(savePrefs, 800);
      };
      petWin.on('moved', savePos);
      petWin.on('closed', () => { petWin = null; });
      return petWin;
    }

    /* Fullscreen apps and explorer restarts both demote topmost windows; a
       cheap periodic reassert keeps the pet above ordinary windows (it never
       fights real topmost competitors like task manager). Skipped while the
       renderer is pumping moves: SetWindowPos(HWND_TOPMOST) mid-drag would
       reorder the window in-frame and read as a hitch. */
    topmostTimer = setInterval(() => {
      if (Date.now() - lastBoundsAt < TOPMOST_TICK_MS / 2) return;
      if (petWin && !petWin.isDestroyed() && petWin.isVisible()) {
        petWin.setAlwaysOnTop(true, 'screen-saver');
      }
    }, TOPMOST_TICK_MS);
    topmostTimer.unref?.();

    const send = (channel, payload) => {
      if (petWin && !petWin.isDestroyed()) petWin.webContents.send(`${P}${channel}`, payload);
    };

    const stateFor = () => ({
      pack: { id: pack.id, name: pack.cfg.name || pack.id, version: pack.cfg.version || '0.0.0', author: pack.cfg.author || '', credit: pack.cfg.credit || null, anims: pack.cfg.anims.map(a => a.name) },
      packs: packs.map(p => ({ id: p.id, name: p.cfg.name || p.id })),
      prefs: { pack: pack.id, ...prefsPayload() },
      visible: !!(petWin && !petWin.isDestroyed() && petWin.isVisible()),
      status: lastStatus,
      // pure read: lazy expiry happens in isLocked() on the interaction paths
      lock: lock ? { active: Date.now() < lock.expiresAt, owner: lock.owner, expiresAt: lock.expiresAt } : { active: false },
    });
    const pushState = () => ctx.send('state', stateFor());
    const prefsPayload = () => ({
      size: prefs.size, autoWalk: prefs.autoWalk, bubbleOn: prefs.bubbleOn,
      voiceOn: prefs.voiceOn, wfOn: prefs.wfOn, lang: prefs.lang, margin: marginH(prefs.size),
    });

    /* --- quips (local chatter) ---------------------------------------------- */

    const QUIPS = {
      zh: [
        '喝口水吧，一直盯着屏幕', '伸个懒腰？我陪你', '窗外天气好像变了',
        '我刚刚学会一个新动作', '偷偷告诉你：我在摸鱼', '工作别太拼，劳逸结合',
        '你今天敲的代码比我还多', '数到三，我们一起休息十分钟', '其实我只是一只小团子',
        '别卷啦，我都要睡着了', '坐久了记得站起来晃晃', '有没有想我呀',
        '刚才那段跑对了吗', '我猜你在憋个大招', '认真的样子最好看',
        '要不要听个笑话？算了，下次吧', '桌面右上角被我承包了', '累了就眨眨眼，陪我发会儿呆',
      ],
      en: [
        'Hydrate! You have been staring too long', 'Stretch time, I will wait for you',
        'The weather outside looks different', 'I just learned a new move',
        'Secret: I was slacking off too', 'Work-life balance, remember?',
        'You typed more code than me today', 'Count to three, then ten minutes off',
        'I am just a small dumpling really', 'Stop grinding, I am falling asleep',
        'Stand up and wiggle around a bit', 'Did you miss me?',
        'Did that run pass? Fingers crossed', 'I bet you are cooking something big',
        'Focus mode looks good on you', 'Want a joke? Maybe next time',
        'Top-right corner is mine now', 'Blink a few times and zone out with me',
      ],
    };
    const pickQuip = () => {
      const lang = prefs.lang === 'en' ? 'en' : 'zh';
      const pool = QUIPS[lang];
      return pool[Math.floor(Math.random() * pool.length)];
    };
    let quipTimer = null;
    const sendQuip = (text) => {
      if (!prefs.bubbleOn) return { ok: false, error: 'bubble is off' };
      if (text === undefined && isLocked()) return { ok: false, error: 'locked' }; // self-chatter yields to a takeover
      const rt = petWin && !petWin.isDestroyed() && petWin.isVisible();
      if (!rt) return { ok: false, error: 'pet is hidden' };
      const body = typeof text === 'string' && text.trim() ? text.trim().slice(0, 200) : pickQuip();
      send('bubble', { text: body });
      return { ok: true, text: body };
    };
    const scheduleQuip = () => {
      clearTimeout(quipTimer);
      quipTimer = setTimeout(() => { sendQuip(); scheduleQuip(); }, 180000 + Math.random() * 240000);
      quipTimer.unref?.();
    };
    scheduleQuip();

    /* --- occupation lock + playback receipts ---------------------------------- */

    /* Same contract as dsh-pet: an external caller (a workflow node, another
       plugin, a script over IPC) locks the pet to own its stage — the pet's
       self-chatter falls silent and external play/broadcast calls must carry
       the lockId. A user touch revokes the lock instantly: user always wins. */
    let lock = null; // { id, owner, expiresAt }
    const playbacks = new Map(); // playbackId -> { anim, status, ts }

    const isLocked = () => {
      if (lock && Date.now() < lock.expiresAt) return true;
      if (lock) {
        lock = null;
        send('lock', { locked: false });
        pushState();
      }
      return false;
    };
    const newPlaybackId = () => `pb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const notePlayback = (id, patch) => {
      if (!id) return;
      playbacks.set(id, { ...(playbacks.get(id) || {}), ...patch, ts: Date.now() });
      while (playbacks.size > 40) playbacks.delete(playbacks.keys().next().value);
    };

    /* --- sprite-window ipc --------------------------------------------------- */

    const on = (channel, fn) => {
      const ch = `${P}${channel}`;
      ipcMain.on(ch, fn);
      return () => ipcMain.removeListener(ch, fn);
    };
    const offs = [
      on('ready', e => {
        try {
          e.sender.send(`${P}init`, {
            pack: pack.cfg,
            packDir: pack.dirName,
            assetBase: `plugin://${ctx.id}/pets/${pack.dirName}/`,
            prefs: prefsPayload(),
            displays: displays(),
          });
        } catch { /* window torn down mid-handshake */ }
      }),
      on('status', (_e, s) => { lastStatus = s; }),
      // a user grabbing the pet revokes any external takeover (user wins)
      on('touch', () => {
        if (isLocked()) {
          lock = null;
          send('lock', { locked: false });
          pushState();
        }
      }),
      on('playback-report', (_e, { id, status } = {}) => {
        if (id && playbacks.has(id)) notePlayback(id, { status });
      }),
      // movement / drag: clamp into a real display so the pet can't get lost
      on('set-bounds', (_e, b) => {
        if (!b) return;
        const { width, height } = winSize(prefs.size);
        applyBounds(b.x, b.y, width, height);
      }),
      on('set-ignore', (_e, { ignore } = {}) => {
        if (!petWin || petWin.isDestroyed()) return;
        try { petWin.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch { /* raced close */ }
      }),
      on('context-menu', () => {
        const animItems = pack.cfg.anims.filter(a => a.role !== 'walk').map(a => ({
          label: `▶ ${a.name}`,
          click: () => send('play', { anim: a.name, once: a.once !== false }),
        }));
        const toggleLabel = (prefs.visible ? '隐藏宠物 / Hide pet' : '显示宠物 / Show pet');
        Menu.buildFromTemplate([
          ...animItems,
          { type: 'separator' },
          { label: '说一句 / Say something', click: () => sendQuip() },
          {
            label: (prefs.bubbleOn ? '关闭气泡' : '开启气泡') + ' / Bubble',
            click: () => { prefs.bubbleOn = !prefs.bubbleOn; savePrefs(); send('prefs', prefsPayload()); pushState(); },
          },
          {
            label: (prefs.voiceOn ? '关闭朗读' : '开启朗读') + ' / Voice',
            click: () => { prefs.voiceOn = !prefs.voiceOn; savePrefs(); send('prefs', prefsPayload()); pushState(); },
          },
          { type: 'separator' },
          { label: toggleLabel, click: () => { api.toggle(); } },
          { label: '宠物设置 / Pet settings', click: () => openHostPanel() },
        ]).popup({ window: petWin });
      }),
    ];

    function openHostPanel() {
      const host = ctx.getHostWindow && ctx.getHostWindow();
      if (host && !host.isDestroyed()) {
        if (host.isMinimized()) host.restore();
        host.show();
        host.focus();
        host.webContents.send('open-plugin', ctx.id);
      }
    }

    /* --- petApi route table (panel + future companions) ---------------------- */

    const api = {
      getState: () => stateFor(),
      toggle: () => {
        prefs.visible = !(petWin && !petWin.isDestroyed() && petWin.isVisible());
        if (prefs.visible) { ensureWindow(); petWin.showInactive(); }
        else if (petWin && !petWin.isDestroyed()) petWin.hide();
        savePrefs();
        pushState();
        return { ok: true, visible: prefs.visible };
      },
      setPrefs: (args = {}) => {
        let reload = false;
        if (typeof args.autoWalk === 'boolean') prefs.autoWalk = args.autoWalk;
        if (typeof args.bubbleOn === 'boolean') prefs.bubbleOn = args.bubbleOn;
        if (typeof args.voiceOn === 'boolean') prefs.voiceOn = args.voiceOn;
        if (typeof args.wfOn === 'boolean') prefs.wfOn = args.wfOn;
        if (args.lang === 'zh' || args.lang === 'en') prefs.lang = args.lang;
        if (typeof args.size === 'number' && args.size >= 120 && args.size <= 480 && args.size !== prefs.size) {
          prefs.size = Math.round(args.size);
          if (petWin && !petWin.isDestroyed()) {
            const [x, y] = petWin.getPosition();
            const { width, height } = winSize(prefs.size);
            lastBoundsKey = null; // force past dedupe: size genuinely changed
            applyBounds(x, y, width, height);
          }
        }
        if (typeof args.pack === 'string') {
          const next = packById(args.pack);
          if (next && next.id !== pack.id) { pack = next; prefs.pack = pack.id; reload = true; }
        }
        savePrefs();
        if (reload && petWin && !petWin.isDestroyed()) {
          // pack swap = fresh handshake: destroy the window, recreate lazily
          petWin.destroy();
          petWin = null;
          ensureWindow();
        } else {
          send('prefs', prefsPayload());
        }
        pushState();
        return { ok: true };
      },
      quip: (args = {}) => sendQuip(args && args.text),
      play: (args = {}) => {
        if (!args.anim) return { ok: false, error: 'anim required' };
        const anim = pack.cfg.anims.find(a => a.name === args.anim);
        if (!anim) return { ok: false, error: 'unknown anim' };
        if (isLocked() && args.lock !== lock.id) {
          return { ok: false, reason: args.lock ? 'lock-lost' : 'lock-required' };
        }
        const playbackId = newPlaybackId();
        const once = typeof args.once === 'boolean' ? args.once : !!anim.once;
        notePlayback(playbackId, { anim: args.anim, status: 'pending' });
        if (prefs.visible) { ensureWindow(); send('play', { anim: args.anim, once, playbackId }); }
        return { ok: true, playbackId };
      },
      /* external feed of given text (dsh-pet /broadcast equivalent) */
      broadcast: (args = {}) => {
        if (isLocked() && args.lock !== (lock && lock.id)) {
          return { ok: false, reason: args.lock ? 'lock-lost' : 'lock-required' };
        }
        return sendQuip(args && args.text);
      },
      /* occupation lock: acquire (or renew with matching lockId) / inspect */
      lock: (args = {}) => {
        const now = Date.now();
        const ttl = Math.min(600000, Math.max(1000, Number(args.ttl) || 60000));
        if (isLocked()) {
          if (args.lockId === lock.id) {
            lock.expiresAt = now + ttl;
            pushState();
            return { ok: true, lockId: lock.id, expiresAt: lock.expiresAt, renewed: true };
          }
          return { ok: false, reason: 'lock-lost', cause: 'held-by-other' };
        }
        if (args.lockId) return { ok: false, reason: 'lock-lost', cause: 'expired-or-released' };
        lock = {
          id: `lk-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          owner: typeof args.owner === 'string' ? args.owner : null,
          expiresAt: now + ttl,
        };
        send('lock', { locked: true });
        pushState();
        return { ok: true, lockId: lock.id, expiresAt: lock.expiresAt };
      },
      unlock: (args = {}) => {
        if (!lock) return { ok: true, released: false };
        if (!args.force && args.lockId !== lock.id) return { ok: false, reason: 'lock-lost' };
        const cause = args.force ? 'user' : 'released';
        lock = null;
        send('lock', { locked: false });
        pushState();
        return { ok: true, released: true, cause };
      },
      /* playback receipt: pending -> playing -> done | failed (once anims) */
      playback: (args = {}) => {
        const id = String((args && args.id) || '');
        const p = playbacks.get(id);
        if (!p) return { ok: false, reason: 'unknown-playback' };
        return { ok: true, id, ...p };
      },
      resetPosition: () => {
        const { width, height } = winSize(prefs.size);
        const def = defaultPos(width, height);
        const pos = applyBounds(def.x, def.y, width, height);
        if (pos) { prefs.x = pos.x; prefs.y = pos.y; savePrefs(); }
        return { ok: true };
      },
    };

    /* Route table goes on a pseudo-ctx under the service name DSH companions
       would inject — the pattern any future dsh-derived plugin reuses. */
    const pctx = createPseudoCtx();
    pctx.set('petApi', api);
    const petApi = pctx.get('petApi');

    for (const [method, fn] of Object.entries(petApi)) ctx.ipc.handle(method, fn);

    /* --- workflow reactions ---------------------------------------------------- */

    /* The toolbox's own orchestration gets a live on-shoulder audience:
       working while a run flies, celebrate/error at the finish line, plus a
       bubble. A takeover lock or the panel kill-switch (wfOn) silences it. */
    const hasAnim = name => pack.cfg.anims.some(a => a.name === name);
    const playStateAnim = (name) => {
      if (!prefs.visible || !hasAnim(name) || isLocked()) return;
      ensureWindow();
      const anim = pack.cfg.anims.find(a => a.name === name);
      send('play', { anim: name, once: !!anim.once, playbackId: null });
    };
    const reactBubble = (text) => {
      if (prefs.bubbleOn && !isLocked() && petWin && !petWin.isDestroyed() && petWin.isVisible()) {
        send('bubble', { text });
      }
    };
    let unsubWf = null;
    if (ctx.workflows && typeof ctx.workflows.onWorkflowEvent === 'function') {
      unsubWf = ctx.workflows.onWorkflowEvent(ev => {
        if (!prefs.wfOn) return;
        const name = ev.name || ev.id || '工作流';
        if (ev.event === 'run-start') {
          playStateAnim('working');
          reactBubble(`工作流「${name}」跑起来了…`);
        } else if (ev.event === 'run-finish') {
          playStateAnim(ev.ok ? 'celebrate' : 'error');
          reactBubble(ev.ok
            ? `工作流「${name}」完成 ✓`
            : `⚠ 工作流「${name}」出错：${String(ev.error || '').slice(0, 60)}`);
        }
      });
    }

    /* --- lifecycle ------------------------------------------------------------ */

    const onDisplayChange = () => {
      if (petWin && !petWin.isDestroyed()) {
        const [x, y] = petWin.getPosition();
        const { width, height } = winSize(prefs.size);
        applyBounds(x, y, width, height);
      }
      send('displays', displays());
    };
    screen.on('display-metrics-changed', onDisplayChange);
    screen.on('display-removed', onDisplayChange);

    if (prefs.visible) ensureWindow();

    teardown = () => {
      clearTimeout(savePosTimer);
      clearTimeout(quipTimer);
      clearInterval(topmostTimer);
      if (unsubWf) { try { unsubWf(); } catch { /* core already gone */ } }
      screen.removeListener('display-metrics-changed', onDisplayChange);
      screen.removeListener('display-removed', onDisplayChange);
      for (const off of offs) off();
      pctx.dispose();
      // window itself is destroyed by the plugin manager's windows teardown
      petWin = null;
    };
  },

  deactivate() { if (teardown) { teardown(); teardown = null; } },
};
