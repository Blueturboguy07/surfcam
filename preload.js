const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('surf', {
  log: (...a) => ipcRenderer.send('log', ...a),
  status: (s) => ipcRenderer.send('status', s),
  trace: (rows) => ipcRenderer.send('trace', rows),
  gameFrames: (wcId) => ipcRenderer.invoke('game-frames', wcId),
  gameEval: (wcId, match, code) => ipcRenderer.invoke('game-eval', { wcId, match, code }),
});
