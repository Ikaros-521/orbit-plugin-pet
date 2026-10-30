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

/* --- Helpers -------------------------------------------------------------- */

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

class EdgeTTSService {
  constructor(options = {}) {
    this.maxCache = options.maxCache || MAX_CACHE_ITEMS;
    this.defaultVoiceZh = options.defaultVoiceZh || DEFAULT_VOICE_ZH;
    this.defaultVoiceEn = options.defaultVoiceEn || DEFAULT_VOICE_EN;
    this.timeoutMs = options.timeoutMs || 8000;
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
   * Synthesize text into an audio Data URL (MP3 base64).
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

    const selectedVoice = voice || this.getDefaultVoice(lang);
    const formattedRate = formatRate(rate);
    const formattedPitch = formatPitch(pitch);
    const key = normalizeKey(rawText, selectedVoice, formattedRate, formattedPitch);

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
      };
    }

    // 2. Perform synthesis with EdgeTTS
    const timeout = timeoutMs || this.timeoutMs;
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
        return { ok: false, error: 'Received empty audio', fallback: true, text: rawText };
      }

      const base64 = res.audio.toString('base64');
      const audioUrl = `data:audio/mp3;base64,${base64}`;
      const duration = typeof res.duration === 'number' ? res.duration : 0;

      // 3. Store in LRU cache
      this.putInCache(key, { audioUrl, duration, at: Date.now() });

      return {
        ok: true,
        cached: false,
        audioUrl,
        duration,
        format: 'mp3',
        text: rawText,
        voice: selectedVoice,
      };
    } catch (err) {
      clearTimeout(timeoutTimer);
      const msg = err && err.message ? err.message : String(err);
      return {
        ok: false,
        error: msg,
        fallback: true, // indicates caller can fallback to speechSynthesis
        text: rawText,
        voice: selectedVoice,
      };
    }
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
  formatRate,
  formatPitch,
};
