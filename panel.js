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
            <div class="dpet-library dpet-hidden">
              <div class="dpet-row">
                <span class="dpet-row-label">${t('模型库', 'Model library')}</span>
                <span class="dpet-hint">${t('把含 .model3.json 的模型文件夹放进库里，自动成为宠物包', 'Drop folders with a .model3.json in — they become pet packs automatically')}</span>
              </div>
              <div class="dpet-dirs"></div>
              <div class="dpet-row dpet-lib-btns">
                <button type="button" class="dpet-lib-open btn ghost small">${t('打开模型库…', 'Open library…')}</button>
                <button type="button" class="dpet-lib-add btn ghost small">${t('添加模型目录…', 'Add model dir…')}</button>
              </div>
            </div>
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
              <div class="dpet-system-hint" style="display:none;">${t('使用系统默认合成引擎，离线可用', 'Uses OS default speech engine, works offline')}</div>
              <div class="dpet-edge-opts">
                <label class="dpet-row">
                  <span class="dpet-row-label">${t('宠物音色', 'Voice')}</span>
                  <select class="dpet-voice-select input small"></select>
                </label>
                <label class="dpet-row">
                  <span class="dpet-row-label">${t('音调微调', 'Pitch')}</span>
                  <input class="dpet-voice-pitch" type="range" min="0" max="40" step="5" />
                  <b class="dpet-voice-pitch-val"></b>
                </label>
              </div>
              <label class="dpet-row">
                <span class="dpet-row-label">${t('语速调节', 'Speed')}</span>
                <input class="dpet-voice-rate" type="range" min="-30" max="30" step="5" />
                <b class="dpet-voice-rate-val"></b>
              </label>
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
            <label class="dpet-row dpet-check">
              <input class="dpet-tasks" type="checkbox" />
              <span class="dpet-row-label">${t('待办挂牌', 'Todo badge')}</span>
              <span class="dpet-hint">${t('镜向备忘录未勾任务，点头条开备忘', 'Mirrors open memo tasks; click the badge to open Memo')}</span>
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
        library: $('.dpet-library'), dirs: $('.dpet-dirs'), libOpen: $('.dpet-lib-open'), libAdd: $('.dpet-lib-add'),
        bubble: $('.dpet-bubble'), voice: $('.dpet-voice'), wf: $('.dpet-wf'),
        tasks: $('.dpet-tasks'),
        voiceOpts: $('.dpet-voice-opts'), voiceEngine: $('.dpet-voice-engine'),
        systemHint: $('.dpet-system-hint'),
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
          ? `${LABELS.nowPlaying()}: ${status && status.anim ? status.anim : '…'}${state.tasks ? ` · ${t('待办', 'todos')} ${state.tasks}` : ''}`
          : LABELS.resting();
        els.toggle.textContent = visible ? LABELS.hideBtn() : LABELS.showBtn();
        els.art.style.backgroundImage = 'url(plugin://desktop-pet/icon.svg)';

        if (els.size.value !== String(prefs.size)) els.size.value = prefs.size;
        els.sizeVal.textContent = `${prefs.size}px`;

        const cur = els.pack.value;
        const options = state.packs.map(p => {
          const name = p.name && (L() ? p.name.en : p.name.zh) || p.id;
          const flag = p.engine === 'live2d' ? (p.needsModel ? ` (${t('未发现模型', 'no model')})` : p.auto ? ` (${t('自动发现', 'auto')})` : ' (Live2D)') : '';
          return `<option value="${p.id}">${name}${flag}</option>`;
        }).join('');
        if (els.pack.innerHTML !== options) els.pack.innerHTML = options;
        els.pack.value = pack.id;
        if (els.pack.value !== pack.id && cur) els.pack.value = cur;
        if (els.pack.selectedOptions[0]) els.pack.selectedOptions[0].selected = true;

        const hasLive2d = (state.packs || []).some(p => p.engine === 'live2d');
        els.library.classList.toggle('dpet-hidden', !hasLive2d);
        els.dirs.innerHTML = (state.modelDirs || []).map((d, i) => {
          const isLib = d === state.modelLibrary;
          const tag = isLib ? `<span class="dpet-dir-tag">${t('默认库', 'default')}</span>` : '';
          const rm = isLib ? '' : `<button type="button" class="dpet-dir-x btn ghost small" data-i="${i}" title="${t('移除该目录', 'Remove this dir')}">✕</button>`;
          return `<div class="dpet-dir"><code title="${d.replace(/"/g, '&quot;')}">${d}</code>${tag}${rm}</div>`;
        }).join('');
        els.dirs.querySelectorAll('.dpet-dir-x').forEach(btn => btn.addEventListener('click', async () => {
          const next = (state.modelDirs || []).slice();
          next.splice(Number(btn.dataset.i), 1);
          await call('setPrefs', { modelDirs: next });
          const st2 = await call('getState');
          if (st2 && st2.ok) { state = st2.data; render(); }
        }));

        els.walk.checked = !!prefs.autoWalk;
        els.bubble.checked = !!prefs.bubbleOn;
        els.voice.checked = !!prefs.voiceOn;
        els.wf.checked = prefs.wfOn !== false;
        els.tasks.checked = prefs.tasksOn !== false;

        els.voiceOpts.style.display = prefs.voiceOn ? 'flex' : 'none';
        els.voiceEngine.value = prefs.voiceEngine || 'edge-tts';
        const isSystem = (prefs.voiceEngine === 'system');
        els.edgeOpts.style.display = isSystem ? 'none' : 'flex';
        if (els.systemHint) els.systemHint.style.display = isSystem ? 'block' : 'none';
        els.voicePreview.style.display = 'inline-flex';

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
      els.pack.addEventListener('change', async () => {
        const res = await call('setPrefs', { pack: els.pack.value });
        const d = res && res.ok ? res.data : null;
        if (d && d.packError && els.quipResult) els.quipResult.textContent = `⚠ ${d.packError}`;
      });
      els.libOpen.addEventListener('click', () => { call('openModelLibrary'); });
      els.libAdd.addEventListener('click', async () => {
        const pick = await call('chooseModelDir');
        const dir = pick && pick.ok && pick.data && pick.data.dir;
        if (!dir) return;
        await call('setPrefs', { addModelDir: dir });
        const st = await call('getState');
        if (st && st.ok) { state = st.data; render(); }
      });
      els.pack.addEventListener('change', async () => {
        const res = await call('setPrefs', { pack: els.pack.value });
        const d = res && res.ok ? res.data : null;
        if (d && d.packError && els.quipResult) els.quipResult.textContent = `⚠ ${d.packError}`;
      });
      els.model.addEventListener('click', async () => {
        const pick = await call('chooseModelDir');
        const dir = pick && pick.ok && pick.data && pick.data.dir;
        if (!dir) return;
        const res = await call('setPrefs', { modelDir: dir });
        const d = res && res.ok ? res.data : null;
        if (d && d.packError && els.quipResult) els.quipResult.textContent = `⚠ ${d.packError}`;
        const st = await call('getState');
        if (st && st.ok) { state = st.data; render(); }
      });
      els.modelUnbind.addEventListener('click', async () => {
        await call('setPrefs', { modelDir: null });
        const st = await call('getState');
        if (st && st.ok) { state = st.data; render(); }
      });
      els.walk.addEventListener('change', () => { call('setPrefs', { autoWalk: els.walk.checked }); });
      els.bubble.addEventListener('change', () => { call('setPrefs', { bubbleOn: els.bubble.checked }); });
      let previewAudio = null;
      let previewTimer = null;
      let previewState = 'idle'; // 'idle' | 'loading' | 'playing' | 'failed'

      function stopPreview() {
        clearTimeout(previewTimer);
        previewTimer = null;
        if (previewAudio) {
          try { previewAudio.pause(); previewAudio.currentTime = 0; } catch { /* ignore */ }
          previewAudio = null;
        }
        if ('speechSynthesis' in window) {
          try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
        }
      }

      function setPreviewState(st, detail) {
        previewState = st;
        if (st === 'idle') {
          els.voicePreview.textContent = t('试听声音', 'Preview voice');
          els.voicePreview.disabled = false;
        } else if (st === 'loading') {
          els.voicePreview.textContent = t('正在生成…', 'Generating…');
          els.voicePreview.disabled = false;
          if (detail) els.previewStatus.textContent = detail;
        } else if (st === 'playing') {
          els.voicePreview.textContent = t('停止试听', 'Stop preview');
          els.voicePreview.disabled = false;
          if (detail) els.previewStatus.textContent = detail;
        } else if (st === 'failed') {
          els.voicePreview.textContent = t('重试试听', 'Retry preview');
          els.voicePreview.disabled = false;
          if (detail) els.previewStatus.textContent = detail;
        }
      }

      els.voice.addEventListener('change', () => {
        stopPreview();
        setPreviewState('idle');
        els.previewStatus.textContent = '';
        call('setPrefs', { voiceOn: els.voice.checked });
        els.voiceOpts.style.display = els.voice.checked ? 'flex' : 'none';
      });
      els.voiceEngine.addEventListener('change', () => {
        stopPreview();
        setPreviewState('idle');
        els.previewStatus.textContent = '';
        call('setPrefs', { voiceEngine: els.voiceEngine.value });
        const isSystem = (els.voiceEngine.value === 'system');
        els.edgeOpts.style.display = isSystem ? 'none' : 'flex';
        if (els.systemHint) els.systemHint.style.display = isSystem ? 'block' : 'none';
        els.voicePreview.style.display = 'inline-flex';
      });
      els.voiceSelect.addEventListener('change', () => {
        stopPreview();
        setPreviewState('idle');
        els.previewStatus.textContent = '';
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
        if (previewState === 'playing') {
          stopPreview();
          setPreviewState('idle');
          els.previewStatus.textContent = '';
          return;
        }

        stopPreview();
        const engine = els.voiceEngine.value;

        // 系统本地语音试听
        if (engine === 'system') {
          if (!('speechSynthesis' in window)) {
            setPreviewState('failed', t('⚠ 当前环境不支持系统本地语音，点击重试', '⚠ Local speech unsupported, click to retry'));
            return;
          }
          const isEn = (window.I18N && window.I18N.lang === 'en');
          const sampleText = isEn
            ? 'Hello! This is a preview of the system local voice.'
            : '你好呀，我是小轨桌宠，这是系统本地语音试听效果。';
          const u = new SpeechSynthesisUtterance(sampleText);
          u.lang = isEn ? 'en-US' : 'zh-CN';
          const rateVal = Number(els.voiceRate.value) || 0;
          u.rate = Math.max(0.5, Math.min(2.0, 1.0 + (rateVal / 100)));

          setPreviewState('playing', t('正在播放系统语音…', 'Playing system voice…'));

          u.onstart = () => {
            clearTimeout(previewTimer);
            setPreviewState('playing', t('正在播放系统语音…', 'Playing system voice…'));
          };
          u.onend = () => {
            clearTimeout(previewTimer);
            setPreviewState('idle');
            els.previewStatus.textContent = t('✓ 试听完成', '✓ Finished');
            setTimeout(() => { if (els.previewStatus.textContent.includes('✓')) els.previewStatus.textContent = ''; }, 2500);
          };
          u.onerror = () => {
            clearTimeout(previewTimer);
            setPreviewState('failed', t('⚠ 播放失败，点击重试', '⚠ Play failed, click to retry'));
          };

          previewTimer = setTimeout(() => {
            if (previewState === 'playing') {
              stopPreview();
              setPreviewState('failed', t('⚠ 试听超时，点击重试', '⚠ Timeout, click to retry'));
            }
          }, 8000);

          try {
            window.speechSynthesis.speak(u);
          } catch {
            clearTimeout(previewTimer);
            setPreviewState('failed', t('⚠ 启动系统语音失败，点击重试', '⚠ Failed to start voice, click to retry'));
          }
          return;
        }

        // Edge 神经网络语音试听
        setPreviewState('loading', t('正在合成…', 'Synthesizing…'));
        previewTimer = setTimeout(() => {
          if (previewState === 'loading') {
            stopPreview();
            setPreviewState('failed', t('⚠ 合成超时，点击重试', '⚠ Synthesis timeout, click to retry'));
          }
        }, 8000);

        try {
          const res = await call('previewVoice', {
            voice: els.voiceSelect.value,
            rate: Number(els.voiceRate.value),
            pitch: Number(els.voicePitch.value),
            lang: window.I18N && window.I18N.lang,
          });
          clearTimeout(previewTimer);
          const d = res && res.ok ? res.data : null;
          if (!d || !d.ok || !d.audioUrl) {
            const err = (d && d.error) || (res && res.error) || '';
            setPreviewState('failed', t(`⚠ 失败: ${err || '合成错误'}，点击重试`, `⚠ Failed: ${err || 'error'}, click to retry`));
            return;
          }

          setPreviewState('playing', t('正在播放…', 'Playing…'));
          previewAudio = new Audio(d.audioUrl);
          previewAudio.onended = () => {
            previewAudio = null;
            setPreviewState('idle');
            els.previewStatus.textContent = t('✓ 试听完成', '✓ Finished');
            setTimeout(() => { if (els.previewStatus.textContent.includes('✓')) els.previewStatus.textContent = ''; }, 2500);
          };
          previewAudio.onerror = () => {
            previewAudio = null;
            setPreviewState('failed', t('⚠ 播放失败，点击重试', '⚠ Play failed, click to retry'));
          };
          previewAudio.play().catch(() => {
            previewAudio = null;
            setPreviewState('failed', t('⚠ 播放失败，点击重试', '⚠ Play failed, click to retry'));
          });
        } catch (err) {
          clearTimeout(previewTimer);
          setPreviewState('failed', t(`⚠ 异常: ${err.message || ''}，点击重试`, `⚠ Error: ${err.message || ''}, click to retry`));
        }
      });
      els.wf.addEventListener('change', () => { call('setPrefs', { wfOn: els.wf.checked }); });
      els.tasks.addEventListener('change', () => { call('setPrefs', { tasksOn: els.tasks.checked }); });
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
          stopPreview();
          offEvent && offEvent();
        },
      };
    },
  });
})();
