/* desktop-pet chat window renderer
   Handles conversation history, streaming UI rendering, user input,
   reasoning collapses, and auto-scroll. */

(function () {
  'use strict';

  const messagesList = document.getElementById('messagesList');
  const welcomeBox = document.getElementById('welcomeBox');
  const chatInput = document.getElementById('chatInput');
  const btnSend = document.getElementById('btnSend');
  const btnStop = document.getElementById('btnStop');
  const btnNewTopic = document.getElementById('btnNewTopic');
  const btnSettings = document.getElementById('btnSettings');
  const btnMinimize = document.getElementById('btnMinimize');
  const btnClose = document.getElementById('btnClose');
  const statusBadge = document.getElementById('statusBadge');
  const petName = document.getElementById('petName');
  const petAvatar = document.getElementById('petAvatar');

  let isGenerating = false;
  let activeAssistantMsg = null;
  let activeAssistantEl = null;
  let activeReasoningText = '';
  let activeContentText = '';

  // Safe HTML escaper
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  // Lightweight Markdown renderer for messages
  function renderMarkdown(raw) {
    if (!raw) return '';
    let text = escapeHtml(raw);

    // Code blocks: ```lang\ncode\n```
    text = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
      return `<pre><code>${code.trim()}</code></pre>`;
    });

    // Inline code: `code`
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold: **bold**
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Paragraphs / linebreaks
    const parts = text.split(/\n{2,}/);
    return parts.map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`).join('');
  }

  function scrollToBottom(force = false) {
    if (!messagesList) return;
    const isNearBottom = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 80;
    if (force || isNearBottom) {
      messagesList.scrollTop = messagesList.scrollHeight;
    }
  }

  function setGeneratingState(generating) {
    isGenerating = !!generating;
    if (isGenerating) {
      statusBadge.textContent = '思考中…';
      statusBadge.className = 'pet-badge thinking';
      btnSend.classList.add('hidden');
      btnStop.classList.remove('hidden');
    } else {
      statusBadge.textContent = '就绪';
      statusBadge.className = 'pet-badge ready';
      btnSend.classList.remove('hidden');
      btnStop.classList.add('hidden');
    }
  }

  function renderMessageItem(msg) {
    const row = document.createElement('div');
    row.className = `msg-row ${msg.role === 'user' ? 'user' : 'assistant'}`;

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (msg.role === 'assistant') {
      // If there's reasoning content, show compact expandable reasoning capsule
      if (msg.reasoning && msg.reasoning.trim()) {
        const rCard = document.createElement('div');
        rCard.className = 'reasoning-card collapsed';
        rCard.innerHTML = `<div class="reasoning-header"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg><span>已深度思考 (点击展开)</span></div><div class="reasoning-body">${escapeHtml(msg.reasoning.trim())}</div>`;
        rCard.querySelector('.reasoning-header').addEventListener('click', () => {
          rCard.classList.toggle('collapsed');
          scrollToBottom(true);
        });
        bubble.appendChild(rCard);
      }

      const contentBox = document.createElement('div');
      contentBox.className = 'msg-content';
      contentBox.innerHTML = renderMarkdown(msg.content);
      bubble.appendChild(contentBox);
    } else {
      bubble.textContent = msg.content;
    }

    row.appendChild(bubble);
    return row;
  }

  function clearMessagesUi() {
    messagesList.innerHTML = '';
    messagesList.appendChild(welcomeBox);
    welcomeBox.classList.remove('hidden');
  }

  function loadMessages(list) {
    clearMessagesUi();
    if (!Array.isArray(list) || list.length === 0) return;

    welcomeBox.classList.add('hidden');
    const frag = document.createDocumentFragment();
    for (const msg of list) {
      if (msg.role === 'user' || (msg.role === 'assistant' && (msg.content || msg.reasoning))) {
        frag.appendChild(renderMessageItem(msg));
      }
    }
    messagesList.appendChild(frag);
    scrollToBottom(true);
  }

  function appendUserMessage(text) {
    welcomeBox.classList.add('hidden');
    const msg = { role: 'user', content: text };
    const el = renderMessageItem(msg);
    messagesList.appendChild(el);
    scrollToBottom(true);
  }

  function createStreamingAssistantMessage() {
    welcomeBox.classList.add('hidden');
    activeAssistantMsg = { role: 'assistant', content: '', reasoning: '' };
    activeReasoningText = '';
    activeContentText = '';

    const row = document.createElement('div');
    row.className = 'msg-row assistant';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    // Placeholder for reasoning
    const reasoningBox = document.createElement('div');
    reasoningBox.className = 'reasoning-card hidden';
    reasoningBox.innerHTML = `<div class="reasoning-header"><svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"></polyline></svg><span>深度思考中…</span></div><div class="reasoning-body"></div>`;
    reasoningBox.querySelector('.reasoning-header').addEventListener('click', () => {
      reasoningBox.classList.toggle('collapsed');
      scrollToBottom(true);
    });
    bubble.appendChild(reasoningBox);

    // Content container
    const contentBox = document.createElement('div');
    contentBox.className = 'msg-content';
    contentBox.innerHTML = '<span class="typing-cursor"></span>';
    bubble.appendChild(contentBox);

    row.appendChild(bubble);
    messagesList.appendChild(row);
    activeAssistantEl = { row, bubble, reasoningBox, contentBox };
    scrollToBottom(true);
  }

  function updateStreamingContent(delta, fullContent) {
    if (!activeAssistantEl) createStreamingAssistantMessage();
    // 当正文开始生成时，若思考卡片还在展开状态，自动收起为小胶囊，让正文成为主角！
    const rBox = activeAssistantEl.reasoningBox;
    if (rBox && !rBox.classList.contains('hidden') && !rBox.classList.contains('collapsed')) {
      rBox.classList.add('collapsed');
      const span = rBox.querySelector('.reasoning-header span');
      if (span) span.textContent = '已深度思考 (点击展开)';
    }
    activeContentText = fullContent !== undefined ? fullContent : (activeContentText + (delta || ''));
    const contentBox = activeAssistantEl.contentBox;
    contentBox.innerHTML = renderMarkdown(activeContentText) + '<span class="typing-cursor"></span>';
    scrollToBottom();
  }

  function updateStreamingReasoning(delta, fullReasoning) {
    if (!activeAssistantEl) createStreamingAssistantMessage();
    activeReasoningText = fullReasoning !== undefined ? fullReasoning : (activeReasoningText + (delta || ''));
    const rBox = activeAssistantEl.reasoningBox;
    rBox.classList.remove('hidden');
    rBox.querySelector('.reasoning-body').textContent = activeReasoningText;
    scrollToBottom();
  }

  function finalizeStreaming(error) {
    setGeneratingState(false);
    if (!activeAssistantEl) return;

    const contentBox = activeAssistantEl.contentBox;
    // Remove typing cursor
    const cursor = contentBox.querySelector('.typing-cursor');
    if (cursor) cursor.remove();

    if (error) {
      const errDiv = document.createElement('div');
      errDiv.style.color = '#f85149';
      errDiv.style.marginTop = '6px';
      errDiv.style.fontSize = '12px';
      errDiv.textContent = `⚠ ${error}`;
      activeAssistantEl.bubble.appendChild(errDiv);
    } else {
      contentBox.innerHTML = renderMarkdown(activeContentText || '（无回答）');
    }

    const rBox = activeAssistantEl.reasoningBox;
    if (rBox) {
      if (!activeReasoningText || !activeReasoningText.trim()) {
        rBox.remove(); // 没有任何思考内容，彻底移除占位节点！
      } else {
        rBox.classList.add('collapsed');
        const span = rBox.querySelector('.reasoning-header span');
        if (span) span.textContent = '已深度思考 (点击展开)';
      }
    }

    activeAssistantEl = null;
    activeAssistantMsg = null;
    scrollToBottom(true);
  }

  function sendMessage() {
    if (isGenerating) return;
    const text = (chatInput.value || '').trim();
    if (!text) return;

    chatInput.value = '';
    adjustTextareaHeight();
    appendUserMessage(text);
    createStreamingAssistantMessage();
    setGeneratingState(true);

    window.petChat.send(text);
  }

  function adjustTextareaHeight() {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(100, Math.max(20, chatInput.scrollHeight)) + 'px';
  }

  /* --- Event Listeners -------------------------------------------------------- */

  chatInput.addEventListener('input', adjustTextareaHeight);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  btnSend.addEventListener('click', sendMessage);
  btnStop.addEventListener('click', () => {
    window.petChat.abort();
    finalizeStreaming('用户已停止生成');
  });

  btnNewTopic.addEventListener('click', () => {
    if (isGenerating) window.petChat.abort();
    clearMessagesUi();
    setGeneratingState(false);
    window.petChat.newTopic();
  });

  btnSettings.addEventListener('click', () => {
    window.petChat.openAiSettings();
  });

  btnMinimize.addEventListener('click', () => {
    window.petChat.minimize();
  });

  btnClose.addEventListener('click', () => {
    window.petChat.close();
  });

  /* --- IPC from Preload ------------------------------------------------------- */

  window.petChat.onInit(payload => {
    if (payload.petName) petName.textContent = `${payload.petName} AI 伴侣`;
    if (payload.petAvatar) petAvatar.textContent = payload.petAvatar;
    if (Array.isArray(payload.messages)) {
      loadMessages(payload.messages);
    }
    setGeneratingState(!!payload.isGenerating);
  });

  window.petChat.onMessages(payload => {
    if (Array.isArray(payload.messages)) {
      loadMessages(payload.messages);
    }
  });

  window.petChat.onStatus(payload => {
    setGeneratingState(payload.isGenerating);
  });

  window.petChat.onStreamChunk(payload => {
    const chunk = payload.chunk || {};
    if (chunk.type === 'content') {
      updateStreamingContent(chunk.delta, chunk.content);
    } else if (chunk.type === 'reasoning') {
      updateStreamingReasoning(chunk.delta, chunk.reasoning);
    } else if (chunk.type === 'tool_exec_start') {
      updateStreamingContent(`\n*正在调用工具…*\n`);
    } else if (chunk.type === 'error') {
      finalizeStreaming(chunk.error || '请求出错');
    } else if (chunk.type === 'aborted') {
      finalizeStreaming('已中断生成');
    } else if (chunk.type === 'done' || chunk.type === 'complete') {
      finalizeStreaming();
    }
  });

  // Ready handshake
  window.petChat.ready();
})();
