/* Sprite visual check — boots the real plugin stack like smoke.js, waits for
   the idle clip to actually decode, then captures the transparent sprite
   window so the mascot's margins can be inspected against the window edges.

     E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/sprite-shot.js [size]

   Output: %TEMP%/pet-frames/sprite.png (window-sized, alpha preserved) */

const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ORBIT = path.resolve(__dirname, '..', '..', 'orbit-tools');
const Config = require(path.join(ORBIT, 'src', 'core', 'config'));
const PluginManager = require(path.join(ORBIT, 'src', 'core', 'plugin-manager'));
const { registerPluginProtocol } = require(path.join(ORBIT, 'src', 'core', 'plugin-protocol'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const OUT = path.join(os.tmpdir(), 'pet-frames');
const sleep = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  const size = Number(process.argv[2]) || 240;
  const anim = process.argv[3] || null; // force-play this anim before shooting
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-sprite-'));
  const userPlugins = path.join(tmp, 'plugins');
  fs.mkdirSync(userPlugins, { recursive: true });
  fs.cpSync(path.join(__dirname, '..'), path.join(userPlugins, 'desktop-pet'), { recursive: true });
  const cfg = new Config(tmp);
  const manager = new PluginManager({ userDataDir: tmp, config: cfg, getHostWindow: () => null });
  registerPluginProtocol(manager);
  manager.discover();
  await manager.activate('desktop-pet');
  await manager.call('desktop-pet', 'setPrefs', { size });

  // wait until the renderer reports the idle clip actually playing
  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    await sleep(500);
    try {
      const st = await manager.call('desktop-pet', 'getState');
      ok = st.status && st.status.playing;
    } catch { /* retry */ }
  }
  if (!ok) { console.error('video never reported playing'); app.exit(1); return; }
  if (anim) {
    await manager.call('desktop-pet', 'play', { anim });
    await sleep(2000);
  } else {
    await sleep(1500); // let a mid-orbit frame land
  }

  const win = BrowserWindow.fromId(manager.windowsOf('desktop-pet')[0].id);
  const [w, h] = win.getContentSize();
  // capturePage on a transparent window can return what's BEHIND it; the
  // trustworthy view is the composited screen — grab the screen via
  // desktopCapturer and crop the window's on-screen rectangle
  const { desktopCapturer, screen } = require('electron');
  const b = win.getBounds();
  const disp = screen.getDisplayMatching(b);
  const scale = disp.scaleFactor;
  const src = (await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(disp.bounds.width * scale), height: Math.round(disp.bounds.height * scale) },
  })).find(s => s.display_id === String(disp.id)) ||
    (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } }))[0];
  if (!src) { console.error('no screen source'); app.exit(1); return; }
  fs.mkdirSync(OUT, { recursive: true });
  const shotPath = path.join(OUT, 'screen.png');
  fs.writeFileSync(shotPath, src.thumbnail.toPNG());
  console.log(`window ${w}x${h} bounds=${JSON.stringify(b)} display=${disp.id} scale=${scale}`);
  console.log(`screen shot -> ${shotPath} (${src.thumbnail.getSize().width}x${src.thumbnail.getSize().height})`);
  // crop the window rect (physical px) out of the screen shot with ffmpeg
  const sx = Math.round((b.x - disp.bounds.x) * scale);
  const sy = Math.round((b.y - disp.bounds.y) * scale);
  const sw = Math.round(w * scale), sh = Math.round(h * scale);
  const { execSync } = require('child_process');
  execSync(`ffmpeg -y -loglevel error -i "${shotPath}" -vf "crop=${sw}:${sh}:${sx}:${sy}" "${path.join(OUT, 'sprite-real.png')}"`);
  console.log(`cropped -> ${path.join(OUT, 'sprite-real.png')}`);
  const layout = await win.webContents.executeJavaScript(`(() => {
    const vid = id => {
      const el = document.getElementById(id);
      return { rect: (() => { const b = el.getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height}; })(),
        intrinsic: { w: el.videoWidth, h: el.videoHeight },
        hiddenBack: el.classList.contains('back'), readyState: el.readyState,
        currentSrc: (el.currentSrc || '').slice(-24) };
    };
    const stage = document.getElementById('stage');
    const zone = document.getElementById('zone');
    const r = el => { const b = el.getBoundingClientRect(); return {x: b.x, y: b.y, w: b.width, h: b.height}; };
    return { inner: { w: innerWidth, h: innerHeight }, va: vid('va'), vb: vid('vb'),
      stage: r(stage), zone: r(zone),
      objectFit: getComputedStyle(document.getElementById('va')).objectFit };
  })()`);
  console.log('layout:', JSON.stringify(layout, null, 1));
  app.exit(0);
}).catch(err => { console.error(err); app.exit(1); });
