const { contextBridge, ipcRenderer } = require('electron');

// Expose a minimal API to the renderer. The frontend talks to the backend
// over HTTP (same origin), so it doesn't strictly need this — but we expose
// the server port for diagnostics.
contextBridge.exposeInMainWorld('obeDesktop', {
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  isDesktop: true,
});
