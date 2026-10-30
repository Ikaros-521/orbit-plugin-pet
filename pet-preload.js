/* desktop-pet sprite preload — namespaced bridge to the backend.
   The page is sandboxed; everything it can do goes through these channels.
   File-drop is wired HERE (not in pet.js): modern Electron removed File.path
   and webUtils.getPathForFile must run against the live File object in a
   trusted (preload) context. */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const P = 'desktop-pet:';

contextBridge.exposeInMainWorld('pet', {
  ready: () => ipcRenderer.send(`${P}ready`),
  status: s => ipcRenderer.send(`${P}status`, s),
  setBounds: b => ipcRenderer.send(`${P}set-bounds`, b),
  setIgnore: ignore => ipcRenderer.send(`${P}set-ignore`, { ignore }),
  contextMenu: () => ipcRenderer.send(`${P}context-menu`),
  touch: () => ipcRenderer.send(`${P}touch`),
  tasksClick: () => ipcRenderer.send(`${P}tasks-click`),
  reportPlayback: (id, status) => ipcRenderer.send(`${P}playback-report`, { id, status }),
  onInit: fn => ipcRenderer.on(`${P}init`, (_e, payload) => fn(payload)),
  onPrefs: fn => ipcRenderer.on(`${P}prefs`, (_e, payload) => fn(payload)),
  onBubble: fn => ipcRenderer.on(`${P}bubble`, (_e, payload) => fn(payload)),
  onLock: fn => ipcRenderer.on(`${P}lock`, (_e, payload) => fn(payload)),
  onPlay: fn => ipcRenderer.on(`${P}play`, (_e, payload) => fn(payload)),
  onSpring: fn => ipcRenderer.on(`${P}spring`, (_e, payload) => fn(payload)),
  onTasks: fn => ipcRenderer.on(`${P}tasks`, (_e, payload) => fn(payload)),
  onDisplays: fn => ipcRenderer.on(`${P}displays`, (_e, payload) => fn(payload)),
});

/* --- drop-to-route ------------------------------------------------------------ */
window.addEventListener('dragenter', e => { e.preventDefault(); document.body.classList.add('dropover'); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropover'); });
window.addEventListener('drop', e => {
  e.preventDefault();
  document.body.classList.remove('dropover');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  let localPath = '';
  try { localPath = webUtils.getPathForFile(file) || ''; } catch { /* detached or virtual */ }
  ipcRenderer.send(`${P}file-drop`, { path: localPath, name: file.name, size: file.size });
});
