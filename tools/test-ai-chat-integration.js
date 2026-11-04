/* Test desktop-pet <-> ai-chat integration — with the full chat stream flow.
   Run with orbit-tools' electron:
     E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/test-ai-chat-integration.js

   Covers session plumbing (as before) plus the v0.9 stream-flow contract:
   - chat window boots against a real ai-chat session
   - stream chunks forwarded by streamId render in the chat window
   - tool_approval_request renders an approval card; clicking it calls
     ai-chat resolveToolApproval with the right streamId/toolCallId/flags
   - the isAiGenerating gate drops a second send while a stream is live
   - an 'aborted' chunk (fired from the ai-chat panel, not our stop button)
     resets the gate so the next send goes through

   Deterministic by stubbing ai-chat sendMessage at the manager.call level:
   the pet believes the model is streaming, and the test drives the chunks. */
const { app, BrowserWindow } = require('electron');
const { protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/* Must run before app ready (mirrors smoke.js / orbit-tools main.js): without
   it plugin:// is non-standard, the page's CSP 'self' rejects subresources and
   the chat renderer never boots. */
protocol.registerSchemesAsPrivileged([
  { scheme: 'plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const ok = m => console.log('ok -', m);
const fail = m => { console.error('FAIL:', m); app.exit(1); throw new Error(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 6000, step = 150) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
};

const toolsRoot = path.resolve('E:/Github_Pro/orbit-tools');
const PluginManager = require(path.join(toolsRoot, 'src/core/plugin-manager'));
const Config = require(path.join(toolsRoot, 'src/core/config'));
const { registerPluginProtocol } = require(path.join(toolsRoot, 'src/core/plugin-protocol'));

app.whenReady().then(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-ai-test-'));
  const userPlugins = path.join(tmp, 'plugins');
  fs.mkdirSync(userPlugins, { recursive: true });
  fs.cpSync(path.join(__dirname, '..'), path.join(userPlugins, 'desktop-pet'), { recursive: true });

  const cfg = new Config(tmp);
  const fakeHost = new BrowserWindow({ show: false, width: 80, height: 60 });
  const manager = new PluginManager({ userDataDir: tmp, config: cfg, getHostWindow: () => fakeHost });
  registerPluginProtocol(manager);
  manager.discover();
  ok('discovered: ' + Array.from(manager.plugins.keys()).join(', '));

  /* --- 1. activation ------------------------------------------------------- */
  if (!manager.activate('ai-chat')) fail('ai-chat activation failed: ' + JSON.stringify(Array.from(manager.loadErrors.entries())));
  if (!manager.activate('desktop-pet')) fail('desktop-pet activation failed');
  ok('ai-chat + desktop-pet activated');

  /* --- 2. cross-plugin session plumbing ------------------------------------ */
  const initData = await manager.call('ai-chat', 'getInitData');
  if (!initData || !Array.isArray(initData.sessions)) fail('ai-chat getInitData broken');
  const created = await manager.call('ai-chat', 'createSession', { title: '桌宠伴侣对话', personaId: 'general' });
  if (!created || !created.session) fail('pet session creation failed');
  ok('ai-chat session created: ' + created.session.id);

  /* --- 3. chat window boots against the session ----------------------------- */
  const openRes = await manager.call('desktop-pet', 'openChat');
  if (!openRes || !openRes.ok) fail('openChat returned not ok');
  const findChatWin = () => BrowserWindow.getAllWindows().find(w => {
    try { return !w.isDestroyed() && w.webContents.getURL().includes('chat.html'); } catch { return false; }
  });
  const chatWin = await waitFor(findChatWin, 8000);
  if (!chatWin) fail('chat window never appeared');
  if (!await waitFor(async () => await chatWin.webContents.executeJavaScript('typeof window.petChat === "object" && !document.querySelector(".typing-cursor")'), 6000)) {
    fail('chat renderer did not boot (petChat bridge missing)');
  }
  await sleep(800); // init round-trip (session lookup -> init payload)
  ok('chat window booted with petChat bridge');

  /* --- 4. stub ai-chat sendMessage so the test drives the stream ------------- */
  let lastStream = null;
  let lastSendArgs = null;
  const resolveCalls = [];
  const realCall = manager.call.bind(manager);
  manager.call = async (id, method, args) => {
    if (id === 'ai-chat' && method === 'sendMessage') {
      lastStream = args.streamId; lastSendArgs = args;
      return { ok: true, streamId: args.streamId };
    }
    if (id === 'ai-chat' && method === 'resolveToolApproval') {
      resolveCalls.push(args); // still forward: real service answers {ok:false} harmlessly
      return realCall(id, method, args);
    }
    return realCall(id, method, args);
  };

  /* --- 5. send -> stream -> approval card -> resolve -------------------------- */
  /* drive the chat UI the way a user does (input + send button) so the
     renderer's own message scaffolding runs, not just the bridge */
  const uiSend = (win, text) => win.webContents.executeJavaScript(
    `(() => { const i = document.getElementById('chatInput'); i.value = ${JSON.stringify('PLACEHOLDER')}; document.getElementById('btnSend').click(); i.value=''; })()`
      .replace('PLACEHOLDER', JSON.stringify(text).slice(1, -1)),
  );
  await uiSend(chatWin, '你好呀，帮我查下天气');
  if (!await waitFor(() => lastStream)) fail('send never reached ai-chat sendMessage');
  if (lastSendArgs.enableAgent !== true) fail('pet chat must keep enableAgent=true');
  if (!await waitFor(async () => await chatWin.webContents.executeJavaScript('!!document.querySelector(".typing-cursor")'), 4000)) {
    fail('streaming message did not start');
  }
  ok(`send dispatched (streamId=${lastStream}, agent mode on)`);

  manager.broadcast('ai-chat', 'stream-chunk', {
    streamId: lastStream,
    chunk: { type: 'content', delta: '好呀！', content: '好呀！' },
  });
  if (!await waitFor(async () => await chatWin.webContents.executeJavaScript('document.body.innerText.includes("好呀！")'), 4000)) {
    fail('content chunk did not render in chat window');
  }
  ok('stream chunk forwarded by streamId and rendered');

  manager.broadcast('ai-chat', 'stream-chunk', {
    streamId: lastStream,
    chunk: { type: 'tool_approval_request', toolId: 'tc-1', toolName: 'web_search', args: '{"query":"天气"}' },
  });
  if (!await waitFor(async () => await chatWin.webContents.executeJavaScript(
    'const c=document.querySelector(\'.approval-card[data-approval="tc-1"]\'); !!c && c.querySelectorAll(\'.approval-btn\').length===3 && c.innerText.includes("web_search")'
  ), 4000)) fail('tool_approval_request did not render an approval card');
  ok('approval card rendered (3 actions + tool name + args)');

  await chatWin.webContents.executeJavaScript('document.querySelector(\'.approval-card[data-approval="tc-1"] .approval-btn.always\').click()');
  if (!await waitFor(() => resolveCalls.length === 1)) fail('clicking the card did not reach resolveToolApproval');
  const rc = resolveCalls[0] || {};
  if (rc.toolCallId !== 'tc-1' || rc.approved !== true || rc.alwaysAllow !== true || rc.streamId !== lastStream) {
    fail('resolveToolApproval called with wrong args: ' + JSON.stringify(rc));
  }
  ok('always-allow click -> resolveToolApproval(streamId, toolCallId, approved, alwaysAllow)');

  manager.broadcast('ai-chat', 'stream-chunk', {
    streamId: lastStream,
    chunk: { type: 'done', message: { content: '好呀！' } },
  });
  if (!await waitFor(async () => await chatWin.webContents.executeJavaScript(
    '!document.querySelector(".typing-cursor") && !!document.querySelector(\'.approval-card[data-approval="tc-1"].resolved\')'
  ), 4000)) fail('done chunk did not finalize the stream');
  ok('done chunk finalized the message, resolved card preserved');

  /* --- 6. generation gate + aborted reset ------------------------------------ */
  const streamA = lastStream;
  await uiSend(chatWin, '第二条');
  if (!await waitFor(() => lastStream && lastStream !== streamA)) fail('second send never dispatched');
  const streamB = lastStream;
  await uiSend(chatWin, '应该被生成门拦住');
  await sleep(600);
  if (lastStream !== streamB) fail('isAiGenerating gate failed: concurrent send went through');
  ok('while generating, a second send is dropped');

  manager.broadcast('ai-chat', 'stream-chunk', { streamId: streamB, chunk: { type: 'aborted' } });
  await uiSend(chatWin, '中止后应放行');
  if (!await waitFor(() => lastStream && lastStream !== streamB)) {
    fail("aborted chunk did not reset isAiGenerating — the pet chat is bricked until restart");
  }
  ok("aborted chunk (from the ai-chat panel side) resets the gate; next send flows");
  manager.broadcast('ai-chat', 'stream-chunk', { streamId: lastStream, chunk: { type: 'aborted' } }); // leave state clean

  console.log('\nALL CHAT-FLOW INTEGRATION TESTS PASSED');
  app.exit(0);
}).catch(err => {
  console.error('[test] Uncaught error:', err && err.stack || err);
  app.exit(1);
});
