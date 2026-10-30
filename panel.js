/* desktop-pet panel — settings surface: show/hide, size, pack selection,
   auto-walk toggle, position reset. All colours flow through the host
   light-dark() tokens; state arrives via plugin-event broadcasts. */
(function () {
  'use strict';

  const L = () => (window.I18N && window.I18N.lang) === 'en';
  const t = (zh, en) => (L() ? en : zh);

  const LABELS = {
    visible: () => t('宠物在场', 'Pet on screen'),
    hidden: () => t('宠物休息中', 'Pet resting'),
    showBtn: () => t('显示', 'Show'),
    hideBtn: () => t('隐藏', 'Hide'),
    size: () => t('大小', 'Size'),
    pack: () => t('宠物包', 'Pet pack'),
    autoWalk: () => t('自动溜达', 'Auto wander'),
    autoWalkHint: () => t('空闲时偶尔在屏幕底边散步', 'Occasionally strolls along the screen floor when idle'),
    resetPos: () => t('回到默认位置', 'Reset position'),
    nowPlaying: () => t('当前动作', 'Now playing'),
    resting: () => t('（休息中）', '(resting)'),
    pos: () => t('位置', 'Position'),
    credit: () => t('素材', 'Assets'),
    packsEmpty: () => t('未找到宠物包（pets/ 目录为空）', 'No pet packs found (pets/ is empty)'),
  };

  window.Toolbox.panel({
    mount(root) {
      // keep the host's panel-view base class (shared rules key off it)
      root.classList.add('dpet-root');
      let state = null;

      /* --- markup ---------------------------------------------------------- */
      root.innerHTML = `
        <div class="dpet-main">
          <div class="dpet-hero">
            <div class="dpet-hero-art"></div>
            <div class="dpet-hero-body">
              <div class="dpet-hero-name"></div>
              <div class="dpet-hero-status"></div>
            </div>
            <button type="button" class="dpet-toggle btn small"></button>
          </div>

          <section class="dpet-group">
            <label class="dpet-row">
              <span class="dpet-row-label">${LABELS.size()}</span>
              <input class="dpet-size" type="range" min="120" max="480" step="10" />
              <b class="dpet-size-val"></b>
            </label>
            <label class="dpet-row">
              <span class="dpet-row-label">${LABELS.pack()}</span>
              <select class="dpet-pack input"></select>
            </label>
            <label class="dpet-row dpet-check">
              <input class="dpet-walk" type="checkbox" />
              <span class="dpet-row-label">${LABELS.autoWalk()}</span>
              <span class="dpet-hint">${LABELS.autoWalkHint()}</span>
            </label>
            <label class="dpet-row dpet-check">
              <input class="dpet-bubble" type="checkbox" />
              <span class="dpet-row-label">${t('气泡碎碎念', 'Chatter bubble')}</span>
              <span class="dpet-hint">${t('空闲时冒一句话', 'Occasional spoken bubbles')}</span>
            </label>
            <label class="dpet-row dpet-check">
              <input class="dpet-voice" type="checkbox" />
              <span class="dpet-row-label">${t('语音朗读', 'Read aloud')}</span>
              <span class="dpet-hint">${t('气泡同步语音播报', 'Speak bubbles with voice')}</span>
            </label>
            <div class="dpet-voice-opts" style="display:none;">
              <label class="dpet-row">
                <span class="dpet-row-label">${t('语音引擎', 'Engine')}</span>
                <select class="dpet-voice-engine input small">
                  <option value="edge-tts">${t('Edge 神经网络语音 (高清)', 'Edge Neural TTS (HD)')}</option>
                  <option value="system">${t('系统本地语音', 'System local voice')}</option>
                </select>
              </label>
              <div class="dpet-edge-opts">
                <label class="dpet-row">
                  <span class="dpet-row-label">${t('宠物音色', 'Voice')}</span>
                  <select class="dpet-voice-select input small"></select>
                </label>
                <label class="dpet-row">
                  <span class="dpet-row-label">${t('语速调节', 'Speed')}</span>
                  <input class="dpet-voice-rate" type="range" min="-30" max="30" step="5" />
                  <b class="dpet-voice-rate-val"></b>
                </label>
                <label class="dpet-row">
                  <span class="dpet-row-label">${t('音调微调', 'Pitch')}</span>
                  <input class="dpet-voice-pitch" type="range" min="0" max="40" step="5" />
                  <b class="dpet-voice-pitch-val"></b>
                </label>
              </div>
              <div class="dpet-row">
                <button type="button" class="dpet-voice-preview btn ghost small">${t('试听声音', 'Preview voice')}</button>
                <span class="dpet-preview-status"></span>
              </div>
            </div>
            <label class="dpet-row dpet-check">
              <input class="dpet-wf" type="checkbox" />
              <span class="dpet-row-label">${t('工作流联动', 'Workflow reactions')}</span>
              <span class="dpet-hint">${t('运行时打工、成功庆祝、失败难过', 'Working / celebrate / error on workflow runs')}</span>
            </label>
            <div class="dpet-row">
              <button type="button" class="dpet-quip btn ghost small">${t('说一句', 'Say something')}</button>
              <span class="dpet-quip-result"></span>
            </div>
            <div class="dpet-row">
              <button type="button" class="dpet-reset btn ghost small"></button>
            </div>
          </section>

          <section class="dpet-group dpet-info">
            <div class="dpet-line dpet-anim"></div>
            <div class="dpet-line dpet-credit"></div>
            <div class="dpet-line dpet-derived"></div>
          </section>
        </div>`;

      const $ = cls => root.querySelector(cls);
      const els = {
        art: $('.dpet-hero-art'), name: $('.dpet-hero-name'), status: $('.dpet-hero-status'),
        toggle: $('.dpet-toggle'), size: $('.dpet-size'), sizeVal: $('.dpet-size-val'),
        pack: $('.dpet-pack'), walk: $('.dpet-walk'), reset: $('.dpet-reset'),
        bubble: $('.dpet-bubble'), voice: $('.dpet-voice'), wf: $('.dpet-wf'),
        voiceOpts: $('.dpet-voice-opts'), voiceEngine: $('.dpet-voice-engine'),
        edgeOpts: $('.dpet-edge-opts'), voiceSelect: $('.dpet-voice-select'),
        voiceRate: $('.dpet-voice-rate'), voiceRateVal: $('.dpet-voice-rate-val'),
        voicePitch: $('.dpet-voice-pitch'), voicePitchVal: $('.dpet-voice-pitch-val'),
        voicePreview: $('.dpet-voice-preview'), previewStatus: $('.dpet-preview-status'),
        quip: $('.dpet-quip'), quipResult: $('.dpet-quip-result'),
        anim: $('.dpet-anim'), credit: $('.dpet-credit'), derived: $('.dpet-derived'),
      };

      const call = (method, args) => window.host.pluginCall('desktop-pet', method, args);
      let sizeCommitted = null;

      const render = () => {
        if (!state) return;
        const { pack, prefs, visible, status } = state;
        els.name.textContent = (pack.name && (L() ? pack.name.en : pack.name.zh)) || pack.id;
        els.status.textContent = visible
          ? `${LABELS.nowPlaying()}: ${status && status.anim ? status.anim : '…'}`
          : LABELS.resting();
        els.toggle.textContent = visible ? LABELS.hideBtn() : LABELS.showBtn();
        els.art.style.backgroundImage = 'url(plugin://desktop-pet/icon.svg)';

        if (els.size.value !== String(prefs.size)) els.size.value = prefs.size;
        els.sizeVal.textContent = `${prefs.size}px`;

        const cur = els.pack.value;
        const options = state.packs.map(p => {
          const name = p.name && (L() ? p.name.en : p.name.zh) || p.id;
          return `<option value="${p.id}">${name}</option>`;
        }).join('');
        if (els.pack.innerHTML !== options) els.pack.innerHTML = options;
        els.pack.value = pack.id;
        if (els.pack.value !== pack.id && cur) els.pack.value = cur;
        if (els.pack.selectedOptions[0]) els.pack.selectedOptions[0].selected = true;

        els.walk.checked = !!prefs.autoWalk;
        els.bubble.checked = !!prefs.bubbleOn;
        els.voice.checked = !!prefs.voiceOn;
        els.wf.checked = prefs.wfOn !== false;

        els.voiceOpts.style.display = prefs.voiceOn ? 'flex' : 'none';
        els.voiceEngine.value = prefs.voiceEngine || 'edge-tts';
        els.edgeOpts.style.display = (prefs.voiceEngine === 'system') ? 'none' : 'flex';
        els.voicePreview.style.display = (prefs.voiceEngine === 'system') ? 'none' : 'inline-flex';

        if (state.voices && state.voices.length) {
          const vOpts = state.voices.map(v => {
            const label = L() ? `${v.name} (${v.lang})` : `${v.name} · ${v.desc}`;
            return `<option value="${v.id}">${label}</option>`;
          }).join('');
          if (els.voiceSelect.innerHTML !== vOpts) els.voiceSelect.innerHTML = vOpts;
          els.voiceSelect.value = prefs.voice || state.voices[0].id;
        }

        const curRate = Number.isFinite(prefs.voiceRate) ? prefs.voiceRate : 0;
        els.voiceRate.value = String(curRate);
        els.voiceRateVal.textContent = (curRate >= 0 ? `+${curRate}%` : `${curRate}%`);

        const curPitch = Number.isFinite(prefs.voicePitch) ? prefs.voicePitch : 0;
        els.voicePitch.value = String(curPitch);
        els.voicePitchVal.textContent = `+${curPitch}Hz`;

        if (status && Number.isFinite(status.x)) {
          els.anim.textContent = `${LABELS.pos()}: ${status.x}, ${status.y}`;
        } else {
          els.anim.textContent = '';
        }
        const credit = pack.credit && (L() ? pack.credit.en : pack.credit.zh);
        els.credit.textContent = credit ? `${LABELS.credit()}: ${credit}` : '';
        els.derived.textContent = t(
          '窗口/播放技术源自 dsh-pet（MIT）',
          'Window & playback techniques adopted from dsh-pet (MIT)',
        );
      };

      /* --- events ------------------------------------------------------------ */
      els.toggle.addEventListener('click', async () => {
        const res = await call('toggle');
        if (res && res.ok && res.data) { state = { ...state, visible: res.data.visible }; render(); }
      });
      els.size.addEventListener('input', () => { els.sizeVal.textContent = `${els.size.value}px`; });
      els.size.addEventListener('change', () => { call('setPrefs', { size: Number(els.size.value) }); });
      els.pack.addEventListener('change', () => { call('setPrefs', { pack: els.pack.value }); });
      els.walk.addEventListener('change', () => { call('setPrefs', { autoWalk: els.walk.checked }); });
      els.bubble.addEventListener('change', () => { call('setPrefs', { bubbleOn: els.bubble.checked }); });
      let previewAudio = null;
      els.voice.addEventListener('change', () => {
        call('setPrefs', { voiceOn: els.voice.checked });
        els.voiceOpts.style.display = els.voice.checked ? 'flex' : 'none';
      });
      els.voiceEngine.addEventListener('change', () => {
        call('setPrefs', { voiceEngine: els.voiceEngine.value });
        els.edgeOpts.style.display = (els.voiceEngine.value === 'system') ? 'none' : 'flex';
        els.voicePreview.style.display = (els.voiceEngine.value === 'system') ? 'none' : 'inline-flex';
      });
      els.voiceSelect.addEventListener('change', () => {
        call('setPrefs', { voice: els.voiceSelect.value });
      });
      els.voiceRate.addEventListener('input', () => {
        const v = Number(els.voiceRate.value);
        els.voiceRateVal.textContent = (v >= 0 ? `+${v}%` : `${v}%`);
      });
      els.voiceRate.addEventListener('change', () => {
        call('setPrefs', { voiceRate: Number(els.voiceRate.value) });
      });
      els.voicePitch.addEventListener('input', () => {
        els.voicePitchVal.textContent = `+${els.voicePitch.value}Hz`;
      });
      els.voicePitch.addEventListener('change', () => {
        call('setPrefs', { voicePitch: Number(els.voicePitch.value) });
      });
      els.voicePreview.addEventListener('click', async () => {
        if (previewAudio) {
          try { previewAudio.pause(); } catch { /* ignore */ }
          previewAudio = null;
        }
        els.previewStatus.textContent = t('正在合成…', 'Synthesizing…');
        const res = await call('previewVoice', {
          voice: els.voiceSelect.value,
          rate: Number(els.voiceRate.value),
          pitch: Number(els.voicePitch.value),
          lang: window.I18N && window.I18N.lang,
        });
        const d = res && res.ok ? res.data : null;
        if (d && d.ok && d.audioUrl) {
          els.previewStatus.textContent = t('正在播放…', 'Playing…');
          previewAudio = new Audio(d.audioUrl);
          previewAudio.onended = () => {
            els.previewStatus.textContent = t('✓ 试听完成', '✓ Finished');
            setTimeout(() => { if (els.previewStatus.textContent.includes('✓')) els.previewStatus.textContent = ''; }, 2500);
          };
          previewAudio.onerror = () => {
            els.previewStatus.textContent = t('⚠ 播放失败', '⚠ Play failed');
          };
          previewAudio.play().catch(() => {
            els.previewStatus.textContent = t('⚠ 播放失败', '⚠ Play failed');
          });
        } else {
          els.previewStatus.textContent = t(`⚠ 失败: ${d && d.error || ''}`, `⚠ Failed: ${d && d.error || ''}`);
        }
      });
      els.wf.addEventListener('change', () => { call('setPrefs', { wfOn: els.wf.checked }); });
      els.quip.addEventListener('click', async () => {
        const res = await call('quip');
        const d = res && res.ok ? res.data : { ok: false, error: res && res.error };
        els.quipResult.textContent = d.ok ? `“${d.text}”` : `⚠ ${d.error || ''}`;
      });
      els.reset.addEventListener('click', () => { call('resetPosition'); });
      els.reset.textContent = LABELS.resetPos();

      const offEvent = window.host.onPluginEvent('desktop-pet', ({ channel, payload }) => {
        if (channel === 'state') {
          const oldVoices = state && state.voices;
          state = payload;
          if (oldVoices && !state.voices) state.voices = oldVoices;
          render();
        }
      });

      /* --- boot ---------------------------------------------------------------- */
      (async () => {
        call('setPrefs', { lang: window.I18N.lang }); // quip pool + voice language follow the UI
        const [res, vRes] = await Promise.all([call('getState'), call('getVoices')]);
        state = res && res.ok ? res.data : null;
        if (state && vRes && vRes.ok && vRes.data && vRes.data.voices) {
          state.voices = vRes.data.voices;
        }
        if (!state || !state.packs || !state.packs.length) {
          root.innerHTML = `<div class="dpet-empty">${LABELS.packsEmpty()}</div>`;
          return;
        }
        render();
      })();

      return {
        unmount() {
          if (previewAudio) { try { previewAudio.pause(); } catch { /* ignore */ } previewAudio = null; }
          offEvent && offEvent();
        },
      };
    },
  });
})();
