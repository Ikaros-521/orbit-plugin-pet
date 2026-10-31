/* Custom-API TTS service — the audiobook-app style engine.
   Two provider modes cover the mainstream "bring your own API" setups:

   - 'openai': any OpenAI-compatible `/audio/speech` endpoint — OpenAI
     itself, SiliconFlow, new-api/one-api proxies, GPT-SoVITS, fish-audio's
     openapi, ... configured with baseUrl + apiKey + model + voice.
   - 'custom': a user-supplied HTTP request template (method/url/headers/
     body) with {text}/{text_json}/{text_url} placeholders; whatever the
     endpoint returns as audio bytes gets played.

   Long texts reuse the segmentation + queued-playback pipeline: text is
   split (larger cap than edge — API endpoints take bigger inputs), segments
   are synthesized in parallel, and the renderer plays them back to back.
   Results are cached (API calls cost money) in a small LRU. */

const { splitSegments } = require('./tts');

const API_SEGMENT_MAX_CHARS = 200;
const API_TIMEOUT_MS = 30000;
const MAX_CACHE_ITEMS = 10;
const TRANSIENT_RE = /timed?\s?out|timeout|aborted|econn|socket|network|fetch failed|429|500|502|503|504|temporarily/i;

const MIME_BY_FORMAT = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

const DEFAULT_API_CONFIG = {
  provider: 'openai', // 'openai' | 'custom'
  baseUrl: '',
  apiKey: '',
  model: '',
  voice: '',
  format: 'mp3',
  speed: 1,
  timeoutMs: API_TIMEOUT_MS,
  custom: {
    method: 'POST',
    url: '',
    headers: '{}',
    body: '{"input":"{text_json}","model":"tts-1"}',
  },
};

/* --- Helpers ---------------------------------------------------------------- */

const delay = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function normalizeConfig(raw) {
  const cfg = (raw && typeof raw === 'object') ? raw : {};
  const custom = (cfg.custom && typeof cfg.custom === 'object') ? cfg.custom : {};
  const out = {
    provider: cfg.provider === 'custom' ? 'custom' : 'openai',
    baseUrl: String(cfg.baseUrl || '').trim(),
    apiKey: String(cfg.apiKey || '').trim(),
    model: String(cfg.model || '').trim(),
    voice: String(cfg.voice || '').trim(),
    format: MIME_BY_FORMAT[String(cfg.format || '').trim().toLowerCase()] ? String(cfg.format).trim().toLowerCase() : 'mp3',
    speed: Number.isFinite(Number(cfg.speed)) ? clamp(Number(cfg.speed), 0.25, 4) : 1,
    timeoutMs: Number.isFinite(Number(cfg.timeoutMs)) ? clamp(Math.round(Number(cfg.timeoutMs)), 5000, 120000) : API_TIMEOUT_MS,
    custom: {
      method: ['GET', 'POST', 'PUT'].includes(String(custom.method || '').toUpperCase()) ? String(custom.method).toUpperCase() : 'POST',
      url: String(custom.url || '').trim(),
      headers: String(custom.headers || '{}'),
      body: String(custom.body == null ? '' : custom.body),
    },
  };
  if (!out.custom.headers.trim()) out.custom.headers = '{}';
  return out;
}

/* Config problems the user must fix before synthesis can run. Returns a
   short message or null. Returned in results as fallback:true so the pet
   still talks via the system engine while the panel shows the reason. */
