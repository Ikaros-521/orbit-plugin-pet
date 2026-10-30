/* desktop-pet sprite preload — namespaced bridge to the backend.
   The page is sandboxed; everything it can do goes through these channels. */
const { contextBridge, ipcRenderer } = require('electron');

const P = 'desktop-pet:';

contextBridge.exposeInMainWorld('pet', {
  ready: () => ipcRenderer.send(`${P}ready`),
  status: s => ipcRenderer.send(`${P}status`, s),
  setBounds: b => ipcRenderer.send(`${P}set-bounds`, b),
  setIgnore: ignore => ipcRenderer.send(`${P}set-ignore`, { ignore }),
  contextMenu: () => ipcRenderer.send(`${P}context-menu`),
  onInit: fn => ipcRenderer.on(`${P}init`, (_e, payload) => fn(payload)),
  onPrefs: fn => ipcRenderer.on(`${P}prefs`, (_e, payload) => fn(payload)),
  onPlay: fn => ipcRenderer.on(`${P}play`, (_e, payload) => fn(payload)),
  onDisplays: fn => ipcRenderer.on(`${P}displays`, (_e, payload) => fn(payload)),
});
