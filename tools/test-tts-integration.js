/* desktop-pet TTS integration & IPC verification test */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, protocol } = require('electron');

protocol.registerSchemesAsPrivileged([
  { scheme: 'plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const ORBIT = path.resolve(__dirname, '..', '..', 'orbit-tools');
const PluginManager = require(path.join(ORBIT, 'src', 'core', 'plugin-manager'));
const Config = require(path.join(ORBIT, 'src', 'core', 'config'));
const { registerPluginProtocol } = require(path.join(ORBIT, 'src', 'core', 'plugin-protocol'));

const ok = msg => console.log('ok -', msg);
const fail = msg => { console.error('FAIL:', msg); app.exit(1); throw new Error(msg); };

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-tts-int-'));
  const userPlugins = path.join(tmp, 'plugins');
  fs.mkdirSync(userPlugins, { recursive: true });
  fs.cpSync(path.join(__dirname, '..'), path.join(userPlugins, 'desktop-pet'), {
    recursive: true,
    filter: src => !src.includes('.git'),
  });

  const cfg = new Config(tmp);
  const manager = new PluginManager({ userDataDir: tmp, config: cfg, getHostWindow: () => null });
  registerPluginProtocol(manager);
  manager.discover();

  if (!manager.activate('desktop-pet')) fail('activate failed');
  ok('desktop-pet activated');

  // 1. Test getVoices API
  const vRes = await manager.call('desktop-pet', 'getVoices');
  assert(vRes && vRes.ok && Array.isArray(vRes.voices), 'getVoices should return ok and voices array');
  assert(vRes.voices.length >= 8, 'Should have >= 8 preset voices');
  const xiaoyi = vRes.voices.find(v => v.id === 'zh-CN-XiaoyiNeural');
  assert(xiaoyi && xiaoyi.name === '晓伊', 'xiaoyi voice must be present');
  ok('getVoices API verified');

  // 2. Test setPrefs with TTS settings
  await manager.call('desktop-pet', 'setPrefs', {
    voiceOn: true,
    voiceEngine: 'edge-tts',
    voice: 'zh-CN-XiaoyiNeural',
    voiceRate: 15,
    voicePitch: 25,
  });
  const state = await manager.call('desktop-pet', 'getState');
  assert.strictEqual(state.prefs.voiceOn, true);
  assert.strictEqual(state.prefs.voiceEngine, 'edge-tts');
  assert.strictEqual(state.prefs.voice, 'zh-CN-XiaoyiNeural');
  assert.strictEqual(state.prefs.voiceRate, 15);
  assert.strictEqual(state.prefs.voicePitch, 25);
  assert(Array.isArray(state.voices) && state.voices.length >= 8, 'state must include voices list');
  ok('setPrefs voice options and state.voices verified');

  // 3. Test previewVoice API (both edge-tts and system engine)
  console.log('Testing previewVoice...');
  const sysPrev = await manager.call('desktop-pet', 'previewVoice', { engine: 'system' });
  assert(sysPrev && sysPrev.ok && sysPrev.engine === 'system', 'previewVoice with system engine must return ok: true');
  ok('previewVoice system engine verified');

  const t0 = Date.now();
  const prevRes = await manager.call('desktop-pet', 'previewVoice', {
    text: '你好呀，我是小轨！',
    voice: 'zh-CN-XiaoyiNeural',
    rate: 0,
    pitch: 10,
  });
  assert(prevRes && prevRes.ok && prevRes.audioUrl, 'previewVoice must return ok and audioUrl');
  assert(prevRes.audioUrl.startsWith('data:audio/mp3;base64,'), 'audioUrl must be base64 data url');
  console.log(`previewVoice returned in ${Date.now() - t0}ms, audio length: ${prevRes.audioUrl.length}`);
  ok('previewVoice API verified');

  // 4. Test sendQuip with Edge TTS
  console.log('Testing sendQuip with Edge TTS...');
  const t1 = Date.now();
  const quipRes = await manager.call('desktop-pet', 'quip', { text: '伸个懒腰？我陪你' });
  assert(quipRes && quipRes.ok, 'quip must succeed');
  assert(quipRes.audioUrl && quipRes.audioUrl.startsWith('data:audio/mp3;base64,'), 'quip should contain audioUrl when voiceOn');
  console.log(`quip returned in ${Date.now() - t1}ms`);
  ok('quip with Edge TTS verified');

  // 5. Test clean teardown
  manager.deactivate('desktop-pet');
  ok('deactivate clean');

  console.log('ALL TTS INTEGRATION TESTS PASSED');
  app.exit(0);
}).catch(err => {
  console.error('FAIL:', err);
  app.exit(1);
});
