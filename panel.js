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
              <span class="dpet-hint">${t('用系统声音念出气泡', 'System voice speaks bubbles')}</span>
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
        bubble: $('.dpet-bubble'), voice: $('.dpet-voice'),
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
      els.voice.addEventListener('change', () => { call('setPrefs', { voiceOn: els.voice.checked }); });
      els.quip.addEventListener('click', async () => {
        const res = await call('quip');
        const d = res && res.ok ? res.data : { ok: false, error: res && res.error };
        els.quipResult.textContent = d.ok ? `“${d.text}”` : `⚠ ${d.error || ''}`;
      });
      els.reset.addEventListener('click', () => { call('resetPosition'); });
      els.reset.textContent = LABELS.resetPos();

      const offEvent = window.host.onPluginEvent('desktop-pet', ({ channel, payload }) => {
        if (channel === 'state') { state = payload; render(); }
      });

      /* --- boot ---------------------------------------------------------------- */
      (async () => {
        call('setPrefs', { lang: window.I18N.lang }); // quip pool + voice language follow the UI
        const res = await call('getState');
        state = res && res.ok ? res.data : null;
        if (!state || !state.packs || !state.packs.length) {
          root.innerHTML = `<div class="dpet-empty">${LABELS.packsEmpty()}</div>`;
          return;
        }
        render();
      })();

      return {
        unmount() { offEvent && offEvent(); },
      };
    },
  });
})();
