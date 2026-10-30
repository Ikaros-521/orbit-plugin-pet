/* Bubble overflow check — boots the real plugin stack like sprite-shot.js,
   says a long (200-char) and a short text through the quip API, samples the
   bubble scroller while it auto-scrolls, and grabs cropped screenshots at
   lead/mid/late/tail moments.

     E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/bubble-shot.js

   Output: %TEMP%/pet-frames/bubble-<n>.png + a timing log on stdout. */

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

const LONG = Array.from({ length: 10 }, (_, i) =>
  `第${String(i + 1).padStart(2, '0')}行-气泡长文滚动测试`.repeat(2) + '。').join('');

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-bubble-'));
  const userPlugins = path.join(tmp, 'plugins');
  fs.mkdirSync(userPlugins, { recursive: true });
  fs.cpSync(path.join(__dirname, '..'), path.join(userPlugins, 'desktop-pet'), { recursive: true });
  const cfg = new Config(tmp);
  const manager = new PluginManager({ userDataDir: tmp, config: cfg, getHostWindow: () => null });
  registerPluginProtocol(manager);
  manager.discover();
  await manager.activate('desktop-pet');

  let ok = false;
  for (let i = 0; i < 40 && !ok; i++) {
    await sleep(500);
    try { ok = (await manager.call('desktop-pet', 'getState')).status.playing; } catch { /* retry */ }
  }
  if (!ok) { console.error('video never reported playing'); app.exit(1); return; }

  const win = BrowserWindow.fromId(manager.windowsOf('desktop-pet')[0].id);
  const { desktopCapturer, screen } = require('electron');

  const metrics = () => win.webContents.executeJavaScript(`(() => {
    const bt = document.getElementById('bubbleText');
    const b = document.getElementById('bubble');
    const r = bt.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return { t: Math.round(performance.now()), on: b.classList.contains('on'),
      scrollTop: Math.round(bt.scrollTop), scrollH: bt.scrollHeight, clientH: bt.clientHeight,
      maxH: getComputedStyle(bt).maxHeight,
      bubbleRect: { y: Math.round(rb.top), h: Math.round(rb.height) }, zoneTop: r.top };
  })()`);

  const shot = async name => {
    const [w, h] = win.getContentSize();
    const b = win.getBounds();
    const disp = screen.getDisplayMatching(b);
    const scale = disp.scaleFactor;
    const src = (await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(disp.bounds.width * scale), height: Math.round(disp.bounds.height * scale) },
    })).find(s => s.display_id === String(disp.id)) ||
      (await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } }))[0];
    fs.mkdirSync(OUT, { recursive: true });
    const full = path.join(OUT, name + '-full.png');
    fs.writeFileSync(full, src.thumbnail.toPNG());
    const { execSync } = require('child_process');
    const sx = Math.round((b.x - disp.bounds.x) * scale);
    const sy = Math.round((b.y - disp.bounds.y) * scale);
    const sw = Math.round(w * scale), sh = Math.round(h * scale);
    execSync(`ffmpeg -y -loglevel error -i "${full}" -vf "crop=${sw}:${sh}:${sx}:${sy}" "${path.join(OUT, name + '.png')}"`);
    console.log(`shot -> ${path.join(OUT, name + '.png')}`);
  };

  /* --- pass 1: long text ---------------------------------------------------- */
  console.log(`LONG text: ${LONG.length} chars`);
  await manager.call('desktop-pet', 'quip', { text: LONG });
  const samples = [];
  const shotAt = [1000, 8000, 16000, 26000];   // lead / mid-scroll / late / tail
  const t0 = Date.now();
  for (let i = 0; i < 34; i++) {          // sample up to ~34s
    await sleep(1000);
    const m = await metrics();
    const dt = Date.now() - t0;
    samples.push({ dt, ...m });
    const due = shotAt[0];
    if (due && dt >= due) { shotAt.shift(); await shot('bubble-' + String(due).padStart(5, '0') + 'ms'); }
    if (!m.on && i > 2) break;
  }
  console.log('samples:', JSON.stringify(samples, null, 1));

  /* --- pass 2: short text (regression: no scroll, ~2.6s) --------------------- */
  await sleep(1500);
  console.log('SHORT text');
  await manager.call('desktop-pet', 'quip', { text: '短句气泡正常吗？' });
  const s0 = await metrics();
  await sleep(3200);
  const s1 = await metrics();
  console.log('short:', JSON.stringify({ shown: s0.on, scrollTop: s0.scrollTop, goneAt3s: !s1.on }));

  app.exit(0);
}).catch(err => { console.error(err); app.exit(1); });
