const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('surf', {
  log: (...a) => ipcRenderer.send('log', ...a),
  status: (s) => ipcRenderer.send('status', s),
  trace: (rows) => ipcRenderer.send('trace', rows),
  gameFrames: (wcId) => ipcRenderer.invoke('game-frames', wcId),
  gameEval: (wcId, match, code) => ipcRenderer.invoke('game-eval', { wcId, match, code }),
  onCue: (cb) => ipcRenderer.on('cue', (_e, cue) => cb(cue)),
  onLanes: (cb) => ipcRenderer.on('lanes', (_e, d) => cb(d)),
  onCuesState: (cb) => ipcRenderer.on('cues-state', (_e, d) => cb(d)),
  onSetKeys: (cb) => ipcRenderer.on('set-keys', (_e, d) => cb(d)),
  cuesConfig: (cfg) => ipcRenderer.send('cues-config', cfg),
});
