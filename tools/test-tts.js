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
  splitSegments,
  SEGMENT_MAX_CHARS,
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

  console.log('--- Testing Long-Text Segmentation (splitSegments) ---');
  assert.deepStrictEqual(splitSegments(''), []);
  assert.deepStrictEqual(splitSegments('   '), []);
  assert.deepStrictEqual(splitSegments('你好呀'), ['你好呀']);
  assert.deepStrictEqual(splitSegments('短句。再来一句！'), ['短句。再来一句！'], 'short pieces merge into one segment');
  assert.deepStrictEqual(splitSegments('圆周率是3.14，除不尽。'), ['圆周率是3.14，除不尽。'], 'decimal dot must not split');
  assert.deepStrictEqual(
    splitSegments('Hello there my friend. Next one!', 25),
    ['Hello there my friend.', 'Next one!'],
    'english sentence dot at word boundary splits under a tight cap',
  );

  // invariant battery: segments reassemble the text, none oversized
  const battery = [
    '备忘录提醒：下午三点去开需求评审会，记得带上笔记本和上周的会议纪要，另外顺路把打印好的合同交给行政部的小王，谢谢啦！',
    '好'.repeat(250), // no punctuation at all — force split
    '一二三四五六七八九十，'.repeat(18) + '结束了。', // comma marathon
    'First sentence here. Second sentence follows! Third? Fourth; semi too… and a final one for good measure.',
    '混合中English text with 中文 and numbers like 42 以及 3.14159 mixed in，保持完整。',
  ];
  for (const text of battery) {
    const segs = splitSegments(text);
    assert(segs.length >= 1, 'must produce segments');
    for (const s of segs) assert(s.length <= SEGMENT_MAX_CHARS, `segment oversized: ${s.length} chars — "${s.slice(0, 30)}…"`);
    const squeeze = t => t.replace(/\s+/g, '');
    assert.strictEqual(squeeze(segs.join('')), squeeze(text), `reassembled text mismatch for: ${text.slice(0, 20)}…`);
  }

  // long sentence battery: punctuation splitting must actually split
  const overCap = splitSegments('一'.repeat(60) + '。' + '二'.repeat(60) + '！');
  assert.strictEqual(overCap.length, 2, 'two 61-char sentences must split at the cap');
  assert(overCap[0].endsWith('。') && overCap[1].endsWith('！'), 'segments keep their enders');
  const noPunct = splitSegments(battery[1]);
  assert(noPunct.every(s => s.length <= SEGMENT_MAX_CHARS), 'force split keeps cap');
  ok('splitSegments verified (merge, decimal-safe, force split, reassembly)');

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

  console.log('--- Testing Voice/Script Mismatch Auto-Correction ---');
  // en voice + Chinese text is a hard NO_AUDIO refusal from the service;
  // the service must silently correct to the zh default instead of failing
  const fixed = await ttsService.synthesize({ text: '你好呀，我是小轨桌宠！', voice: 'en-US-AnaNeural' });
  assert.strictEqual(fixed.ok, true, `mismatch correction failed: ${fixed.error}`);
  assert.strictEqual(fixed.voice, DEFAULT_VOICE_ZH, 'must be corrected to the zh default voice');
  assert.strictEqual(fixed.voiceAdjusted, true, 'correction must be reported');
  // zh voice + English text works natively — must NOT be "corrected"
  const native = await ttsService.synthesize({ text: 'Hello my friend, nice to meet you!', voice: 'zh-CN-XiaoyiNeural' });
  assert.strictEqual(native.ok, true, `zh voice + en text failed: ${native.error}`);
  assert.strictEqual(native.voice, 'zh-CN-XiaoyiNeural');
  assert(!native.voiceAdjusted, 'zh voice reading latin text needs no correction');
  ok('voice/script mismatch corrected instead of NO_AUDIO');

  console.log('--- Testing Transient-Failure Retry (stubbed) ---');
  {
    const stub = new EdgeTTSService({ maxCache: 2 });
    const calls = [];
    const original = stub.attemptOnce.bind(stub);
    stub.attemptOnce = async (...args) => {
      calls.push(String(args[1]));
      if (calls.length === 1) {
        const err = new Error('TTS synthesis timed out after 8000ms');
        return { ok: false, error: err.message, fallback: true };
      }
      return original(...args);
    };
    const retried = await stub.synthesize({ text: '重试之后就能成功的话。' });
    assert.strictEqual(retried.ok, true, `retry must recover a transient timeout: ${retried.error}`);
    assert.strictEqual(calls.length, 2, 'exactly one retry');
    ok('transient timeout retried once and recovered');
  }
  {
    const stub = new EdgeTTSService({ maxCache: 2 });
    const calls = [];
    stub.attemptOnce = async () => {
      calls.push(1);
      return { ok: false, error: 'The service returned no audio. Voices are locale specific.', fallback: true };
    };
    const hard = await stub.synthesize({ text: '确定性失败不该重试。' });
    assert.strictEqual(hard.ok, false, 'deterministic failure stays failed');
    assert.strictEqual(hard.fallback, true);
    assert.strictEqual(calls.length, 1, 'deterministic failure must NOT be retried');
    ok('deterministic NO_AUDIO failure not retried');
  }

  console.log('--- Testing Queued Synthesis of Long Text ---');
  const queuedText = '提醒：下午三点需要去参加需求评审会议，请记得带上笔记本电脑和上周整理好的会议纪要，顺便把打印出来的签到表也一起带上。' +
    '会议结束后顺便去行政部拿一下盖好章的合同，然后交给项目负责人确认签字，别再像上次那样忘了拿回来。' +
    '路上注意安全，晚饭记得吃点好的犒劳自己。晚上早点休息，明天上午还有一场重要的演示，一定要养足精神，加油！';
  assert(splitSegments(queuedText).length >= 2, 'test text must actually split');
  const tq = Date.now();
  const queued = await ttsService.synthesizeQueued({
    text: queuedText,
    voice: 'zh-CN-XiaoyiNeural',
    rate: 0,
    pitch: 10,
  });
  assert.strictEqual(queued.ok, true, `queued synthesis failed: ${queued.error}`);
  assert(Array.isArray(queued.segments) && queued.segments.length >= 2, 'must return >= 2 segments');
  for (const seg of queued.segments) {
    assert(seg.audioUrl && seg.audioUrl.startsWith('data:audio/mp3;base64,'), 'each segment must be an mp3 data url');
    assert(seg.audioUrl.length > 1000, 'each segment must carry real audio');
    assert(typeof seg.text === 'string' && seg.text.length <= 100, 'each segment text must be bounded');
  }
  assert(queued.audioUrl === queued.segments[0].audioUrl, 'audioUrl must alias the first segment');
  assert(queued.duration > 0, 'total duration must be positive');
  const spoken = queued.segments.map(s => s.text).join('');
  assert(spoken.replace(/\s+/g, '') === queuedText.replace(/\s+/g, ''), 'segments must cover the whole text');
  console.log(`Queued synthesis: ${queued.segments.length} segments in ${Date.now() - tq}ms, est. ${Math.round(queued.duration)}s audio`);
  ok('queued long-text synthesis verified');

  console.log('--- Testing Queued Synthesis Short-Circuit (single segment) ---');
  const single = await ttsService.synthesizeQueued({ text: '喝口水吧，一直盯着屏幕', voice: 'zh-CN-XiaoyiNeural', rate: 0, pitch: 10 });
  assert.strictEqual(single.ok, true);
  assert.strictEqual(single.cached, true, 'short text should reuse the cache');
  assert.strictEqual(single.segments.length, 1);
  assert.strictEqual(single.audioUrl, single.segments[0].audioUrl);
  ok('single-segment short-circuit verified');

  console.log('--- All TTS Service Tests Passed! ---');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
