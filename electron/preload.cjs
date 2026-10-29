// Ponte segura entre o renderer e o processo principal (contextIsolation).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("host", {
  listSongs: () => ipcRenderer.invoke("songs:list"),
  readSongFile: (dir, name) => ipcRenderer.invoke("songs:read", dir, name),
  importZips: () => ipcRenderer.invoke("songs:import"),
  addSongFolder: () => ipcRenderer.invoke("songs:addFolder"),
  songDirs: () => ipcRenderer.invoke("songs:dirs"),
  deleteSong: (dir) => ipcRenderer.invoke("songs:delete", dir),
  canDeleteSong: (dir) => ipcRenderer.invoke("songs:canDelete", dir),
  removeSongDir: (dir) => ipcRenderer.invoke("songs:removeDir", dir),
  openImportDir: () => ipcRenderer.invoke("songs:openImportDir"),
  searchBeatSaver: (q, sort, page, minNps, maxNps) => ipcRenderer.invoke("bs:search", q, sort, page, minNps, maxNps),
  installBeatSaver: (id, url, label) => ipcRenderer.invoke("bs:install", id, url, label),
  uninstallBeatSaver: (id) => ipcRenderer.invoke("bs:uninstall", id),
  getPrefs: () => ipcRenderer.invoke("prefs:get"),
  setPrefs: (p) => ipcRenderer.invoke("prefs:set", p),
  toggleFullscreen: () => ipcRenderer.invoke("app:toggleFullscreen"),
  quit: () => ipcRenderer.invoke("app:quit"),
});
