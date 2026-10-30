/* Unit and smoke tests for desktop-pet TTS service */

const assert = require('assert');
const {
  EdgeTTSService,
  ttsService,
  PRESET_VOICES,
  DEFAULT_VOICE_ZH,
  DEFAULT_VOICE_EN,
  formatRate,
  formatPitch,
} = require('../services/tts');

const ok = msg => console.log('ok -', msg);

async function run() {
  console.log('--- Testing Preset Voices & Helpers ---');
  assert(Array.isArray(PRESET_VOICES) && PRESET_VOICES.length >= 8, 'Preset voices should have >= 8 items');
  assert.strictEqual(DEFAULT_VOICE_ZH, 'zh-CN-XiaoyiNeural');
  assert.strictEqual(DEFAULT_VOICE_EN, 'en-US-AnaNeural');

  assert.strictEqual(formatRate(0), '+0%');
  assert.strictEqual(formatRate(15), '+15%');
  assert.strictEqual(formatRate(-10), '-10%');
  assert.strictEqual(formatRate('+20%'), '+20%');

  assert.strictEqual(formatPitch(0), '+0Hz');
  assert.strictEqual(formatPitch(25), '+25Hz');
  assert.strictEqual(formatPitch('-5Hz'), '-5Hz');
  ok('helpers and presets verified');

  console.log('--- Testing LRU Cache Logic ---');
  const miniService = new EdgeTTSService({ maxCache: 2 });
  miniService.putInCache('k1', { val: 1 });
  miniService.putInCache('k2', { val: 2 });
  assert.strictEqual(miniService.getCacheSize(), 2);

  // Access k1, making k2 the oldest
  assert.strictEqual(miniService.getFromCache('k1').val, 1);
  // Put k3, which should evict k2
  miniService.putInCache('k3', { val: 3 });
  assert.strictEqual(miniService.getCacheSize(), 2);
  assert.strictEqual(miniService.getFromCache('k2'), null, 'k2 should be evicted');
  assert.strictEqual(miniService.getFromCache('k1').val, 1, 'k1 should still exist');
  assert.strictEqual(miniService.getFromCache('k3').val, 3, 'k3 should exist');
  ok('LRU bounded cache verified');

  console.log('--- Testing Empty Text Validation ---');
  const emptyRes = await ttsService.synthesize({ text: '   ' });
  assert.strictEqual(emptyRes.ok, false);
  assert.strictEqual(emptyRes.error, 'Text is empty');
  ok('empty text handled gracefully');

  console.log('--- Testing Live Edge TTS Synthesis ---');
  const t0 = Date.now();
  const res1 = await ttsService.synthesize({
    text: '喝口水吧，一直盯着屏幕',
    voice: 'zh-CN-XiaoyiNeural',
    rate: 0,
    pitch: 10,
  });

  assert.strictEqual(res1.ok, true, `Synthesis failed: ${res1.error}`);
  assert.strictEqual(res1.cached, false, 'First call should not be from cache');
  assert(res1.audioUrl.startsWith('data:audio/mp3;base64,'), 'Audio URL must be mp3 data URL');
  assert(res1.audioUrl.length > 1000, 'Audio payload should be valid');
  console.log(`Live synthesis duration: ${Date.now() - t0}ms, audio base64 len: ${res1.audioUrl.length}`);
  ok('live synthesis succeeded');

  console.log('--- Testing Cache Hit on Repeated Text ---');
  const t1 = Date.now();
  const res2 = await ttsService.synthesize({
    text: '喝口水吧，一直盯着屏幕',
    voice: 'zh-CN-XiaoyiNeural',
    rate: 0,
    pitch: 10,
  });
  const cacheHitTime = Date.now() - t1;
  assert.strictEqual(res2.ok, true);
  assert.strictEqual(res2.cached, true, 'Second call MUST hit cache');
  assert.strictEqual(res2.audioUrl, res1.audioUrl, 'Cached audio must match');
  console.log(`Cache hit latency: ${cacheHitTime}ms (expected < 10ms)`);
  assert(cacheHitTime < 50, 'Cache hit should be near instantaneous');
  ok('cache hit verified');

  console.log('--- All TTS Service Tests Passed! ---');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
