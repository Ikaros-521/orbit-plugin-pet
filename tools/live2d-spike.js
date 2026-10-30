/* live2d spike — boots the pet with the user's Live2D model in the real
   transparent window and verifies the WebGL render path end to end:
     bind modelDir -> switch pack to ikaros-angel -> engine boot ->
     model settings cleaned & parsed -> motion playing -> canvas pixels on
     screen -> one-shot receipt -> spring home.

   Run:  E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/live2d-spike.js [modelDir]
   Default modelDir: E:/Ikaros_Live2D   */
const { app, protocol, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

protocol.registerSchemesAsPrivileged([
  { scheme: 'plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const ORBIT = path.resolve(__dirname, '..', '..', 'orbit-tools');
const PluginManager = require(path.join(ORBIT, 'src', 'core', 'plugin-manager'));
const Config = require(path.join(ORBIT, 'src', 'core', 'config'));
const { registerPluginProtocol } = require(path.join(ORBIT, 'src', 'core', 'plugin-protocol'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = m => console.log('SPIKE|', m);
const fail = m => { say('FAIL ' + m); app.exit(1); throw new Error(m); };

app.on('window-all-closed', () => { /* pack-swap rebuild passes through zero windows;
   the real toolbox host always has windows, bare app must not auto-quit here */ });

app.whenReady().then(async () => {
  try {
    const dirArg = process.argv.slice(2).find(a => /[iI]karos/.test(a) && fs.existsSync(a));
    const modelDir = dirArg || 'E:/Ikaros_Live2D';
    if (!fs.existsSync(modelDir)) fail('model dir not found: ' + modelDir);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'l2d-spike-'));
    const up = path.join(tmp, 'plugins');
    fs.mkdirSync(up, { recursive: true });
    fs.cpSync(path.join(__dirname, '..'), path.join(up, 'desktop-pet'), { recursive: true });

    const cfg = new Config(tmp);
    const manager = new PluginManager({ userDataDir: tmp, config: cfg, getHostWindow: () => null });
    manager.workflowManager = { onWorkflowEvent: () => () => {} };
    registerPluginProtocol(manager);
    manager.discover();
    if (!manager.activate('desktop-pet')) fail('activate: ' + manager.loadErrors.get('desktop-pet'));

    /* bind model dir, switch pack, let the live2d engine boot */
    let r = await manager.call('desktop-pet', 'setPrefs', { modelDirs: [modelDir] });
    say('bind modelDir: ' + JSON.stringify(r));
    const st0 = await manager.call('desktop-pet', 'getState');
    say('state after bind: modelDir=' + st0.modelDir + ' packs=' + JSON.stringify(st0.packs));
    const angel = (st0.packs || []).find(p => p.id === 'ikaros-angel');
    if (!angel) fail('angel pack missing from scan: ' + JSON.stringify(st0.packs));
    say(`angel pack needsModel=${angel.needsModel}`);
    if (angel.needsModel) fail('model still not bound after setPrefs');

    r = await manager.call('desktop-pet', 'setPrefs', { pack: 'ikaros-angel' });
    say('switch pack: ' + JSON.stringify(r));

    {
      const w0 = manager.windowsOf('desktop-pet')[0];
      if (w0) {
        w0.webContents.on('console-message', (_e, level, msg, line, src) => {
          if (level >= 2) say('renderer[' + level + '] ' + String(msg).slice(0, 220) + ' @' + String(src || '').split('/').pop() + ':' + line);
        });
        w0.webContents.on('preload-error', (_e, p, err) => say('preload-error ' + err.message));
      }
    }
    /* poll status until the engine reports a live model */
    let st = null;
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      st = await manager.call('desktop-pet', 'getState');
      const s = st.status;
      if (s && s.ready >= 2 && s.anim) break;
      if (i === 29) fail('live2d never reported ready — status=' + JSON.stringify(s));
    }
    say(`engine live: anim=${st.status.anim} ready=${st.status.ready} playing=${st.status.playing}`);

    /* one-shot with receipt */
    const play = await manager.call('desktop-pet', 'play', { anim: 'click' });
    if (!play.ok || !play.playbackId) fail('click play: ' + JSON.stringify(play));
    let rec = null;
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      rec = await manager.call('desktop-pet', 'playback', { id: play.playbackId });
      if (rec.ok && (rec.status === 'done' || rec.status === 'failed')) break;
    }
    say(`receipt: ${rec && rec.status} (anim now ${(await manager.call('desktop-pet', 'getState')).status?.anim})`);
    if (!rec || rec.status === 'failed') fail('live2d motion receipt failed');

    /* pixels: the WebGL canvas must have drawn an opaque model on screen */
    const win = manager.windowsOf('desktop-pet')[0];
    if (!win || win.isDestroyed()) fail('no pet window');
    const img = await win.webContents.capturePage();
    const png = img.toPNG();
    fs.writeFileSync(path.join(tmp, 'angel.png'), png);
    // crude non-transparent pixel probe via raw decode through toBitmap (BGRA)
    const bmp = img.toBitmap(); // BGRA buffer
    let opaque = 0;
    for (let i = 3; i < bmp.length; i += 4 * 97) if (bmp[i] > 24) opaque++;
    say(`capture ${(png.length / 1024).toFixed(0)}KB opaque samples=${opaque} saved=${path.join(tmp, 'angel.png')}`);
    if (opaque < 20) fail('canvas appears empty — WebGL transparent-window render suspect');

    /* spring home must still work with the new engine */
    const rp = await manager.call('desktop-pet', 'resetPosition');
    await sleep(1800);
    const fin = (await manager.call('desktop-pet', 'getState')).status;
    say(`spring settle: at ${fin.x},${fin.y} want ${rp.x},${rp.y}`);
    if (Math.abs(fin.x - rp.x) > 8 || Math.abs(fin.y - rp.y) > 8) fail('spring settle off after engine swap');

    manager.deactivateAll();
    say('ALL LIVE2D SPIKE CHECKS PASSED');
    app.exit(0);
  } catch (err) {
    say('ERR ' + (err && err.message));
    try { app.exit(1); } catch { /* */ }
  }
});
