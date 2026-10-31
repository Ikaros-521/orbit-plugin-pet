/* Offline tests for the custom-API TTS service.
   A local http server plays provider: OpenAI-compatible /audio/speech,
   a custom template endpoint, and failure modes (401, JSON-200, 500-then-OK,
   slow). No network beyond 127.0.0.1, no real API key.

   Run: node tools/test-tts-api.js */
const assert = require('assert');
const http = require('http');

const {
  ApiTTSService,
  normalizeConfig,
  apiConfigError,
} = require('../services/tts-api');

const ok = msg => console.log('ok -', msg);
const MP3 = Buffer.alloc(2400, 1); // ~0.8s at the service's 24kbps guess
const WAV = Buffer.alloc(4800, 2);

const hits = []; // { path, method, auth, query, body, json }
let flakyState = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = JSON.parse(body); } catch { /* not json */ }
    hits.push({ path: url.pathname, method: req.method, auth: req.headers.authorization || '', query: url.search, body, json, headers: req.headers });

    if (url.pathname === '/v1/audio/speech' || url.pathname.endsWith('/audio/speech')) {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      res.end(MP3);
    } else if (url.pathname === '/custom') {
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(WAV);
    } else if (url.pathname === '/fail401') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
    } else if (url.pathname === '/json200') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'no audio for you' }));
    } else if (url.pathname === '/flaky') {
      flakyState++;
      if (flakyState === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'boom' } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
        res.end(MP3);
      }
    } else if (url.pathname === '/slow') {
      setTimeout(() => { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(MP3); }, 6500);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
});

