/* Test desktop-pet <-> ai-chat integration */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const toolsRoot = path.resolve('E:/Github_Pro/orbit-tools');
const PluginManager = require(path.join(toolsRoot, 'src/core/plugin-manager'));
const Config = require(path.join(toolsRoot, 'src/core/config'));

app.whenReady().then(async () => {
  console.log('[test] Electron ready, setting up test environment...');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-ai-test-'));
  const userPlugins = path.join(tmp, 'plugins');
  fs.mkdirSync(userPlugins, { recursive: true });
  fs.cpSync(path.join(__dirname, '..'), path.join(userPlugins, 'desktop-pet'), { recursive: true });

  const cfg = new Config(tmp);
  const fakeHost = new BrowserWindow({ show: false, width: 80, height: 60 });
  const manager = new PluginManager({ userDataDir: tmp, config: cfg, getHostWindow: () => fakeHost });

  manager.discover();
  console.log('[test] Discovered plugins:', Array.from(manager.plugins.keys()).join(', '));

  // 1. Activate ai-chat and desktop-pet
  const aiChatOk = manager.activate('ai-chat');
  console.log('[test] ai-chat activate:', aiChatOk);
  const petOk = manager.activate('desktop-pet');
  console.log('[test] desktop-pet activate:', petOk);

  if (!aiChatOk || !petOk) {
    console.error('[test] Activation failed. Errors:', manager.loadErrors);
    app.exit(1);
    return;
  }

  // 2. Test openChat IPC method
  console.log('[test] Testing openChat on desktop-pet...');
  const openRes = await manager.call('desktop-pet', 'openChat');
  console.log('[test] openChat call result:', openRes);
  if (!openRes || !openRes.ok) {
    console.error('[test] openChat returned not ok');
    app.exit(1);
    return;
  }

  // 3. Test getInitData on ai-chat via cross-plugin
  const initData = await manager.call('ai-chat', 'getInitData');
  console.log('[test] ai-chat getInitData sessions:', initData.sessions.length);

  // 4. Test creating a dedicated pet chat session
  const created = await manager.call('ai-chat', 'createSession', {
    title: '桌宠伴侣对话',
    personaId: 'general'
  });
  console.log('[test] Created session:', created.session.id, 'title:', created.session.title);
  if (!created || !created.session || created.session.title !== '桌宠伴侣对话') {
    console.error('[test] Session creation failed');
    app.exit(1);
    return;
  }

  // 5. Test desktop-pet state includes expected props
  const petState = await manager.call('desktop-pet', 'getState');
  console.log('[test] petState pack:', petState.pack.id, 'tasks:', petState.tasks);

  console.log('\n🎉 ALL INTEGRATION TESTS PASSED!');
  app.exit(0);
}).catch(err => {
  console.error('[test] Uncaught error:', err);
  app.exit(1);
});
