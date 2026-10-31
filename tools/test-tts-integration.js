/* desktop-pet TTS integration & IPC verification test */

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
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
  assert(Array.isArray(quipRes.segments) && quipRes.segments.length === 1, 'quip result must carry its segment queue');
  console.log(`quip returned in ${Date.now() - t1}ms`);
  ok('quip with Edge TTS verified');

  // 4b. Long quip speech arrives as a multi-segment queue
  const longQuip = await manager.call('desktop-pet', 'quip', {
    text: '这是一段很长的播报内容，用来验证长文本会被切成多个语音分段排队播放，而不是一次性丢给合成服务然后被截断。' +
      '第二句继续补充更多的内容，让总长度稳稳超过单段一百字的上限，这样分段逻辑才会真正生效，而不是走单段捷径。' +
      '第三句再垫一些字数，确保一定溢出。第四句收尾，验证完整。',
  });
  assert(longQuip && longQuip.ok, 'long quip must succeed');
  assert(Array.isArray(longQuip.segments) && longQuip.segments.length >= 2, 'long text must split into >= 2 segments');
  assert(longQuip.audioUrl === longQuip.segments[0].audioUrl, 'audioUrl must alias the first segment');
  ok('long quip segmented into a playback queue');

  // 4c. Custom-API engine end-to-end against a local fake provider
  console.log('Testing custom-API engine against a local provider...');
  const fakeRequests = [];
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      fakeRequests.push({ path: req.url, auth: req.headers.authorization || '', body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(Buffer.alloc(1200, 1)); // ~0.4s of fake audio
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const apiBase = `http://127.0.0.1:${fake.address().port}/v1`;
  await manager.call('desktop-pet', 'setPrefs', {
    voiceEngine: 'api',
    voiceOn: true,
    apiConfig: { provider: 'openai', baseUrl: apiBase, apiKey: 'sk-local', model: 'tts-1', voice: 'alloy' },
  });
  const apiPrev = await manager.call('desktop-pet', 'previewVoice', { engine: 'api', text: '自定义接口试听。' });
  assert(apiPrev && apiPrev.ok && Array.isArray(apiPrev.segments) && apiPrev.segments.length === 1,
    `api preview must synthesize via the local provider: ${apiPrev && apiPrev.error}`);
  assert(apiPrev.audioUrl.startsWith('data:audio/mpeg;base64,'), 'api preview audio must be a data url');
  const apiQuipText = '自定义接口播报测试，看看能不能排队说话。' +
    '第二句继续补充内容，让总长度稳稳超过单段两百字的上限，这样自定义接口的分段排队逻辑才会真正生效而不是走单段捷径。' +
    '第三句再垫上不少字数，把段落撑得足够长。第四句补充更多细节，确保整体长度已经明显溢出。第五句收尾，验证完整。' +
    '再多垫一句字数，确保分段。'.repeat(8);
  const apiQuip = await manager.call('desktop-pet', 'quip', { text: apiQuipText });
  assert(apiQuip && apiQuip.ok, 'api quip must succeed');
  assert(Array.isArray(apiQuip.segments) && apiQuip.segments.length >= 2, 'long api quip must split into >= 2 segments');
  assert(fakeRequests.length >= 3 && fakeRequests.every(h => h.path === '/v1/audio/speech' && h.auth === 'Bearer sk-local'),
    'every api request must hit the provider endpoint with the configured key');
  const inputs = fakeRequests.map(h => { try { return JSON.parse(h.body).input; } catch { return ''; } });
  assert(inputs.slice(1).join('').replace(/\s+/g, '') === apiQuipText.replace(/\s+/g, ''), 'provider must receive the full text in order');
  // engine preference persists through prefsPayload round-trips
  const stApi = await manager.call('desktop-pet', 'getState');
  assert.strictEqual(stApi.prefs.voiceEngine, 'api');
  assert.strictEqual(stApi.prefs.apiConfig.baseUrl, apiBase);
  fake.close();
  ok('custom-API engine end-to-end verified');

  // 5. Test clean teardown
  manager.deactivate('desktop-pet');
  ok('deactivate clean');

  console.log('ALL TTS INTEGRATION TESTS PASSED');
  app.exit(0);
}).catch(err => {
  console.error('FAIL:', err);
  app.exit(1);
});
