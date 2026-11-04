/* desktop-pet chat window preload — namespaced bridge to the backend.
   Runs in an isolated context; all communication with main process goes through these channels. */
const { contextBridge, ipcRenderer } = require('electron');

const P = 'desktop-pet-chat:';

contextBridge.exposeInMainWorld('petChat', {
  ready: () => ipcRenderer.send(`${P}ready`),
  send: (content) => ipcRenderer.send(`${P}send`, { content }),
  abort: () => ipcRenderer.send(`${P}abort`),
  newTopic: () => ipcRenderer.send(`${P}new-topic`),
  resolveApproval: (toolCallId, approved, alwaysAllow) =>
    ipcRenderer.send(`${P}resolve-approval`, { toolCallId, approved, alwaysAllow }),
  close: () => ipcRenderer.send(`${P}close`),
  minimize: () => ipcRenderer.send(`${P}minimize`),
  openAiSettings: () => ipcRenderer.send(`${P}open-ai-settings`),
  
  onInit: fn => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(`${P}init`, handler);
    return () => ipcRenderer.removeListener(`${P}init`, handler);
  },
  onStreamChunk: fn => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(`${P}chunk`, handler);
    return () => ipcRenderer.removeListener(`${P}chunk`, handler);
  },
  onStatus: fn => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(`${P}status`, handler);
    return () => ipcRenderer.removeListener(`${P}status`, handler);
  },
  onMessages: fn => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(`${P}messages`, handler);
    return () => ipcRenderer.removeListener(`${P}messages`, handler);
  }
});