function configError(cfg) {
  if (cfg.provider === 'custom') {
    if (!cfg.custom.url) return '请求 URL 不能为空';
    if (!/^(https?:\/\/|plugin:\/\/)/i.test(cfg.custom.url)) return '请求 URL 必须以 http(s):// 开头';
    try { JSON.parse(cfg.custom.headers); } catch { return '请求头不是合法 JSON'; }
    const body = cfg.custom.body.trim();
    if (body && (body.startsWith('{') || body.startsWith('['))) {
      try { JSON.parse(body.replace(/\{text(_json|_url)?\}/g, 'x')); } catch { return '请求体模板不是合法 JSON（字符串占位处请用 {text_json}）'; }
    }
    return null;
  }
  if (!cfg.baseUrl) return 'Base URL 不能为空';
  if (!/^https?:\/\//i.test(cfg.baseUrl)) return 'Base URL 必须以 http(s):// 开头';
  return null;
}

function fingerprint(cfg) {
  return [cfg.provider, cfg.baseUrl, cfg.apiKey, cfg.model, cfg.voice, cfg.format, cfg.speed,
    cfg.custom.method, cfg.custom.url, cfg.custom.headers, cfg.custom.body].join('|');
}

/* {text} raw, {text_json} JSON-string-escaped, {text_url} percent-encoded.
   Inside a URL every placeholder is percent-encoded. */
function applyTemplate(str, text, forUrl) {
  return String(str == null ? '' : str)
    .replace(/\{text_url\}/g, encodeURIComponent(text))
    .replace(/\{text_json\}/g, () => JSON.stringify(text).slice(1, -1))
    .replace(/\{text\}/g, forUrl ? encodeURIComponent(text) : text);
}

function speechEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/audio\/speech$/i.test(base)) return base;
  return `${base}/audio/speech`;
}

function audioMime(contentType, format) {
  const ct = String(contentType || '').toLowerCase();
  const m = ct.match(/^audio\/[\w.+-]+/);
  if (m) return m[0];
  return MIME_BY_FORMAT[format] || 'audio/mpeg';
}

/* Over-estimate on purpose (assume a low 24 kbps): a bubble that lingers
   beats a timer that guns the voice down mid-sentence. */
function estimateDuration(bytes) {
  return (bytes * 8) / 24000;
}

async function extractErrorMessage(res) {
  let body = '';
  try { body = await res.text(); } catch { /* binary or gone */ }
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = (j.error && (j.error.message || j.error.code)) || j.message || j.msg || '';
  } catch { msg = body; }
  msg = String(msg || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `HTTP ${res.status}${msg ? `: ${msg}` : ''}`;
}

/* --- Service ---------------------------------------------------------------- */

class ApiTTSService {
  constructor(options = {}) {
    this.maxCache = options.maxCache || MAX_CACHE_ITEMS;
    this.segmentMaxChars = options.segmentMaxChars || API_SEGMENT_MAX_CHARS;
    this.cache = new Map(); // key -> { audioUrl, duration, mime }
  }

  clearCache() { this.cache.clear(); }
  getCacheSize() { return this.cache.size; }

