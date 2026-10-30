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
const { ttsService, PRESET_VOICES, DEFAULT_VOICE_ZH, DEFAULT_VOICE_EN } = require('./services/tts');

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
      voiceEngine: 'edge-tts',             // 'edge-tts' | 'system'
      voice: DEFAULT_VOICE_ZH,             // 'zh-CN-XiaoyiNeural'
      voiceRate: 0,                        // speed offset: -30 ~ +30 (%)
      voicePitch: 0,                       // pitch offset: 0 ~ +40 (Hz)
      wfOn: true,          // react to workflow runs with state animations
      tasksOn: true,       // unchecked-todo badge mirrored from memo
      lang: null,          // panel fills 'zh' | 'en' from the host UI language
      modelDirs: null,     // Live2D roots to scan; null => [default library]
      x: null,
      y: null,
      ...ctx.data.get(),
    };
    const savePrefs = () => ctx.data.set({ ...prefs });

    /* ---- model library: drop folders in, packs come out -----------------------
       ~/OrbitPet/models is the zero-config home: any folder under a registered
       root that contains a *.model3.json (depth<=3) becomes a live2d pack with
       motion/expression mapping INFERRED from group names; a pet.json beside
       the model file refines anything the guesswork got wrong. Extra roots
       (an existing model on E:, say) can be added from the panel. The legacy
       single modelDir auto-migrates into the list. */
    const MODEL_LIBRARY = path.join(require('os').homedir(), 'OrbitPet', 'models');

    function normalizeModelDir(dir, modelRel) {
      // users pick folders one level off all the time (textures subdir, the
      // model folder itself): walk up, then bounded-down, for <root>/<modelRel>
      const wantTail = String(modelRel).split('/').join(path.sep);
      let cur = path.resolve(dir);
      for (let up = 0; up < 5; up++) {
        if (fs.existsSync(path.join(cur, wantTail))) return cur;
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      const stack = [[path.resolve(dir), 0]];
      while (stack.length) {
        const [d, depth] = stack.shift();
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
        for (const ent of ents) {
          const full = path.join(d, ent.name);
          if (ent.isFile() && full.endsWith(wantTail)) return full.slice(0, full.length - wantTail.length - 1);
          if (ent.isDirectory() && depth < 3 && !ent.name.startsWith('.') && ent.name !== 'node_modules') stack.push([full, depth + 1]);
        }
      }
      return null;
    }
    function wantedModelTails() {
      const tails = [];
      let ents = [];
      try { ents = fs.readdirSync(path.join(ctx.root, 'pets'), { withFileTypes: true }); } catch { return tails; }
      for (const ent of ents) {
        try {
          const c = JSON.parse(fs.readFileSync(path.join(ctx.root, 'pets', ent.name, 'pet.json'), 'utf8'));
          if (c.engine === 'live2d' && typeof c.model === 'string') tails.push(c.model);
        } catch { /* not a pack dir */ }
      }
      return tails;
    }
    function normalizeDirOnce(dir) {
      for (const tail of wantedModelTails()) {
        const root = normalizeModelDir(dir, tail);
        if (root) return root;
      }
      return null;
    }
    function normalizeDirList(dirs) {
      const out = [];
      for (const d of (Array.isArray(dirs) ? dirs : [])) {
        if (typeof d !== 'string' || !d.trim()) continue;
        const fixed = normalizeDirOnce(d.trim()) || d.trim();
        if (!out.some(x => x.toLowerCase() === fixed.toLowerCase())) out.push(fixed);
      }
      if (!out.length) out.push(MODEL_LIBRARY);
      return out;
    }
    if (!Array.isArray(prefs.modelDirs) || !prefs.modelDirs.length) {
      const seed = [MODEL_LIBRARY];
      if (typeof prefs.modelDir === 'string' && prefs.modelDir) seed.push(prefs.modelDir);
      prefs.modelDirs = normalizeDirList(seed);
    }
    delete prefs.modelDir; // migrated away; dropped from the next save

    /* Asset roots for the protocol: modelDirs[0] -> @models, then @models2... */
    function modelRoots() {
      return prefs.modelDirs.map((dir, i) => ({ alias: i ? `models${i + 1}` : 'models', dir }));
    }
    function setModelDirs(dirs) {
      const next = normalizeDirList(dirs);
      const same = next.length === prefs.modelDirs.length && next.every((d, i) => d === prefs.modelDirs[i]);
      prefs.modelDirs = next;
      if (!same) rescanAndBind();
    }
    function bindModelRoots() {
      for (const r of modelRoots()) {
        try { ctx.addAssetRoot(r.alias, r.dir); } catch { /* bad path; that root simply 404s */ }
      }
    }
    function resolveModel(probe) {
      if (typeof probe.cfg.model !== 'string') return null;
      for (const r of modelRoots()) {
        try { if (fs.existsSync(path.join(r.dir, probe.cfg.model))) return r; } catch { /* ignore */ }
      }
      return null;
    }

    function pngDims(file) {
      try {
        const b = Buffer.alloc(24);
        const fd = fs.openSync(file, 'r');
        try { fs.readSync(fd, b, 0, 24, 0); } finally { fs.closeSync(fd); }
        if (b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
          return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
        }
      } catch { /* unreadable texture */ }
      return null;
    }

    /* Naming conventions first (Idle/Tap/wait/work), positional fallback:
       the first group idles, a second answers clicks. Expressions map on
       happy/sad keywords when they carry them. */
    function inferLive2dMap(fr) {
      const groups = Object.keys(fr.Motions || {});
      const byName = re => groups.find(g => re.test(g));
      const idxAll = g => (Array.isArray(fr.Motions[g]) ? fr.Motions[g].map((_, i) => i) : [0]);
      const exprNames = (fr.Expressions || []).map(e => e.Name || e.File || '');
      const expr = re => exprNames.find(n => re.test(n));
      const idleG = byName(/idle/i) || groups[0];
      const tapG = byName(/tap|click|touch/i) || (groups.length > 1 ? groups[1] : null);
      const waitG = byName(/wait|lock|hold/i);
      const workG = byName(/work|type|run|walk/i);
      const map = { fit: 0.95, footY: 0.97 };
      if (idleG) map.idle = { group: idleG, index: idxAll(idleG) };
      if (tapG) map.click = { group: tapG, index: 0 };
      if (waitG) map.waiting = { group: waitG, index: 0 };
      if (workG) { map.working = { group: workG, index: 0 }; map.walk = { group: workG, index: 0 }; }
      const happy = expr(/happy|congr|win|cele|smile/i); if (happy) map.celebrate = { expression: happy, hold: 2600 };
      const sad = expr(/sad|fail|angry|cry|upset/i); if (sad) map.error = { expression: sad, hold: 2600 };
      const soft = expr(/think|shy|sleep/i); if (soft) map.thinking = { expression: soft, hold: 3000 };
      return map;
    }

    function buildAutoPack(root, model3File) {
      let st;
      try { st = extractFirstJsonObject(fs.readFileSync(model3File, 'utf8')); } catch { return null; }
      const fr = st && st.FileReferences;
      if (!fr || !fr.Moc) return null;
      const relModel = path.relative(root.dir, model3File).split(path.sep).join('/');
      // prettiest label we can get: outer folder, stepping over generic
      // subdirs like model/ or textures/ up to the library root's own name
      const dirName = path.basename(path.dirname(model3File));
      const relTop = relModel.includes('/') ? relModel.split('/')[0] : dirName;
      const GENERIC = /^(models?|motions?|expressions?|textures?|physics|pose)$/i;
      const folder = !GENERIC.test(relTop) ? relTop : (!GENERIC.test(dirName) ? dirName : path.basename(root.dir));
      const slug = folder.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
      const cfg = {
        id: `auto-${slug}`,
        name: { zh: folder, en: folder },
        version: '0.0.0',
        author: '',
        engine: 'live2d',
        model: relModel,
        canvas: { w: 400, h: 400 },
        defaultSize: 260,
        defaultFacing: 'right',
        bubbleAnchor: { x: 0.5 },
        live2d: inferLive2dMap(fr),
      };
      try {
        const tex = (fr.Textures || [])[0];
        const dims = tex && pngDims(path.join(path.dirname(model3File), tex));
        if (dims && dims.w > 16 && dims.h > 16) cfg.canvas = dims;
      } catch { /* default canvas */ }
      // a pet.json beside the model file refines the inference (user wins)
      try {
        const overrideFile = path.join(path.dirname(model3File), 'pet.json');
        if (fs.existsSync(overrideFile)) {
          const user = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
          cfg.name = user.name || cfg.name;
          cfg.canvas = user.canvas || cfg.canvas;
          cfg.defaultSize = user.defaultSize || cfg.defaultSize;
          cfg.defaultFacing = user.defaultFacing || cfg.defaultFacing;
          cfg.bubbleAnchor = user.bubbleAnchor || cfg.bubbleAnchor;
          cfg.model = user.model || cfg.model;
          cfg.live2d = { ...cfg.live2d, ...(user.live2d || {}) };
        }
      } catch { /* broken override — inference stands */ }
      return {
        id: cfg.id, dirName: null, auto: true, engine: 'live2d',
        needsModel: false, rootAlias: root.alias,
        cfg,
      };
    }

    function scanLive2dLibrary(takenIds) {
      const found = [];
      const seen = new Set(takenIds);
      for (const r of modelRoots()) {
        const stack = [[r.dir, 0]];
        while (stack.length) {
          const [d, depth] = stack.shift();
          let ents = [];
          try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
          for (const ent of ents) {
            const full = path.join(d, ent.name);
            if (ent.isFile() && /\.model3\.json$/i.test(ent.name)) {
              const ap = buildAutoPack(r, full);
              if (ap && !seen.has(ap.id)) { seen.add(ap.id); found.push(ap); }
            } else if (ent.isDirectory() && depth < 3 && !ent.name.startsWith('.') && ent.name !== 'node_modules') {
              stack.push([full, depth + 1]);
            }
          }
        }
      }
      return found;
    }

    /* Packs live in pets/<id>/pet.json (hand-written) and in the model library
       (auto-discovered). webm packs need at least one existing anim file;
       live2d packs need their model resolvable under some registered root. */
    function scanPacks() {
      const root = path.join(ctx.root, 'pets');
      const out = [];
      let entries = [];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { /* no pets dir */ }
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        let cfg;
        try { cfg = JSON.parse(fs.readFileSync(path.join(root, ent.name, 'pet.json'), 'utf8')); }
        catch { console.warn(`[desktop-pet] pets/${ent.name}: pet.json missing/invalid, skipped`); continue; }
        const engine = cfg.engine === 'live2d' ? 'live2d' : 'webm';
        let anims = [];
        let rootHit = null;
        if (engine === 'live2d') {
          rootHit = resolveModel({ cfg });
        } else {
          anims = (Array.isArray(cfg.anims) ? cfg.anims : []).filter(a =>
            a && typeof a.name === 'string' && typeof a.file === 'string'
            && fs.existsSync(path.join(root, ent.name, a.file)));
          if (!anims.length) { console.warn(`[desktop-pet] pets/${ent.name}: no playable anims, skipped`); continue; }
        }
        out.push({
          id: cfg.id || ent.name,
          dirName: ent.name,
          engine,
          needsModel: engine === 'live2d' && !rootHit,
          rootAlias: rootHit ? rootHit.alias : null,
          cfg: { ...cfg, engine, anims },
        });
      }
      for (const ap of scanLive2dLibrary(out.map(p => p.id))) out.push(ap);
      return out;
    }

    let packs = scanPacks();
    const packById = id => packs.find(p => p.id === id || p.dirName === id) || null;
    let pack = packById(prefs.pack) || packs.find(p => !p.needsModel) || packs[0] || null;
    if (pack && pack.needsModel) {
      const usable = packs.find(p => !p.needsModel);
      if (usable) pack = usable; // an unresolved model never steals the stage from a working pack
    }
    if (!pack) throw new Error('no pet pack found under pets/');

    bindModelRoots();

    /* Live2D roots changed? rescan + rebind, fix the active pack, rebuild the
       window when the engine flipped. */
    function rescanAndBind() {
      bindModelRoots();
      packs = scanPacks();
      const cur = packById(pack.id);
      if (!cur || cur.needsModel) {
        const usable = packs.find(p => !p.needsModel);
        if (usable) { pack = usable; prefs.pack = usable.id; }
        else if (cur) pack = cur;
      } else pack = cur;
      savePrefs();
      if (petWin && !petWin.isDestroyed()) {
        petWin.destroy();
        petWin = null;
      }
      ensureWindow();
      pushState();
    }

    /* model3.json cleaning: some exporters append trailing `//` disclaimer
       comments that break strict JSON.parse (the official loaders use it).
       Take the first balanced JSON object, then absolutize every relative
       asset path against the @models root so the renderer can consume the
       settings object directly. */
    function extractFirstJsonObject(text) {
      const start = text.indexOf('{');
      if (start < 0) return null;
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (esc) { esc = false; continue; }
        if (inStr) { if (c.charCodeAt(0) === 92) esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
      }
      return null;
    }
    function loadLive2dSettings(p) {
      const root = modelRoots().find(r => r.alias === p.rootAlias) || modelRoots()[0];
      // asset paths in model3.json are relative to ITS OWN directory, not the model root
      const relBase = String(p.cfg.model).split('/').slice(0, -1).join('/');
      const abs = rel => {
        const joined = (relBase ? relBase + '/' : '') + String(rel).replace(/^\.+\/+/, '');
        return `plugin://${ctx.id}/@${p.rootAlias || root.alias}/${joined.split('/').map(encodeURIComponent).join('/')}`;
      };
      try {
        const raw = fs.readFileSync(path.join(root.dir, p.cfg.model), 'utf8');
        const s = extractFirstJsonObject(raw);
        const fr = s && s.FileReferences;
        if (!fr) throw new Error('no FileReferences');
        if (fr.Moc) fr.Moc = abs(fr.Moc);
        (fr.Textures || []).forEach((t, i, arr) => { arr[i] = abs(t); });
        (fr.Expressions || []).forEach(e => { if (e.File) e.File = abs(e.File); });
        if (fr.Physics) fr.Physics = abs(fr.Physics);
        if (fr.Pose) fr.Pose = abs(fr.Pose);
        for (const g of Object.values(fr.Motions || {})) for (const m of (Array.isArray(g) ? g : [])) {
          if (m.File) m.File = abs(m.File);
          if (m.Sound) m.Sound = abs(m.Sound); // flac cues ship next to the settings file
        }
        s.url = abs(p.cfg.model); // pixi-live2d-display requires the base url on settings objects
        return s;
      } catch (err) {
        console.warn('[desktop-pet] live2d settings unusable (' + p.cfg.model + '):', err.message);
        return null;
      }
    }

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
      pack: {
        id: pack.id, name: pack.cfg.name || pack.id, version: pack.cfg.version || '0.0.0',
        author: pack.cfg.author || '', credit: pack.cfg.credit || null,
        engine: pack.engine,
        anims: pack.engine === 'live2d' ? live2dKeys() : pack.cfg.anims.map(a => a.name),
      },
      packs: packs.map(p => ({ id: p.id, name: p.cfg.name || p.id, engine: p.engine, needsModel: !!p.needsModel, auto: !!p.auto })),
      modelDirs: prefs.modelDirs.slice(),
      modelLibrary: MODEL_LIBRARY,
      prefs: { pack: pack.id, ...prefsPayload() },
      voices: ttsService.getPresetVoices(),
      visible: !!(petWin && !petWin.isDestroyed() && petWin.isVisible()),
      status: lastStatus,
      // pure read: lazy expiry happens in isLocked() on the interaction paths
      lock: lock ? { active: Date.now() < lock.expiresAt, owner: lock.owner, expiresAt: lock.expiresAt } : { active: false },
      tasks: tasksState.count,
    });
    const pushState = () => ctx.send('state', stateFor());
    const prefsPayload = () => ({
      size: prefs.size, autoWalk: prefs.autoWalk, bubbleOn: prefs.bubbleOn,
      voiceOn: prefs.voiceOn, voiceEngine: prefs.voiceEngine, voice: prefs.voice,
      voiceRate: prefs.voiceRate, voicePitch: prefs.voicePitch,
      wfOn: prefs.wfOn, tasksOn: prefs.tasksOn,
      lang: prefs.lang, margin: marginH(prefs.size),
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
    let quipSeq = 0;
    const sendQuip = async (text) => {
      if (!prefs.bubbleOn) return { ok: false, error: 'bubble is off' };
      if (text === undefined && isLocked()) return { ok: false, error: 'locked' }; // self-chatter yields to a takeover
      const rt = petWin && !petWin.isDestroyed() && petWin.isVisible();
      if (!rt) return { ok: false, error: 'pet is hidden' };
      const body = typeof text === 'string' && text.trim() ? text.trim().slice(0, 200) : pickQuip();
      const mySeq = ++quipSeq;

      if (prefs.voiceOn && prefs.voiceEngine === 'edge-tts') {
        try {
          const ttsRes = await ttsService.synthesize({
            text: body,
            voice: prefs.voice,
            rate: prefs.voiceRate,
            pitch: prefs.voicePitch,
            lang: prefs.lang || 'zh',
          });
          if (mySeq !== quipSeq) return { ok: true, dropped: true };
          if (ttsRes && ttsRes.ok && ttsRes.audioUrl) {
            send('bubble', { text: body, audioUrl: ttsRes.audioUrl, duration: ttsRes.duration, engine: 'edge-tts' });
            return { ok: true, text: body, audioUrl: ttsRes.audioUrl };
          }
        } catch { /* synthesize error, fallback below */ }
        if (mySeq === quipSeq) {
          send('bubble', { text: body, engine: 'system', fallback: true });
        }
      } else {
        send('bubble', { text: body, engine: 'system' });
      }
      return { ok: true, text: body };
    };
    const scheduleQuip = () => {
      clearTimeout(quipTimer);
      quipTimer = setTimeout(() => {
        // when todos are piling up, nag about them at most every 20 minutes
        if (tasksState.count > 0 && Date.now() - tasksState.lastNag > 20 * 60000) {
          tasksState.lastNag = Date.now();
          sendQuip(`备忘录里还有 ${tasksState.count} 件事没勾完呢`);
        } else {
          sendQuip();
        }
        scheduleQuip();
      }, 180000 + Math.random() * 240000);
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

    /* --- seasonal gate --------------------------------------------------------- */

    /* Packs may mark anims with `season: [10, 11]` (1-12 months). The sprite
       only ever sees what is in season right now — idle pools, click reactions
       and the context menu all derive from this list. */
    const monthNow = () => new Date().getMonth() + 1;
    const activeAnims = () => pack.cfg.anims.filter(a => !Array.isArray(a.season) || a.season.includes(monthNow()));
    /* semantic-name support across engines: webm matches anim name OR role
       (click/walk/idle live in roles); live2d matches its pack mapping keys */
    const live2dKeys = () => Object.keys(pack.cfg.live2d || {}).filter(k => !['fit', 'footY'].includes(k));
    const supportsAnim = name => pack.engine === 'live2d'
      ? (name === 'idle' ? !!pack.cfg.live2d : live2dKeys().includes(name))
      : activeAnims().some(a => a.name === name || a.role === name);

    /* --- file drop: the pet as a toolbox entry point -------------------------- */

    /* Drop a file onto the pet (pet.js reports {path,name,size} from the DOM
       drop event). A conservative extension table routes it to the plugin
       best suited to open it, through the same navigate-to payload the
       palettes use — json-editor, memo, and codec-lab's auto image preview
       all consume payloads without knowing this plugin exists. */
    const TEXT_ROUTES = {
      '.json': { pluginId: 'json-editor', label: { zh: 'JSON 编辑器', en: 'JSON Editor' }, type: 'application/json' },
      '.md': { pluginId: 'memo', label: { zh: '备忘录', en: 'Memo' }, type: 'text/plain' },
      '.markdown': { pluginId: 'memo', label: { zh: '备忘录', en: 'Memo' }, type: 'text/plain' },
      '.txt': { pluginId: 'memo', label: { zh: '备忘录', en: 'Memo' }, type: 'text/plain' },
      '.log': { pluginId: 'memo', label: { zh: '备忘录', en: 'Memo' }, type: 'text/plain' },
      '.csv': { pluginId: 'memo', label: { zh: '备忘录', en: 'Memo' }, type: 'text/plain' },
      '.svg': { pluginId: 'memo', label: { zh: '备忘录', en: 'Memo' }, type: 'text/plain' },
    };
    const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);
    const MAX_TEXT_BYTES = 512 * 1024;
    const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

    async function handleFileDrop({ path: fp, name } = {}) {
      const nm = String(name || (typeof fp === 'string' ? path.basename(fp) : '')).slice(0, 60);
      const say = text => send('bubble', { text });
      if (typeof fp !== 'string' || !fp) return { ok: false, error: 'no path' };
      let st;
      try { st = fs.statSync(fp); } catch { say(`我打不开「${nm}」`); return { ok: false, error: 'unreadable' }; }
      if (!st.isFile()) { say('我只接单个文件'); return { ok: false, error: 'not a file' }; }
      const ext = path.extname(nm || fp).toLowerCase();
      const route = TEXT_ROUTES[ext];
      const isImage = IMAGE_EXTS.has(ext);
      if (!route && !isImage) { say(`「${ext || nm}」我还不知道怎么处理`); return { ok: false, error: 'unhandled' }; }
      const tooBig = st.size > (isImage ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES);
      if (tooBig) { say(`「${nm}」太大了（限 ${isImage ? '3MB 图片' : '512KB 文本'}）`); return { ok: false, error: 'too large' }; }
      let payload;
      try {
        payload = route
          ? { type: route.type, value: fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, '').slice(0, MAX_TEXT_BYTES), name: nm, path: fp }
          : { type: 'text/base64', value: fs.readFileSync(fp).toString('base64'), name: nm, path: fp }; // codec-lab sniffs the image bytes back out
      } catch (err) { say(`读「${nm}」失败了：${String(err.message).slice(0, 40)}`); return { ok: false, error: err.message }; }
      const target = route ? route.pluginId : 'codec-lab';
      const label = route ? route.label : { zh: '编码实验室', en: 'Codec Lab' };
      const opened = typeof ctx.openPluginPanel === 'function' && ctx.openPluginPanel(target, payload);
      if (!opened) { say(`工具箱没能打开${label.zh}`); return { ok: false, error: 'open failed' }; }
      if (hasAnim('happy')) { ensureWindow(); send('play', { anim: 'happy', once: true, playbackId: null }); }
      say(typeof ctx.openPluginPanel === 'function'
        ? `「${nm}」交给${label.zh}啦`
        : `「${nm}」已处理`);
      return { ok: true, pluginId: target, name: nm };
    }

    /* --- todo badge from memo -------------------------------------------------- */

    /* A red corner badge mirrors the unchecked task lines memo keeps. Polling
       goes through the core callPlugin surface — no file-format coupling. */
    let tasksState = { count: 0, lastNag: 0 };
    let tasksTimer = null;
    async function pollTasks() {
      if (!prefs.tasksOn || typeof ctx.callPlugin !== 'function') return;
      let open = 0;
      try {
        const data = await ctx.callPlugin('memo', 'list');
        for (const n of (data && Array.isArray(data.notes) ? data.notes : [])) {
          for (const line of String(n.content || '').split('\n')) {
            if (/^\s*[-*+]\s+\[ \]/.test(line)) open++;
          }
        }
      } catch { /* memo disabled or gone — badge sleeps quietly */ }
      if (tasksState.count !== open) {
        tasksState.count = open;
        send('tasks', { count: open });
        pushState();
      }
    }

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
            pack: pack.engine === 'live2d' ? pack.cfg : { ...pack.cfg, anims: activeAnims() },
            engine: pack.engine,
            packDir: pack.dirName,
            pluginBase: `plugin://${ctx.id}`,
            assetBase: pack.engine === 'live2d' ? `plugin://${ctx.id}/@${pack.rootAlias || 'models'}/` : `plugin://${ctx.id}/pets/${pack.dirName}/`,
            modelUrl: pack.engine === 'live2d' && pack.cfg.model
              ? `plugin://${ctx.id}/@${pack.rootAlias || 'models'}/${String(pack.cfg.model).split('/').map(encodeURIComponent).join('/')}`
              : null,
            model3: pack.engine === 'live2d' ? loadLive2dSettings(pack) : null,
            scriptsBase: ctx.url('vendor'),
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
      on('file-drop', (_e, info) => { handleFileDrop(info).catch(() => {}); }),
      on('tasks-click', () => {
        if (typeof ctx.openPluginPanel === 'function') ctx.openPluginPanel('memo');
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
        const animItems = pack.engine === 'live2d'
          ? live2dKeys().filter(k => k !== 'walk').map(name => ({
              label: `▶ ${name}`,
              click: () => send('play', { anim: name, playbackId: null }),
            }))
          : activeAnims().filter(a => a.role !== 'walk').map(a => ({
              label: `▶ ${a.name}`,
              click: () => send('play', { anim: a.name, once: a.once !== false, playbackId: null }),
            }));
        const toggleLabel = (prefs.visible ? '隐藏宠物 / Hide pet' : '显示宠物 / Show pet');
        Menu.buildFromTemplate([
          ...animItems,
          { type: 'separator' },
          { label: '说一句 / Say something', click: () => sendQuip() },
          { label: '回到默认位置 / Spring home', click: () => api.resetPosition() },
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
        if (args.voiceEngine === 'edge-tts' || args.voiceEngine === 'system') prefs.voiceEngine = args.voiceEngine;
        if (typeof args.voice === 'string' && args.voice.trim()) prefs.voice = args.voice.trim();
        if (typeof args.voiceRate === 'number' && Number.isFinite(args.voiceRate)) prefs.voiceRate = Math.max(-30, Math.min(50, Math.round(args.voiceRate)));
        if (typeof args.voicePitch === 'number' && Number.isFinite(args.voicePitch)) prefs.voicePitch = Math.max(0, Math.min(50, Math.round(args.voicePitch)));
        if (typeof args.wfOn === 'boolean') prefs.wfOn = args.wfOn;
        if (typeof args.tasksOn === 'boolean') {
          prefs.tasksOn = args.tasksOn;
          if (!args.tasksOn) { tasksState.count = 0; send('tasks', { count: 0 }); }
          else pollTasks();
        }
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
        if (Array.isArray(args.modelDirs)) setModelDirs(args.modelDirs);
        else if (typeof args.addModelDir === 'string' && args.addModelDir.trim()) setModelDirs(prefs.modelDirs.concat([args.addModelDir.trim()]));
        else if (Number.isInteger(args.removeModelDir)) {
          const next = prefs.modelDirs.slice();
          next.splice(args.removeModelDir, 1);
          setModelDirs(next);
        }
        let packErr = null;
        if (typeof args.pack === 'string') {
          const next = packById(args.pack);
          if (next && next.id !== pack.id) {
            if (next.needsModel) packErr = '该宠物包需要先在下方绑定 Live2D 模型目录';
            else { pack = next; prefs.pack = pack.id; reload = true; }
          }
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
        return packErr ? { ok: true, packError: packErr } : { ok: true };
      },
      quip: (args = {}) => sendQuip(args && args.text),
      setModelDirs: dirs => { setModelDirs(dirs); return { ok: true, modelDirs: prefs.modelDirs.slice() }; },
      openModelLibrary: () => {
        try { fs.mkdirSync(MODEL_LIBRARY, { recursive: true }); } catch { /* exists */ }
        require('electron').shell.openPath(MODEL_LIBRARY);
        return { ok: true, path: MODEL_LIBRARY };
      },
      rescan: () => { rescanAndBind(); return { ok: true }; },
      /* native picker for the Live2D model root (panel button) */
      chooseModelDir: async () => {
        const { dialog } = require('electron');
        const host = ctx.getHostWindow && ctx.getHostWindow();
        const res = await dialog.showOpenDialog(
          host && !host.isDestroyed() ? host : undefined,
          { properties: ['openDirectory'], title: '选择 Live2D 模型目录（含 .model3.json 的根）' },
        );
        return res.canceled ? { ok: false, canceled: true } : { ok: true, dir: res.filePaths[0] };
      },
      /* programmatic file drop (same router as the DOM drop; used by smoke
         and available to future workflow action nodes) */
      fileDrop: (args = {}) => handleFileDrop(args),
      play: (args = {}) => {
        if (!args.anim) return { ok: false, error: 'anim required' };
        if (!supportsAnim(args.anim)) return { ok: false, error: 'unknown anim' };
        if (isLocked() && args.lock !== lock.id) {
          return { ok: false, reason: args.lock ? 'lock-lost' : 'lock-required' };
        }
        const playbackId = newPlaybackId();
        // once undefined => the renderer resolves it from pack metadata (webm
        // anim.once / live2d mapping), which is where engine truth lives
        const once = typeof args.once === 'boolean' ? args.once : undefined;
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
      /* TTS voices & live preview */
      getVoices: () => ({ ok: true, voices: ttsService.getPresetVoices() }),
      previewVoice: async (args = {}) => {
        const engine = args.engine || prefs.voiceEngine || 'edge-tts';
        if (engine === 'system') return { ok: true, engine: 'system' };
        const sample = (prefs.lang === 'en' || args.lang === 'en')
          ? 'Hello! I am your desktop pet, nice to meet you!'
          : '你好呀，我是小轨桌宠，今天也要开开心心哦！';
        const text = (typeof args.text === 'string' && args.text.trim()) ? args.text.trim() : sample;
        return ttsService.synthesize({
          text,
          voice: args.voice || prefs.voice,
          rate: args.rate !== undefined ? args.rate : prefs.voiceRate,
          pitch: args.pitch !== undefined ? args.pitch : prefs.voicePitch,
          lang: args.lang || prefs.lang || 'zh',
        });
      },
      resetPosition: () => {
        const { width, height } = winSize(prefs.size);
        const def = defaultPos(width, height);
        const pos = clampPos(def.x, def.y, width, height);
        prefs.x = pos.x; prefs.y = pos.y; savePrefs();
        // spring it home when visible; teleport only for hidden/dead windows
        if (petWin && !petWin.isDestroyed() && petWin.isVisible()) send('spring', { x: pos.x, y: pos.y });
        else applyBounds(pos.x, pos.y, width, height);
        return { ok: true, x: pos.x, y: pos.y };
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
    const hasAnim = name => supportsAnim(name);
    const playStateAnim = (name) => {
      if (!prefs.visible || !hasAnim(name) || isLocked()) return;
      ensureWindow();
      send('play', { anim: name, once: undefined, playbackId: null }); // pack metadata decides once per engine
    };
    const reactBubble = (text) => {
      if (prefs.bubbleOn && !isLocked() && petWin && !petWin.isDestroyed() && petWin.isVisible()) {
        sendQuip(text);
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
    const tasksBoot = setTimeout(() => pollTasks(), 1200);
    tasksBoot.unref?.();
    tasksTimer = setInterval(() => pollTasks(), 60000);
    tasksTimer.unref?.();

    teardown = () => {
      clearTimeout(savePosTimer);
      clearTimeout(quipTimer);
      clearTimeout(tasksBoot);
      clearInterval(tasksTimer);
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
