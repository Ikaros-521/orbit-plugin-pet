/* desktop-pet TTS service.
   Powered by @andresaya/edge-tts to provide high-fidelity neural speech
   without requiring an API key or Microsoft Edge installation.

   Design principles:
   - KISS & lightweight: bounded memory LRU cache (<= 20 items, ~300KB RAM)
   - Resilient: timeouts, input normalization, error capture
   - Fallback-ready: returns `{ ok: false, fallback: true }` on network/429
     so callers can seamlessly fall back to local speechSynthesis without crashes.
*/

const { EdgeTTS } = require('@andresaya/edge-tts');

/* --- Preset Voices -------------------------------------------------------- */

const PRESET_VOICES = [
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', desc: '甜美可爱 · 桌宠推荐', lang: 'zh', gender: 'Female' },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', desc: '温暖自然女声', lang: 'zh', gender: 'Female' },
  { id: 'zh-CN-YunxiNeural', name: '云希', desc: '阳光活泼少年', lang: 'zh', gender: 'Male' },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', desc: '萌趣小男孩', lang: 'zh', gender: 'Male' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '小北', desc: '东北话 · 幽默风趣', lang: 'zh', gender: 'Female' },
  { id: 'zh-TW-HsiaoChenNeural', name: '晓臻', desc: '台湾腔甜美女声', lang: 'zh', gender: 'Female' },
  { id: 'zh-HK-HiuMaanNeural', name: '晓曼', desc: '粤语女声', lang: 'zh', gender: 'Female' },
  { id: 'en-US-AnaNeural', name: 'Ana', desc: '萌系卡通童声 (英文)', lang: 'en', gender: 'Female' },
  { id: 'en-US-AriaNeural', name: 'Aria', desc: '标准自然女声 (英文)', lang: 'en', gender: 'Female' },
];

const DEFAULT_VOICE_ZH = 'zh-CN-XiaoyiNeural';
const DEFAULT_VOICE_EN = 'en-US-AnaNeural';
const MAX_CACHE_ITEMS = 20; // 严格限制缓存数量，占用极小内存 (< 400KB)
const SEGMENT_MAX_CHARS = 100; // per-segment cap for queued synthesis

/* --- Helpers -------------------------------------------------------------- */

/* Long texts must be spoken as a queue of short segments: one oversized
   request is slow to synthesize (trips the timeout) and comes back cut
   short. Sentences are split at strong enders (a '.' only at a word
   boundary, so decimals survive), greedily merged up to maxLen, and
   punctuation-free marathons are force-split at commas, then anywhere. */

const SENTENCE_ENDERS = '。！？!?…；;';

function splitSentences(raw) {
  const res = [];
  let buf = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    buf += ch;
    const dotBoundary = ch === '.' && (i + 1 >= raw.length || raw[i + 1] === ' ');
    if (SENTENCE_ENDERS.includes(ch) || dotBoundary) {
      res.push(buf);
      buf = '';
    }
  }
  if (buf) res.push(buf);
  return res;
}

function hardSplit(sentence, maxLen) {
  const parts = [];
  let buf = '';
  for (const clause of sentence.match(/[^，、,:：]*[，、,:：]+|[^，、,:：]+/g) || []) {
    let piece = clause;
    if (buf && buf.length + piece.length > maxLen) {
      parts.push(buf);
      buf = '';
    }
    while (buf.length + piece.length > maxLen) { // no separator in sight
      if (buf) { parts.push(buf); buf = ''; }
      parts.push(piece.slice(0, maxLen));
      piece = piece.slice(maxLen);
    }
    buf += piece;
  }
  if (buf) parts.push(buf);
  return parts;
}

function splitSegments(text, maxLen = SEGMENT_MAX_CHARS) {
  const cap = Math.max(10, maxLen | 0);
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const segments = [];
  let buf = '';
  const flush = () => {
    const s = buf.trim();
    if (s) segments.push(s);
    buf = '';
  };
  for (const sentence of splitSentences(raw)) {
    if (sentence.length > cap) {
      flush();
      for (const part of hardSplit(sentence, cap)) {
        const p = part.trim();
        if (p) segments.push(p);
      }
      continue;
    }
    if (buf && buf.length + sentence.length > cap) flush();
    buf += sentence;
  }
  flush();
  return segments;
}

function formatRate(rate) {
  if (typeof rate === 'number') {
    const sign = rate >= 0 ? '+' : '';
    return `${sign}${Math.round(rate)}%`;
  }
  if (typeof rate === 'string' && rate.trim()) {
    const s = rate.trim();
    return s.endsWith('%') ? s : `${s}%`;
  }
  return '+0%';
}

