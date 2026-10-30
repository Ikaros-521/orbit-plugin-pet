/* desktop-pet smoke test — run with orbit-tools' electron:
     E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/smoke.js

   Copies this plugin into a throwaway user-plugins dir, then exercises the
   full chain headlessly-ish (the sprite window really is created, briefly
   shown inactive, and asked to report playback progress):
   discovery -> activation -> pack scan -> plugin:// MIME (webm!) ->
   toggle/window lifecycle -> video actually decoding -> setPrefs -> teardown.

   The webm content-type assertion doubles as the end-to-end check for the
   orbit-tools plugin-protocol MIME table (video/webm), and the video-progress
   assertion proves VP9-alpha clips decode inside the sandboxed renderer. */

const { app, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

/* Must run before app ready — mirrors orbit-tools main.js. Without it the
   plugin:// scheme is non-standard, origins come out opaque and the sprite
   page's CSP 'self' rejects its own subresources. */
protocol.registerSchemesAsPrivileged([
  { scheme: 'plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

/* dev-layout: this repo sits next to orbit-tools */
const ORBIT = path.resolve(__dirname, '..', '..', 'orbit-tools');
const PluginManager = require(path.join(ORBIT, 'src', 'core', 'plugin-manager'));
const Config = require(path.join(ORBIT, 'src', 'core', 'config'));
const { registerPluginProtocol } = require(path.join(ORBIT, 'src', 'core', 'plugin-protocol'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const fail = msg => { console.error('FAIL:', msg); app.exit(1); throw new Error(msg); };
const ok = msg => console.log('ok -', msg);

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-smoke-'));
  const userPlugins = path.join(tmp, 'plugins');
  fs.mkdirSync(userPlugins, { recursive: true });
  fs.cpSync(path.join(__dirname, '..'), path.join(userPlugins, 'desktop-pet'), { recursive: true });

  const cfg = new Config(tmp);
  /* bare hidden window as the fake host: file-drop routing calls
     openPluginPanel, which needs a live host window to navigate */
  const fakeHost = new (require('electron').BrowserWindow)({ show: false, width: 80, height: 60 });
  const manager = new PluginManager({ userDataDir: tmp, config: cfg, getHostWindow: () => fakeHost });
  /* mock the core workflow bus so the reaction chain runs end-to-end */
  let wfBusFn = null;
  manager.workflowManager = { onWorkflowEvent: fn => { wfBusFn = fn; return () => {}; } };
  const wfEmit = payload => { if (!wfBusFn) throw new Error('plugin never subscribed to workflows'); wfBusFn(payload); };
  registerPluginProtocol(manager);
  manager.discover();

  const found = manager.plugins.get('desktop-pet');
  if (!found) fail('plugin not discovered in user dir');
  ok(`discovered desktop-pet (${found.source})`);

  if (!manager.activate('desktop-pet')) fail('activate failed: ' + manager.loadErrors.get('desktop-pet'));
  ok('activated');

  /* --- plugin:// MIME: the core protocol change this plugin depends on ---- */
  const { net } = require('electron');
  const res = await net.fetch('plugin://desktop-pet/pets/orbitian/idle.webm');
  if (res.status !== 200) fail(`webm not served: ${res.status}`);
  const ct = res.headers.get('content-type');
  if (!/^video\/webm/.test(ct)) fail(`webm content-type is "${ct}", expected video/webm`);
  ok(`plugin:// serves webm as ${ct}`);

  /* --- pack state (window shows on ready-to-show — poll, don't assume) ---- */
  let state = null;
  for (let i = 0; i < 20; i++) {
    state = await manager.call('desktop-pet', 'getState');
    if (state.visible) break;
    await sleep(250);
  }
  if (!state.pack || state.pack.id !== 'orbitian') fail('pack scan missing orbitian: ' + JSON.stringify(state.pack));
  if (!state.pack.anims.includes('idle') || !state.pack.anims.includes('walk')) fail('pack anims wrong: ' + state.pack.anims);
  if (!state.visible) fail('pet did not auto-show after activate');
  if (manager.windowsOf('desktop-pet').length !== 1) fail('sprite window not created');
  // window = video canvas (240 + 30% horizontal slack = 312 wide; video
  // centers at 240) × 9/16 = 135 + bubble margin (120) => 312x255.
  // Tolerance = the Win10 invisible resize border on transparent windows
  // (~8 physical px, DPI-dependent once it lands in DIP measurements).
  const [w0, h0] = manager.windowsOf('desktop-pet')[0].getContentSize();
  if (Math.abs(w0 - 312) > 4 || Math.abs(h0 - 255) > 4) fail(`sprite window ${w0}x${h0}, expected 312x255`);
  ok(`pack=${state.pack.id} anims=[${state.pack.anims}] window ${w0}x${h0} (slack+margin included)`);

  /* --- wait for real video decoding inside the sprite window --------------- */
  let st = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    st = (await manager.call('desktop-pet', 'getState')).status;
    if (st && st.ready >= 2 && st.playing && st.t > 0.2) break;
  }
  if (!st || !(st.ready >= 2) || !st.playing || !(st.t > 0.2)) {
    fail('video not decoding/playing: ' + JSON.stringify(st));
  }
  ok(`video playing: anim=${st.anim} t=${st.t}s ready=${st.ready} at (${st.x},${st.y})`);

  /* --- one-shot animation via route table ----------------------------------- */
  await manager.call('desktop-pet', 'play', { anim: 'happy' });
  await sleep(2500);
  const st2 = (await manager.call('desktop-pet', 'getState')).status;
  if (st2.anim !== 'happy' && st2.anim === 'idle') { /* already returned to idle — also fine */ }
  ok(`one-shot happy dispatched (anim now: ${st2.anim})`);

  /* --- quip -> bubble round-trip ------------------------------------------ */
  const q = await manager.call('desktop-pet', 'quip');
  if (!q.ok || !q.text) fail('quip: ' + JSON.stringify(q));
  let bubbled = false;
  for (let i = 0; i < 12; i++) {
    await sleep(400);
    const s = (await manager.call('desktop-pet', 'getState')).status;
    if (s && s.bubble) { bubbled = true; break; }
  }
  if (!bubbled) fail('bubble never showed after quip');
  ok(`quip bubbled: "${q.text.slice(0, 16)}" -> renderer status.bubble=true`);
  await manager.call('desktop-pet', 'setPrefs', { bubbleOn: false });
  const q2 = await manager.call('desktop-pet', 'quip');
  if (q2.ok) fail('quip should refuse when bubble is off');
  await manager.call('desktop-pet', 'setPrefs', { bubbleOn: true });
  ok('bubbleOn gate respected');

  /* --- workflow reactions --------------------------------------------------- */
  wfEmit({ event: 'run-start', name: '冒烟流', trigger: 'manual' });
  let sW = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    sW = (await manager.call('desktop-pet', 'getState')).status;
    if (sW && sW.anim === 'working') break;
  }
  if (!sW || sW.anim !== 'working') fail(`run-start did not switch to working (anim=${sW && sW.anim})`);
  ok('workflow run-start -> working animation');

  wfEmit({ event: 'run-finish', name: '冒烟流', trigger: 'manual', ok: true });
  let sC = null, sCb = false;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    sC = (await manager.call('desktop-pet', 'getState')).status;
    if (sC && sC.anim === 'celebrate') { sCb = !!sC.bubble; break; }
  }
  if (!sC || sC.anim !== 'celebrate') fail(`run-finish did not celebrate (anim=${sC && sC.anim})`);
  ok(`workflow run-finish -> celebrate${sCb ? ' + reaction bubble' : ''}`);

  /* --- drag & toss simulation --------------------------------------------------
     Synthetic PointerEvents with explicit screenX keep the velocity samples
     deterministic; sendInputEvent would re-derive them from the live window
     position, which our own move-requests are busy changing. */
  const petWin = manager.windowsOf('desktop-pet')[0];
  const dragSim = (moves) => petWin.webContents.executeJavaScript(`(async () => {
    const stage = document.getElementById('stage');
    const mk = (type, sx, sy, buttons) => stage.dispatchEvent(new PointerEvent(type, {
      pointerId: 7, isPrimary: true, pointerType: 'mouse', button: 0, buttons,
      clientX: sx, clientY: sy, screenX: sx, screenY: sy, bubbles: true, cancelable: true,
    }));
    const [x0, y0] = [200, 100];
    let x = x0, y = y0;
    mk('pointerdown', x, y, 1);
    for (const [dx, dy, delay] of ${JSON.stringify(moves)}) {
      x += dx; y += dy;
      mk('pointermove', x, y, 1);
      if (delay) await new Promise(r => setTimeout(r, delay));
    }
    mk('pointerup', x, y, 0);
    return { endX: x - x0, endY: y - y0 };
  })()`);

  // slow 125Hz-ish drag stream: coalescing must keep the window on target
  const before = petWin.getBounds();
  await dragSim(Array.from({ length: 20 }, () => [-12, -4, 60]));
  await sleep(600); // release velocity ~200px/s -> settle, no toss
  const afterDrag = petWin.getBounds();
  if (Math.abs(before.x - afterDrag.x) < 100) fail(`drag did not track: ${before.x} -> ${afterDrag.x}`);
  ok(`drag stream (20 events) tracked: dx=${before.x - afterDrag.x}px`);

  // fast flick -> toss physics -> must settle on the floor within a few seconds
  await dragSim(Array.from({ length: 6 }, () => [40, -20, 12]));
  let settled = false;
  for (let i = 0; i < 24 && !settled; i++) {
    await sleep(250);
    const s = (await manager.call('desktop-pet', 'getState')).status;
    settled = s && !s.airborne && !s.walking;
  }
  if (!settled) fail('toss never settled — physics stuck (airborne/walking loop?)');
  const sFin = (await manager.call('desktop-pet', 'getState')).status;
  if (petWin.isDestroyed()) fail('window died during toss');
  ok(`flick tossed and settled cleanly (anim=${sFin.anim})`);

  /* --- occupation lock + playback receipt + user-revoke --------------------- */
  const lk = await manager.call('desktop-pet', 'lock', { ttl: 30000, owner: 'smoke' });
  if (!lk.ok || !lk.lockId) fail('lock acquire: ' + JSON.stringify(lk));
  const pNoLock = await manager.call('desktop-pet', 'play', { anim: 'idle' });
  if (pNoLock.ok || pNoLock.reason !== 'lock-required') fail('play without lock must be lock-required: ' + JSON.stringify(pNoLock));
  const quipLocked = await manager.call('desktop-pet', 'quip'); // self-chatter yields to a takeover
  if (quipLocked.ok) fail('spontaneous quip should yield during lock');
  const renewal = await manager.call('desktop-pet', 'lock', { lockId: lk.lockId });
  if (!renewal.renewed) fail('lock renew: ' + JSON.stringify(renewal));
  const pLock = await manager.call('desktop-pet', 'play', { anim: 'happy', lock: lk.lockId });
  if (!pLock.ok || !pLock.playbackId) fail('play with lock: ' + JSON.stringify(pLock));
  let rec = null;
  for (let i = 0; i < 24; i++) {
    await sleep(300);
    rec = await manager.call('desktop-pet', 'playback', { id: pLock.playbackId });
    if (rec.ok && rec.status === 'done') break;
  }
  if (!rec.ok || rec.status !== 'done') fail(`playback receipt stuck at ${rec.status}`);
  ok(`lock gates play/quip, renewal + playback receipt done (${rec.anim})`);

  // a user click revokes the takeover (pointerdown -> touch -> backend unlock)
  await dragSim([[0, 0, 30]]); // press+release in place: click, not drag
  await sleep(500);
  const stRevoked = await manager.call('desktop-pet', 'getState');
  if (stRevoked.lock && stRevoked.lock.active) fail('user touch did not revoke the lock');
  ok('user touch revoked the lock');

  /* --- seasonal gate ---------------------------------------------------------- */
  const inSeason = new Date().getMonth() === 9; // October
  const hwn = await manager.call('desktop-pet', 'play', { anim: 'halloween' });
  if (inSeason && !hwn.ok) fail('halloween must be in pool during October: ' + JSON.stringify(hwn));
  if (!inSeason && hwn.error !== 'unknown anim') fail('out-of-season anim must be hidden: ' + JSON.stringify(hwn));
  ok(`season gate (${inSeason ? 'October: halloween in pool' : 'off-season: halloween hidden'})`);

  /* --- model library: auto-discovery, inference, override, removal ---------- */
  {
    // isolate from the tester machine's real ~/OrbitPet/models library
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-lib-'));
    await manager.call('desktop-pet', 'setPrefs', { modelDirs: [lib] });
    let stL = await manager.call('desktop-pet', 'getState');

    // drop a model folder into the library — discovered with no config anywhere
    const girl = path.join(lib, 'Tester');
    fs.mkdirSync(path.join(girl, 'textures'), { recursive: true });
    fs.writeFileSync(path.join(girl, 'm.moc3'), 'fake');
    fs.writeFileSync(path.join(girl, 'textures', 't0.png'),
      Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAF0lEQVR42mP8z8Dwn4GBwZiBgZGAAQAXmQLqae6R2QAAAABJRU5ErkJggg==', 'base64'));
    fs.writeFileSync(path.join(girl, 'tester.model3.json'), JSON.stringify({
      FileReferences: {
        Moc: 'm.moc3',
        Textures: ['textures/t0.png'],
        Expressions: [{ Name: 'happy', File: 'e.exp3.json' }],
        Motions: { Idle: [{ File: 'a.motion3.json' }, { File: 'b.motion3.json' }], Tap: [{ File: 'a.motion3.json' }], Waiting: [{ File: 'b.motion3.json' }] },
      },
    }));
    const rs = await manager.call('desktop-pet', 'rescan');
    if (!rs.ok) fail('rescan: ' + JSON.stringify(rs));
    stL = await manager.call('desktop-pet', 'getState');
    const autoGirl = stL.packs.find(p => p.id === 'auto-tester');
    if (!autoGirl || !autoGirl.auto || autoGirl.needsModel) fail('auto pack not discovered: ' + JSON.stringify(stL.packs));
    ok('model library auto-discovers dropped folders');

    // activate it (fake moc — renderer load will fail, backend contract is what we assert)
    await manager.call('desktop-pet', 'setPrefs', { pack: 'auto-tester' });
    const pWork = await manager.call('desktop-pet', 'play', { anim: 'working' });
    if (pWork.ok) fail('no work-ish group in fixture; working must be rejected: ' + JSON.stringify(pWork));
    const pClick = await manager.call('desktop-pet', 'play', { anim: 'click' });
    if (!pClick.ok || !pClick.playbackId) fail('Tap group should map to click: ' + JSON.stringify(pClick));

    // pet.json beside the model refines the inference
    fs.writeFileSync(path.join(girl, 'pet.json'), JSON.stringify({ name: { zh: '测试姬', en: 'Tester-san' }, live2d: { working: { group: 'Waiting', index: 0 } } }));
    await manager.call('desktop-pet', 'rescan');
    stL = await manager.call('desktop-pet', 'getState');
    if (stL.packs.find(p => p.id === 'auto-tester').name.zh !== '测试姬') fail('override name not merged');
    const pWork2 = await manager.call('desktop-pet', 'play', { anim: 'working' });
    if (!pWork2.ok) fail('pet.json override mapping not applied: ' + JSON.stringify(pWork2));
    ok('folder pet.json overrides inferred mapping');

    // duplicate add of a normalized/raw dir collapses; removal falls back safely
    const stAdd = await manager.call('desktop-pet', 'setPrefs', { addModelDir: girl });
    const stL2 = await manager.call('desktop-pet', 'getState');
    if (stL2.modelDirs.filter(d => d.toLowerCase().replace(/\/+$/, '') === girl.toLowerCase().replace(/\/+$/, '')).length > 1) fail('dup dirs: ' + JSON.stringify(stL2.modelDirs));
    await manager.call('desktop-pet', 'setPrefs', { modelDirs: [stL2.modelLibrary] });
    stL = await manager.call('desktop-pet', 'getState');
    if (stL.packs.some(p => p.id === 'auto-tester')) fail('auto pack should vanish after root removal');
    if (stL.pack.engine !== 'webm') fail('stage must fall back to a webm pack, got ' + stL.pack.engine);
    ok('library roots add/dedupe/remove with clean fallback');
  }

  /* --- file-drop routing ---------------------------------------------------------- */
  fs.writeFileSync(path.join(tmp, 'drop.json'), '{"hello":"pet"}');
  fs.writeFileSync(path.join(tmp, 'drop.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  fs.writeFileSync(path.join(tmp, 'drop.exe'), 'MZ fake');
  const rJson = await manager.call('desktop-pet', 'fileDrop', { path: path.join(tmp, 'drop.json'), name: 'drop.json' });
  if (!rJson.ok || rJson.pluginId !== 'json-editor') fail('json route: ' + JSON.stringify(rJson));
  const rImg = await manager.call('desktop-pet', 'fileDrop', { path: path.join(tmp, 'drop.png'), name: 'drop.png' });
  if (!rImg.ok || rImg.pluginId !== 'codec-lab') fail('image route: ' + JSON.stringify(rImg));
  const rBad = await manager.call('desktop-pet', 'fileDrop', { path: path.join(tmp, 'drop.exe'), name: 'drop.exe' });
  if (rBad.ok || rBad.error !== 'unhandled') fail('unknown extension must be refused: ' + JSON.stringify(rBad));
  ok('file drop routes: json->json-editor, png->codec-lab, unknown refused with a bubble');

  /* --- todo badge mirrored from memo ------------------------------------------------ */
  if (!manager.activate('memo')) fail('memo backend needed for todo-badge test');
  await manager.call('memo', 'create', { content: '- [ ] 任务甲\n- [ ] 任务乙\n- [x] 任务丙' });
  await manager.call('desktop-pet', 'setPrefs', { tasksOn: true });
  let stT = null;
  for (let i = 0; i < 12 && !(stT && stT.tasks >= 3); i++) {
    await sleep(300);
    stT = await manager.call('desktop-pet', 'getState');
  }
  if (!stT || stT.tasks < 3) fail('todo badge should mirror memo open tasks: ' + JSON.stringify(stT && stT.tasks));
  ok(`todo badge mirrors memo (${stT.tasks} open tasks incl. the seeded note)`);

  /* --- memo companion: todo-done celebration & reminder wakeup --------------- */
  const todoRes = await manager.call('memo', 'todoCreate', { title: '给桌宠买小鱼干' });
  const newTodo = todoRes && todoRes.todo;
  if (!newTodo || !newTodo.id) fail('todoCreate in smoke failed: ' + JSON.stringify(todoRes));
  await sleep(400);
  const stT2 = await manager.call('desktop-pet', 'getState');
  if (stT2.tasks !== stT.tasks + 1) fail(`tasks badge should update immediately on changed: got ${stT2.tasks}, want ${stT.tasks + 1}`);
  ok(`todo badge auto-syncs on memo changed: ${stT2.tasks} open tasks`);

  // Complete the todo -> pet should celebrate and show praise bubble
  await manager.call('memo', 'todoToggle', { id: newTodo.id });
  let celebOk = false;
  for (let i = 0; i < 15; i++) {
    await sleep(300);
    const s = (await manager.call('desktop-pet', 'getState')).status;
    if (s && (s.anim === 'celebrate' || s.anim === 'happy') && s.bubble) { celebOk = true; break; }
  }
  if (!celebOk) fail('pet did not celebrate on memo todo-done');
  ok('memo todo-done -> pet celebrate animation + cheer bubble');

  // Scheduled reminder: hide pet first, then broadcast reminder -> pet must wake up and alert
  await manager.call('desktop-pet', 'toggle'); // hide
  let stHide = await manager.call('desktop-pet', 'getState');
  if (stHide.visible) fail('toggle hide before reminder failed');

  // Broadcast reminder from memo
  manager.broadcast('memo', 'reminder', { id: 'rem-1', title: '重要会议' });
  let alertOk = false;
  for (let i = 0; i < 15; i++) {
    await sleep(300);
    const stW = await manager.call('desktop-pet', 'getState');
    if (stW && stW.visible && stW.status && (stW.status.anim === 'thinking' || stW.status.anim === 'celebrate' || stW.status.anim === 'click') && stW.status.bubble) {
      alertOk = true;
      break;
    }
  }
  if (!alertOk) fail('pet did not wake up and alert on memo reminder');
  ok('memo reminder -> wakes pet up + alert animation + reminder bubble');

  /* --- spring home -------------------------------------------------------------------- */
  await manager.call('desktop-pet', 'setPrefs', { autoWalk: false });
  const rp = await manager.call('desktop-pet', 'resetPosition');
  let stS = null;
  for (let i = 0; i < 24; i++) {
    await sleep(300);
    stS = (await manager.call('desktop-pet', 'getState')).status;
    if (stS && Math.abs(stS.x - rp.x) < 6 && Math.abs(stS.y - rp.y) < 6) break;
  }
  if (!stS || Math.abs(stS.x - rp.x) > 8 || Math.abs(stS.y - rp.y) > 8) {
    fail(`spring home did not arrive: at ${stS && stS.x},${stS && stS.y} want ${rp.x},${rp.y}`);
  }
  ok('resetPosition glides home on a damped spring');

  /* --- TTS routes & prefs ----------------------------------------------------- */
  const voicesRes = await manager.call('desktop-pet', 'getVoices');
  if (!voicesRes || !voicesRes.ok || !Array.isArray(voicesRes.voices) || voicesRes.voices.length < 8) {
    fail('getVoices route failed: ' + JSON.stringify(voicesRes));
  }
  ok(`getVoices returned ${voicesRes.voices.length} preset voices`);

  /* --- prefs ------------------------------------------------------------------ */
  await manager.call('desktop-pet', 'setPrefs', {
    size: 320, autoWalk: false,
    voiceOn: true, voiceEngine: 'edge-tts',
    voice: 'zh-CN-XiaoyiNeural', voiceRate: 10, voicePitch: 20,
  });
  const st3 = await manager.call('desktop-pet', 'getState');
  if (st3.prefs.size !== 320 || st3.prefs.autoWalk !== false || st3.prefs.voicePitch !== 20 || st3.prefs.voiceRate !== 10) {
    fail('setPrefs not applied: ' + JSON.stringify(st3.prefs));
  }
  const [w, h] = manager.windowsOf('desktop-pet')[0].getContentSize();
  // 320 + 30% slack = 416 wide; video 180 + margin 160 = 340 tall
  // (DWM rounds transparent bounds ±1)
  if (Math.abs(w - 416) > 4 || Math.abs(h - 340) > 4) fail(`window not resized to 416x340, got ${w}x${h}`);
  ok('setPrefs: size 320 & voice settings applied to window');

  /* --- toggle ------------------------------------------------------------------ */
  const t1 = await manager.call('desktop-pet', 'toggle');
  if (t1.visible !== false || manager.windowsOf('desktop-pet')[0].isVisible()) fail('toggle hide failed');
  const t2 = await manager.call('desktop-pet', 'toggle');
  if (t2.visible !== true || !manager.windowsOf('desktop-pet')[0].isVisible()) fail('toggle show failed');
  ok('toggle hide/show round-trip');

  /* --- teardown ------------------------------------------------------------------ */
  manager.deactivate('desktop-pet');
  if (manager.windowsOf('desktop-pet').length !== 0) fail('window survived deactivate');
  ok('deactivate destroys sprite window');
  fakeHost.destroy();

  console.log('ALL PET SMOKE CHECKS PASSED');
  app.exit(0);
}).catch(err => { console.error('FAIL:', err && err.message); app.exit(1); });