  getFromCache(key) {
    if (!this.cache.has(key)) return null;
    const item = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, item);
    return item;
  }

  putInCache(key, value) {
    if (this.cache.has(key)) this.cache.delete(key);
    else if (this.cache.size >= this.maxCache) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, value);
  }

  buildRequest(text, cfg, rate) {
    const speed = clamp(cfg.speed * (1 + (Number(rate) || 0) / 100), 0.25, 4);
    if (cfg.provider === 'custom') {
      const url = applyTemplate(cfg.custom.url, text, true);
      let headers = {};
      try { headers = JSON.parse(cfg.custom.headers) || {}; } catch { /* configError already gates this */ }
      const body = cfg.custom.body.trim()
        ? applyTemplate(cfg.custom.body, text, false)
        : undefined;
      return {
        url,
        init: {
          method: cfg.custom.method,
          headers,
          ...(body !== undefined && cfg.custom.method !== 'GET' ? { body } : {}),
        },
      };
    }
    const payload = {
      model: cfg.model || 'tts-1',
      input: text,
      response_format: cfg.format,
      ...(cfg.voice ? { voice: cfg.voice } : {}),
      ...(Math.abs(speed - 1) > 0.001 ? { speed } : {}),
    };
    return {
      url: speechEndpoint(cfg.baseUrl),
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(payload),
      },
    };
  }

  /* One HTTP round-trip against the provider. No retries by itself. */
  async attemptOnce(text, cfg, rate) {
    const { url, init } = this.buildRequest(text, cfg, rate);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let res;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const aborted = err && (err.name === 'AbortError' || /aborted/i.test(String(err.message || '')));
      return {
        ok: false,
        error: aborted ? `API 请求超时 (${Math.round(cfg.timeoutMs / 1000)}s)` : `网络请求失败: ${(err && err.message) || String(err)}`,
        fallback: true,
      };
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      return { ok: false, error: await extractErrorMessage(res), fallback: true };
    }
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    // A 200 whose body is JSON/text/html is the provider answering with an
    // error object — never audio bytes, no matter the configured format
    if (/(json|text\/|html|xml)/.test(ct)) {
      let detail = '';
      try {
        const txt = await res.text();
        try { const j = JSON.parse(txt); detail = j.message || j.msg || (j.error && j.error.message) || txt; }
        catch { detail = txt; }
      } catch { /* unreadable */ }
      return {
        ok: false,
        error: `接口未返回音频（${ct || 'no content-type'}）${String(detail || '').replace(/\s+/g, ' ').slice(0, 120)}`,
        fallback: true,
      };
    }
    const mime = audioMime(ct, cfg.format);

    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) {
      return { ok: false, error: '接口返回了空音频', fallback: true };
    }
    const base64 = Buffer.from(buf).toString('base64');
    return {
      ok: true,
      audioUrl: `data:${mime};base64,${base64}`,
      duration: estimateDuration(buf.byteLength),
      format: cfg.format,
    };
  }

  /**
   * Synthesize one piece of text through the configured API.
   * Same result contract as the edge-tts service, so sendQuip/previewVoice
   * treat both engines uniformly.
   */
  async synthesize({ text, config, rate } = {}) {
    const rawText = typeof text === 'string' ? text.trim() : '';
    if (!rawText) return { ok: false, error: 'Text is empty', fallback: false };
    const cfg = normalizeConfig(config);
    const problem = configError(cfg);
    if (problem) return { ok: false, error: problem, fallback: true };

    const key = `${fingerprint(cfg)}|${rawText}`;
    const cached = this.getFromCache(key);
    if (cached) {
      return { ok: true, cached: true, audioUrl: cached.audioUrl, duration: cached.duration, format: cfg.format, text: rawText };
    }

    let res;
    for (let attempt = 0; ; attempt++) {
      res = await this.attemptOnce(rawText, cfg, rate);
      if (res.ok || attempt >= 1 || !TRANSIENT_RE.test(res.error || '')) break;
      await delay(400 + Math.random() * 300);
    }
    if (!res.ok) return { ...res, text: rawText };

    this.putInCache(key, { audioUrl: res.audioUrl, duration: res.duration, at: Date.now() });
    return { ...res, cached: false, text: rawText };
  }

  /**
   * Long text as an ordered segment queue (mirrors edge-tts synthesizeQueued).
   * @returns {Promise<Object>} `{ ok, segments: [{text,audioUrl,duration}], audioUrl, duration }`
   */
  async synthesizeQueued(params = {}) {
    const segments = splitSegments(String(params.text || ''), this.segmentMaxChars);
    if (segments.length === 0) {
      return { ok: false, error: 'Text is empty', fallback: false };
    }
    if (segments.length === 1) {
      const res = await this.synthesize({ ...params, text: segments[0] });
      if (!res || !res.ok) return res;
      return { ...res, segments: [{ text: res.text, audioUrl: res.audioUrl, duration: res.duration }] };
    }
    const results = await Promise.all(segments.map(text => this.synthesize({ ...params, text })));
    const failed = results.find(r => !r || !r.ok);
    if (failed) {
      return { ok: false, error: (failed && failed.error) || 'segment synthesis failed', fallback: true, text: String(params.text || '').trim() };
    }
    return {
      ok: true,
      cached: results.every(r => r.cached),
      segments: results.map(r => ({ text: r.text, audioUrl: r.audioUrl, duration: r.duration })),
      audioUrl: results[0].audioUrl,
      duration: results.reduce((sum, r) => sum + (r.duration || 0), 0),
      format: results[0].format,
      text: String(params.text || '').trim(),
    };
  }
}

const defaultInstance = new ApiTTSService();

module.exports = {
  ApiTTSService,
  apiTtsService: defaultInstance,
  DEFAULT_API_CONFIG,
  API_SEGMENT_MAX_CHARS,
  API_TIMEOUT_MS,
  normalizeConfig: normalizeConfig,
  apiConfigError: configError,
};
