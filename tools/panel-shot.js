/* Panel visual check — boots the REAL orbit-tools renderer (index.html +
   app.js) with this plugin installed into a throwaway user dir, opens the
   desktop-pet panel, and screenshots it in light and dark themes.

     E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/panel-shot.js

   Output: %TEMP%/pet-frames/panel-light.png / panel-dark.png */

const { app, BrowserWindow, protocol } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ORBIT = path.resolve(__dirname, '..', '..', 'orbit-tools');
const Config = require(path.join(ORBIT, 'src', 'core', 'config'));
const PluginManager = require(path.join(ORBIT, 'src', 'core', 'plugin-manager'));
const { registerPluginProtocol } = require(path.join(ORBIT, 'src', 'core', 'plugin-protocol'));
const createHotkeys = require(path.join(ORBIT, 'src', 'core', 'hotkeys'));
const registerIpc = require(path.join(ORBIT, 'src', 'core', 'ipc'));

protocol.registerSchemesAsPrivileged([
  { scheme: 'plugin', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const OUT = path.join(os.tmpdir(), 'pet-frames');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shotTheme(theme) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `pet-panel-${theme}-`));
  const userPlugins = path.join(tmp, 'plugins');
  fs.mkdirSync(userPlugins, { recursive: true });
  fs.cpSync(path.join(__dirname, '..'), path.join(userPlugins, 'desktop-pet'), { recursive: true });
  const cfg = new Config(tmp);
  cfg.set({ theme });
  let win = null;
  const manager = new PluginManager({ userDataDir: tmp, config: cfg, getHostWindow: () => win });
  const hotkeys = createHotkeys({ cfg, manager, onSummon: () => {} });
  registerPluginProtocol(manager);
  registerIpc({ app, cfg, manager, hotkeys, getHostWindow: () => win });
  manager.discover();
  for (const p of manager.plugins.values()) if (p.enabled) manager.activate(p.id);

  win = new BrowserWindow({
    show: false, width: 980, height: 760,
    webPreferences: {
      preload: path.join(ORBIT, 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) console.log(`[renderer err] ${msg.slice(0, 160)}`); });
  await win.loadFile(path.join(ORBIT, 'src', 'renderer', 'index.html'));
  await sleep(800);
  win.webContents.send('open-plugin', 'desktop-pet');
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const mounted = await win.webContents.executeJavaScript('!!document.querySelector(".dpet-root .dpet-hero-name")');
    if (mounted) break;
  }
  await sleep(600);
  const state = await win.webContents.executeJavaScript(`({
    name: (document.querySelector('.dpet-hero-name') || {}).textContent,
    status: (document.querySelector('.dpet-hero-status') || {}).textContent,
    toggle: (document.querySelector('.dpet-toggle') || {}).textContent,
    packs: (document.querySelector('.dpet-pack') || {}).value,
    walk: (document.querySelector('.dpet-walk') || {}).checked,
  })`);
  const png = path.join(OUT, `panel-${theme}.png`);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(png, (await win.webContents.capturePage()).toPNG());
  console.log(`SHOT ${theme}: name="${state.name}" toggle="${state.toggle}" pack=${state.packs} walk=${state.walk} -> ${png}`);
  manager.deactivateAll();
  win.destroy();
}

app.whenReady().then(async () => {
  // one theme per process: protocol.handle('plugin') registers once per app
  const theme = process.argv.includes('--dark') ? 'dark' : 'light';
  try {
    await shotTheme(theme);
  } catch (e) { console.error('PANEL_SHOT_ERR', e.message); app.exit(1); return; }
  app.exit(0);
});
