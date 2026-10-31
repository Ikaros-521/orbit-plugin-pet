/* Renderer-side voice queue verification.
   Boots the real pet.html/pet.js in a hidden BrowserWindow with a stub
   preload + motion engine, drives `bubble` IPC like the backend would, and
   asserts the segment queue plays in order and that a newer bubble clears
   the queue mid-speech and takes over. Real audio is synthesized (network)
   but the window is muted — the timeline still runs and `ended` still fires.

   Run: <orbit-tools>/node_modules/.bin/electron tools/test-voice-queue.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');
const { ttsService } = require('../services/tts');

const P = 'desktop-pet:';
const ok = msg => console.log('ok -', msg);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const INJECT_PROBE = `(() => {
  const log = window.__voiceLog = [];
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const src = (this.src || '').slice(-24);
    log.push({ ev: 'play', src, t: Date.now() });
    this.addEventListener('ended', () => log.push({ ev: 'ended', src, t: Date.now() }), { once: true });
    return orig.call(this);
  };
  return true;
})()`;

app.whenReady().then(async () => {
  /* stub motion engine + preload in a scratch dir, served over file:// so
     pet.html's CSP (`script-src 'self'`) still admits them */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-voice-queue-'));
  fs.writeFileSync(path.join(tmp, 'motion-webm.js'), `
    window.PetMotion = { webm: () => ({
      ready: Promise.resolve(true),
      idle() {}, stop() {},
      has: () => false,
      play: () => Promise.resolve('done'),
      state: () => ({ anim: null, playing: false, t: 0, ready: 1 }),
    }) };`);
  fs.writeFileSync(path.join(tmp, 'stub-preload.js'), `
    const { contextBridge, ipcRenderer } = require('electron');
    const P = '${P}';
    const on = ch => fn => ipcRenderer.on(P + ch, (_e, payload) => fn(payload));
    contextBridge.exposeInMainWorld('pet', {
      ready: () => {}, status: () => {}, setBounds: () => {}, setIgnore: () => {},
      contextMenu: () => {}, touch: () => {}, tasksClick: () => {}, reportPlayback: () => {},
      onInit: on('init'), onPrefs: on('prefs'), onBubble: on('bubble'), onLock: on('lock'),
      onPlay: on('play'), onSpring: on('spring'), onTasks: on('tasks'), onDisplays: on('displays'),
    });`);

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(tmp, 'stub-preload.js'),
      contextIsolation: true,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.setAudioMuted(true);
  await win.loadFile(path.join(__dirname, '..', 'pet.html'));
  win.webContents.executeJavaScript(INJECT_PROBE);

  const send = (ch, payload) => win.webContents.send(P + ch, payload);
  win.webContents.send(P + 'init', {
    pack: { engine: 'webm', anims: [], id: 'stub', name: 'stub' },
    pluginBase: pathToFileURL(tmp).href,
    assetBase: '',
    prefs: { voiceOn: true, bubbleOn: true, lang: 'zh', size: 240 },
    displays: [],
  });
  await sleep(500); // let the stub engine boot

  const log = () => win.webContents.executeJavaScript('window.__voiceLog.slice()');
  const synth = async text => ttsService.synthesize({ text, voice: 'zh-CN-XiaoyiNeural' });
  // mp3 tails are identical silence padding across segments — tag each url
  // with a fragment so the probe can tell segments apart (fragments don't
  // affect media loading)
  const seg = (res, tag) => ({ text: `seg-${tag}`, audioUrl: `${res.audioUrl}#${tag}`, duration: res.duration });
  const endedSrcs = entries => entries.filter(e => e.ev === 'ended').map(e => e.src);
  const playedSrcs = entries => entries.filter(e => e.ev === 'play').map(e => e.src);

  /* --- scenario 1: a newer bubble preempts the queue mid-speech ---------- */
  const [a1, a2, a3] = await Promise.all([
    synth('排队播放第一段，验证顺序。'), synth('这是排队的第二段语音。'), synth('这是排队的第三段语音。')]);
  const [b1] = [await synth('换播测试，新内容登场。')];
  send('bubble', { text: '第一场：排队播放', segments: [seg(a1, 'A1'), seg(a2, 'A2'), seg(a3, 'A3')], engine: 'edge-tts', force: true });

  // wait until segment 1 finished and segment 2 is mid-play, then preempt
  await sleep(500);
  for (let i = 0; i < 60; i++) {
    const l = await log();
    if (endedSrcs(l).some(s => s.endsWith('#A1')) && playedSrcs(l).some(s => s.endsWith('#A2'))) break;
    await sleep(250);
  }
  send('bubble', { text: '第二场：换播', segments: [seg(b1, 'B1')], engine: 'edge-tts', force: true });
  await sleep(4000);

  const log1 = await log();
  assert(playedSrcs(log1).some(s => s.endsWith('#A1')), 'segment 1 must have played');
  assert(playedSrcs(log1).some(s => s.endsWith('#A2')), 'segment 2 must have started before preemption');
  assert(!playedSrcs(log1).some(s => s.endsWith('#A3')), 'segment 3 must be dropped when a newer bubble takes over');
  assert(!endedSrcs(log1).some(s => s.endsWith('#A2')), 'preempted segment 2 must not run to its end');
  assert(endedSrcs(log1).some(s => s.endsWith('#B1')), 'the new bubble must be spoken through');
  ok('new trigger clears the queue and switches speech');

  /* --- scenario 2: an undisturbed queue plays every segment in order ----- */
  await win.webContents.executeJavaScript('window.__voiceLog.length = 0');
  send('bubble', { text: '第三场：完整播完', segments: [seg(a1, 'A1'), seg(a2, 'A2'), seg(a3, 'A3')], engine: 'edge-tts', force: true });
  const totalMs = [a1, a2, a3].reduce((s, r) => s + (r.duration || 0), 0) * 1000;
  await sleep(Math.max(6000, totalMs + 4000));

  const log2 = await log();
  const ends = endedSrcs(log2).map(s => (s.match(/#(\w+)$/) || [])[1]);
  assert.deepStrictEqual(ends, ['A1', 'A2', 'A3'], `all segments must end in order, got: ${ends}`);
  const plays = playedSrcs(log2).map(s => (s.match(/#(\w+)$/) || [])[1]);
  assert.deepStrictEqual(plays, ['A1', 'A2', 'A3'], `exactly the queue must play, got: ${plays}`);
  ok('undisturbed long speech plays every segment in order');

  win.destroy();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* scratch */ }
  console.log('ALL VOICE QUEUE TESTS PASSED');
  app.exit(0);
}).catch(err => {
  console.error('FAIL:', err);
  app.exit(1);
});