function formatPitch(pitch) {
  if (typeof pitch === 'number') {
    const sign = pitch >= 0 ? '+' : '';
    return `${sign}${Math.round(pitch)}Hz`;
  }
  if (typeof pitch === 'string' && pitch.trim()) {
    const s = pitch.trim();
    return s.endsWith('Hz') ? s : `${s}Hz`;
  }
  return '+0Hz';
}

function normalizeKey(text, voice, rate, pitch) {
  return `${voice || ''}|${formatRate(rate)}|${formatPitch(pitch)}|${String(text || '').trim()}`;
}

/* --- Service Class -------------------------------------------------------- */

/* The service refuses a voice reading text in another script (it returns
   NO_AUDIO for e.g. en-US voices handed Chinese) — a hard, deterministic
   failure users hit by previewing an English voice against Chinese chatter.
   Correct it up front instead of failing. CJK-free text is fine in any
   voice (zh voices read English), so only one direction needs the fix. */
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const TRANSIENT_RE = /timed?\s?out|timeout|handshake|econn|socket|429|503|temporarily|network|unable to synthesize/i;

function voiceMismatch(text, voice) {
  return CJK_RE.test(text) && !/^(zh|ja|ko)-/i.test(String(voice || ''));
}

const delay = ms => new Promise(r => setTimeout(r, ms));

class EdgeTTSService {
  constructor(options = {}) {
    this.maxCache = options.maxCache || MAX_CACHE_ITEMS;
    this.defaultVoiceZh = options.defaultVoiceZh || DEFAULT_VOICE_ZH;
    this.defaultVoiceEn = options.defaultVoiceEn || DEFAULT_VOICE_EN;
    this.timeoutMs = options.timeoutMs || 8000;
    this.segmentMaxChars = options.segmentMaxChars || SEGMENT_MAX_CHARS;
    // LRU Map: stores key -> { audioUrl, duration, at }
    this.cache = new Map();
  }

  getPresetVoices() {
    return PRESET_VOICES;
  }

  getDefaultVoice(lang = 'zh') {
    return lang === 'en' ? this.defaultVoiceEn : this.defaultVoiceZh;
  }

