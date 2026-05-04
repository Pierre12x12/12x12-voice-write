const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  transcribe: (audioBuffer) => ipcRenderer.invoke('transcribe', audioBuffer),
  enhance: (text) => ipcRenderer.invoke('enhance', text),
  pasteText: (text) => ipcRenderer.invoke('paste-text', text),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  showWindow: () => ipcRenderer.invoke('show-window'),
  rendererReady: () => ipcRenderer.invoke('renderer-ready'),
  resizeForSettings: (expand) => ipcRenderer.invoke('resize-for-settings', expand),
  resizeForResult: (expand) => ipcRenderer.invoke('resize-for-result', expand),
  onToggleRecording: (cb) => ipcRenderer.on('toggle-recording', cb),
  onShowSettings: (cb) => ipcRenderer.on('show-settings', cb),
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, info) => cb(info)),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, info) => cb(info)),
  onUpdateDownloadProgress: (cb) => ipcRenderer.on('update-download-progress', (_e, info) => cb(info)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_e, info) => cb(info)),
  onUpdateError: (cb) => ipcRenderer.on('update-error', (_e, info) => cb(info)),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  checkForUpdates: (silent) => ipcRenderer.invoke('check-for-updates', silent),
  heartbeatPong: () => ipcRenderer.invoke('heartbeat-pong'),
  onHeartbeatPing: (cb) => ipcRenderer.on('heartbeat-ping', cb),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