async function main() {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const svc = new ApiTTSService({ maxCache: 4 });

  console.log('--- Config validation ---');
  assert(apiConfigError(normalizeConfig({})), 'openai mode without baseUrl must fail');
  assert(/Base URL/.test(apiConfigError(normalizeConfig({}))), 'must name the missing baseUrl');
  assert(apiConfigError(normalizeConfig({ baseUrl: 'ftp://x' })), 'non-http baseUrl must fail');
  assert(apiConfigError(normalizeConfig({ provider: 'custom', custom: { url: '' } })), 'custom without url must fail');
  assert(apiConfigError(normalizeConfig({ provider: 'custom', custom: { url: base + '/x', headers: '{oops' } })), 'bad headers JSON must fail');
  assert(apiConfigError(normalizeConfig({ provider: 'custom', custom: { url: base + '/x', body: '{"input":"{text_json}"' } })), 'bad body JSON must fail');
  assert(!apiConfigError(normalizeConfig({ baseUrl: base })), 'valid openai config must pass');
  assert(!apiConfigError(normalizeConfig({ provider: 'custom', custom: { url: base + '/custom' } })), 'valid custom config must pass');
  const norm = normalizeConfig({ speed: 99, format: 'xyz', custom: { method: 'delete' } });
  assert.strictEqual(norm.speed, 4, 'speed clamps to 4');
  assert.strictEqual(norm.format, 'mp3', 'unknown format falls back to mp3');
  assert.strictEqual(norm.custom.method, 'POST', 'unknown method falls back to POST');
  ok('normalizeConfig + apiConfigError verified');

  console.log('--- OpenAI-compatible synthesis ---');
  const cfg = { provider: 'openai', baseUrl: `${base}/v1`, apiKey: 'sk-test', model: 'tts-1', voice: 'alloy' };
  const r1 = await svc.synthesize({ text: '你好，自定义接口。', config: cfg, rate: 20 });
  assert.strictEqual(r1.ok, true, `openai synthesis failed: ${r1.error}`);
  assert(r1.audioUrl.startsWith('data:audio/mpeg;base64,'), 'must be an audio data url');
  assert(r1.duration > 0, 'duration estimate must be positive');
  const hit = hits[hits.length - 1];
  assert.strictEqual(hit.auth, 'Bearer sk-test', 'Authorization header must be sent');
  assert.strictEqual(hit.path, '/v1/audio/speech', 'endpoint must be baseUrl + /audio/speech');
  assert.strictEqual(hit.json.input, '你好，自定义接口。', 'text must ride the input field');
  assert.strictEqual(hit.json.model, 'tts-1');
  assert.strictEqual(hit.json.voice, 'alloy');
  assert(Math.abs(hit.json.speed - 1.2) < 0.001, 'rate offset maps to speed multiplier');
  const r1b = await svc.synthesize({ text: '你好，自定义接口。', config: cfg });
  assert.strictEqual(r1b.cached, true, 'repeat text must hit the cache');
  assert.strictEqual(hits.length, 1, 'cache hit must not re-request');
  ok('openai-compatible request/auth/payload/cache verified');

  console.log('--- Custom-template synthesis ---');
  const ccfg = {
    provider: 'custom',
    custom: {
      method: 'POST',
      url: `${base}/custom?text={text_url}`,
      headers: '{"Authorization":"Bearer ck-1","X-Probe":"yes"}',
      body: '{"input":"{text_json}","model":"m"}',
    },
  };
  const tricky = '带"引号"和\\反斜杠的文本。';
  const r2 = await svc.synthesize({ text: tricky, config: ccfg });
  assert.strictEqual(r2.ok, true, `custom synthesis failed: ${r2.error}`);
  assert(r2.audioUrl.startsWith('data:audio/wav;base64,'), 'mime must follow the response content-type');
  const hit2 = hits[hits.length - 1];
  assert(hit2.query.includes(encodeURIComponent(tricky)), 'URL placeholder must be percent-encoded');
  assert.strictEqual(hit2.headers['x-probe'], 'yes', 'custom headers must be applied');
  assert.strictEqual(hit2.headers.authorization, 'Bearer ck-1');
  assert.strictEqual(hit2.json.input, tricky, 'body placeholder must JSON-escape and reassemble exactly');
  ok('custom template url/headers/body placeholders verified');

  console.log('--- Long text segments through an API ---');
  const longText = '这是一段很长的播报内容，用来验证自定义接口同样会把长文本切成多个分段排队播放，' +
    '而不是一次性丢给接口然后超时或者被截断。第二句继续补充内容，让总长度稳稳超过单段两百字的上限，' +
    '这样分段逻辑才会真正生效而不是走单段捷径。第三句再垫上不少字数，把段落撑得足够长。' +
    '第四句补充更多细节，确保整体长度已经明显溢出。第五句继续扩充内容，把字数堆过界限。' +
    '第六句再补充一些细节。第七句继续描述。第八句收尾，验证完整无缺。第九句兜底。';
  const q = await svc.synthesizeQueued({ text: longText, config: cfg });
  assert.strictEqual(q.ok, true, `queued api synthesis failed: ${q.error}`);
  assert(q.segments.length >= 2, 'long text must split into >= 2 segments');
  for (const s of q.segments) assert(s.audioUrl.startsWith('data:audio/mpeg;base64,'));
  assert.strictEqual(q.segments.map(s => s.text).join('').replace(/\s+/g, ''), longText.replace(/\s+/g, ''), 'segments must cover the whole text');
  ok(`queued api synthesis verified (${q.segments.length} segments)`);

  console.log('--- Failure modes ---');
  const e401 = await svc.synthesize({ text: 'x', config: { provider: 'custom', custom: { url: `${base}/fail401`, body: '' } } });
  assert.strictEqual(e401.ok, false);
  assert(/HTTP 401/.test(e401.error) && /bad key/.test(e401.error), `401 error must carry status+message: ${e401.error}`);
  const ejson = await svc.synthesize({ text: 'x', config: { provider: 'custom', custom: { url: `${base}/json200`, body: '' } } });
  assert.strictEqual(ejson.ok, false);
  assert(/未返回音频/.test(ejson.error) && /no audio/.test(ejson.error), `json-200 must be reported as no-audio: ${ejson.error}`);
  const flaky = new ApiTTSService({ maxCache: 2 });
  const eflaky = await flaky.synthesize({ text: 'x', config: { provider: 'custom', custom: { url: `${base}/flaky`, body: '' } } });
  assert.strictEqual(eflaky.ok, true, `a 500 must be retried and recover: ${eflaky.error}`);
  const eslow = new ApiTTSService({ maxCache: 2 });
  const t0 = Date.now();
  const etimeout = await eslow.synthesize({ text: 'x', config: { provider: 'custom', custom: { url: `${base}/slow`, body: '' }, timeoutMs: 5000 } });
  assert.strictEqual(etimeout.ok, false);
  assert(/超时/.test(etimeout.error), `slow endpoint must abort with a timeout error: ${etimeout.error}`);
  const elapsed = Date.now() - t0;
  assert(elapsed < 12000, `timeout+retry must not hang (took ${elapsed}ms)`);
  ok('401 / json-200 / 500-retry / timeout verified');

  server.close();
  console.log('ALL CUSTOM API TTS TESTS PASSED');
}

main().catch(err => {
  console.error('Test failed:', err);
  try { server.close(); } catch { /* gone */ }
  process.exit(1);
});