  /* Get cached item and refresh its position in LRU */
  getFromCache(key) {
    if (!this.cache.has(key)) return null;
    const item = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, item); // re-insert as most recently used
    return item;
  }

  /* Put item in LRU cache, evicting oldest if capacity reached */
  putInCache(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxCache) {
      // Evict oldest (first key in map iterator)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  clearCache() {
    this.cache.clear();
  }

  getCacheSize() {
    return this.cache.size;
  }

  /**
   * One raw synthesis attempt (own EdgeTTS instance: a failed socket must
   * not be reused). Never retries by itself.
   */
  async attemptOnce(rawText, selectedVoice, formattedRate, formattedPitch, timeout) {
    const tts = new EdgeTTS({ timeout });
    let timeoutTimer = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => {
        reject(new Error(`TTS synthesis timed out after ${timeout}ms`));
      }, timeout);
    });
    try {
      const synthPromise = tts.generate(rawText, selectedVoice, {
        rate: formattedRate,
        pitch: formattedPitch,
      });
      const res = await Promise.race([synthPromise, timeoutPromise]);
      clearTimeout(timeoutTimer);
      if (!res || !res.audio || res.audio.length === 0) {
        return { ok: false, error: 'Received empty audio', fallback: true };
      }
      const base64 = res.audio.toString('base64');
      return {
        ok: true,
        audioUrl: `data:audio/mp3;base64,${base64}`,
        duration: typeof res.duration === 'number' ? res.duration : 0,
      };
    } catch (err) {
      clearTimeout(timeoutTimer);
      return {
        ok: false,
        error: err && err.message ? err.message : String(err),
        fallback: true,
      };
    }
  }

  /**
   * Synthesize text into an audio Data URL (MP3 base64).
   *
   * A voice that cannot read the text's script is silently corrected to the
   * zh default (the service hard-fails that combination with NO_AUDIO), and
   * one transient-looking failure (timeout / handshake / 429-ish) is retried
   * once with a short backoff.
   *
   * @param {Object} params
   * @param {string} params.text - The sentence to read
   * @param {string} [params.voice] - Edge voice ID, e.g. 'zh-CN-XiaoyiNeural'
   * @param {number|string} [params.rate] - Speed rate, e.g. 0 or '+0%'
   * @param {number|string} [params.pitch] - Pitch, e.g. 0 or '+0Hz'
   * @param {string} [params.lang] - 'zh' | 'en' (used for default voice picking)
   * @param {number} [params.timeoutMs] - Request timeout
   * @returns {Promise<Object>} Synthesis result
   */
  async synthesize({ text, voice, rate = '+0%', pitch = '+0Hz', lang = 'zh', timeoutMs } = {}) {
    const rawText = typeof text === 'string' ? text.trim() : '';
    if (!rawText) {
      return { ok: false, error: 'Text is empty', fallback: false };
    }

    const adjusted = voiceMismatch(rawText, voice || this.getDefaultVoice(lang));
    const selectedVoice = adjusted ? this.getDefaultVoice('zh') : (voice || this.getDefaultVoice(lang));
    const formattedRate = formatRate(rate);
    const formattedPitch = formatPitch(pitch);
    const key = normalizeKey(rawText, selectedVoice, formattedRate, formattedPitch);
    const tags = adjusted ? { voiceAdjusted: true } : {};

    // 1. Check memory LRU cache
    const cached = this.getFromCache(key);
    if (cached) {
      return {
        ok: true,
        cached: true,
        audioUrl: cached.audioUrl,
        duration: cached.duration,
        format: 'mp3',
        text: rawText,
        voice: selectedVoice,
        ...tags,
      };
    }

    // 2. Synthesize (one transient retry), then 3. cache
    const timeout = timeoutMs || this.timeoutMs;
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await this.attemptOnce(rawText, selectedVoice, formattedRate, formattedPitch, timeout);
      if (res.ok || attempt >= 1 || !TRANSIENT_RE.test(res.error || '')) break;
      await delay(400 + Math.random() * 300);
    }
    if (!res.ok) {
      return { ...res, text: rawText, voice: selectedVoice, ...tags };
    }

    this.putInCache(key, { audioUrl: res.audioUrl, duration: res.duration, at: Date.now() });
    return {
      ok: true,
      cached: false,
      audioUrl: res.audioUrl,
      duration: res.duration,
      format: 'mp3',
      text: rawText,
      voice: selectedVoice,
      ...tags,
    };
  }

  /**
   * Synthesize long text as an ordered queue of short segments.
   *
   * Text is split on sentence punctuation (force-split when a stretch has
   * none), each segment synthesized independently (own timeout + cache
   * entry), so a long speech neither times out nor comes back truncated.
   * Callers get `segments: [{ text, audioUrl, duration }]` to play back to
   * back; `audioUrl` stays the first segment for single-shot consumers.
   *
   * @param {Object} params - Same shape as synthesize()
   * @returns {Promise<Object>} `{ ok, segments, audioUrl, duration, ... }`
   */
  async synthesizeQueued(params = {}) {
    const segments = splitSegments(params.text, this.segmentMaxChars);
    if (segments.length === 0) {
      return { ok: false, error: 'Text is empty', fallback: false };
    }
    if (segments.length === 1) {
      const res = await this.synthesize({ ...params, text: segments[0] });
      if (!res || !res.ok) return res;
      return {
        ...res,
        segments: [{ text: res.text, audioUrl: res.audioUrl, duration: res.duration }],
      };
    }
    const results = await Promise.all(segments.map(text => this.synthesize({ ...params, text })));
    const failed = results.find(r => !r || !r.ok);
    if (failed) {
      return {
        ok: false,
        error: (failed && failed.error) || 'segment synthesis failed',
        fallback: true,
        text: String(params.text || '').trim(),
      };
    }
    return {
      ok: true,
      cached: results.every(r => r.cached),
      segments: results.map(r => ({ text: r.text, audioUrl: r.audioUrl, duration: r.duration })),
      audioUrl: results[0].audioUrl,
      duration: results.reduce((sum, r) => sum + (r.duration || 0), 0),
      format: 'mp3',
      text: String(params.text || '').trim(),
      voice: results[0].voice,
    };
  }
}

const defaultInstance = new EdgeTTSService();

module.exports = {
  EdgeTTSService,
  ttsService: defaultInstance,
  PRESET_VOICES,
  DEFAULT_VOICE_ZH,
  DEFAULT_VOICE_EN,
  MAX_CACHE_ITEMS,
  SEGMENT_MAX_CHARS,
  splitSegments,
  formatRate,
  formatPitch,
};
