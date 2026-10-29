// Processo principal do Electron: janela, permissao da webcam e acesso ao disco
// (biblioteca de musicas, importacao de .zip, configuracoes). O renderer so fala
// com o disco pelas funcoes expostas em preload.cjs.
const { app, BrowserWindow, ipcMain, dialog, session, shell } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const JSZip = require("jszip");

const isDev = !!process.env.WINSABER_DEV_URL;
// notebooks com 2 GPUs: usa a dedicada (o rastreamento e a cena 3D dividem a GPU)
app.commandLine.appendSwitch("force_high_performance_gpu");
let win = null;

// ---------------------------------------------------------------------------
// configuracoes persistentes (userData/settings.json)
// ---------------------------------------------------------------------------
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
const importDir = () => path.join(app.getPath("userData"), "Songs");

function defaultSongDirs() {
  const dirs = [importDir()];
  const candidates = [
    "C:/Program Files (x86)/Steam/steamapps/common/Beat Saber/Beat Saber_Data/CustomLevels",
    "C:/Program Files/Oculus/Software/Software/hyperbolic-magnetism-beat-saber/Beat Saber_Data/CustomLevels",
  ];
  for (const d of candidates) if (fs.existsSync(d)) dirs.push(path.normalize(d));
  return dirs;
}

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (!Array.isArray(s.songDirs)) s.songDirs = defaultSongDirs();
    return s;
  } catch {
    return { songDirs: defaultSongDirs() };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

// ---------------------------------------------------------------------------
// biblioteca de musicas
// ---------------------------------------------------------------------------
// pastas de musicas encontradas no ultimo scan: unicas que o renderer pode ler
const allowedSongDirs = new Set();

function findCI(dir, name) {
  if (!name) return null;
  const direct = path.join(dir, name);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  const low = name.toLowerCase();
  try {
    for (const e of fs.readdirSync(dir)) if (e.toLowerCase() === low) return path.join(dir, e);
  } catch {}
  return null;
}

async function scanDir(root, out, depth = 0) {
  if (depth > 3) return;
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const info = findCI(root, "info.dat");
  if (info) {
    try {
      const text = await fsp.readFile(info, "utf8");
      const stat = await fsp.stat(info);
      out.push({ dir: root, infoText: text, mtime: stat.mtimeMs });
      allowedSongDirs.add(path.resolve(root));
    } catch {}
    return;
  }
  for (const e of entries) if (e.isDirectory()) await scanDir(path.join(root, e.name), out, depth + 1);
}

ipcMain.handle("songs:list", async () => {
  const s = loadSettings();
  allowedSongDirs.clear();
  const out = [];
  for (const d of s.songDirs) await scanDir(d, out);
  return out;
});

// le um arquivo de uma pasta de musica (somente nome de arquivo, sem subpastas)
ipcMain.handle("songs:read", async (_e, dir, name) => {
  const resolved = path.resolve(dir);
  if (!allowedSongDirs.has(resolved)) throw new Error("pasta nao autorizada");
  const base = path.basename(String(name || ""));
  const file = findCI(resolved, base);
  if (!file) return null;
  const buf = await fsp.readFile(file);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
});

async function extractZip(zipPath) {
  const data = await fsp.readFile(zipPath);
  const zip = await JSZip.loadAsync(data);
  const stem = path.basename(zipPath, path.extname(zipPath)).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  const dest = path.join(importDir(), stem);
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const base = path.basename(entry.name); // achata e impede path traversal
    if (!base) continue;
    await fsp.writeFile(path.join(dest, base), await entry.async("nodebuffer"));
  }
  return dest;
}

ipcMain.handle("songs:import", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Importar mapas (.zip do BeatSaver)",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Mapas", extensions: ["zip"] }],
  });
  if (r.canceled) return 0;
  let n = 0;
  for (const f of r.filePaths) {
    try {
      await extractZip(f);
      n++;
    } catch (err) {
      console.error("falha ao importar", f, err);
    }
  }
  return n;
});

ipcMain.handle("songs:addFolder", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "Adicionar pasta de músicas (ex.: Beat Saber_Data/CustomLevels)",
    properties: ["openDirectory"],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const s = loadSettings();
  if (!s.songDirs.includes(r.filePaths[0])) s.songDirs.push(r.filePaths[0]);
  saveSettings(s);
  return r.filePaths[0];
});

// ---------------------------------------------------------------------------
// BeatSaver (beatsaver.com): busca e instalacao de mapas pela API publica
// ---------------------------------------------------------------------------
const BS_API = "https://api.beatsaver.com";
const BS_UA = "WinSaber/1.0 (jogo de ritmo para PC)";
const BS_SORTS = new Set(["Rating", "Latest", "Relevance", "Curated"]);

function installedIds() {
  const ids = new Set();
  try {
    for (const e of fs.readdirSync(importDir())) {
      const m = /^([0-9a-f]+)[ (]/i.exec(e + " ");
      if (m) ids.add(m[1].toLowerCase());
    }
  } catch {}
  return ids;
}

function mapDoc(doc, installed) {
  const v = (doc.versions || [])[0] || {};
  const diffs = (v.diffs || []).map((d) => ({ characteristic: d.characteristic, difficulty: d.difficulty, ne: !!d.ne, me: !!d.me, nps: d.nps || 0 }));
  const meta = doc.metadata || {};
  const stats = doc.stats || {};
  return {
    id: String(doc.id || ""),
    name: doc.name || "",
    songName: meta.songName || doc.name || "",
    songSubName: meta.songSubName || "",
    artist: meta.songAuthorName || "",
    mapper: meta.levelAuthorName || "",
    bpm: meta.bpm || 0,
    duration: meta.duration || 0,
    upvotes: stats.upvotes || 0,
    downvotes: stats.downvotes || 0,
    score: stats.score || 0,
    coverURL: v.coverURL || "",
    previewURL: v.previewURL || "",
    downloadURL: v.downloadURL || "",
    automapper: !!doc.automapper,
    needsMods: diffs.length > 0 && diffs.every((d) => d.ne || d.me),
    diffs,
    installed: installed.has(String(doc.id || "").toLowerCase()),
  };
}

ipcMain.handle("bs:search", async (_e, query, sort, page, minNps, maxNps) => {
  const s = BS_SORTS.has(sort) ? sort : "Rating";
  const p = Math.max(0, Math.min(500, Number(page) || 0));
  const url = new URL(`${BS_API}/search/text/${p}`);
  url.searchParams.set("sortOrder", s);
  if (query) url.searchParams.set("q", String(query).slice(0, 100));
  // dificuldade: notas por segundo de alguma das dificuldades do mapa (filtro do servidor)
  if (Number(minNps) > 0) url.searchParams.set("minNps", String(Number(minNps)));
  if (Number(maxNps) > 0) url.searchParams.set("maxNps", String(Number(maxNps)));
  const res = await fetch(url, { headers: { "User-Agent": BS_UA } });
  if (!res.ok) throw new Error(`BeatSaver respondeu HTTP ${res.status}`);
  const data = await res.json();
  const installed = installedIds();
  return (data.docs || []).map((d) => mapDoc(d, installed));
});

ipcMain.handle("bs:install", async (_e, id, downloadURL, label) => {
  const u = new URL(String(downloadURL));
  // so baixa do CDN oficial do BeatSaver
  if (u.protocol !== "https:" || !/(^|\.)beatsaver\.com$/i.test(u.hostname)) throw new Error("endereço de download não permitido");
  const res = await fetch(u, { headers: { "User-Agent": BS_UA } });
  if (!res.ok) throw new Error(`download falhou: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 200 * 1024 * 1024) throw new Error("arquivo grande demais");
  const zip = await JSZip.loadAsync(buf);
  const safe = (s) => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 90);
  const dest = path.join(importDir(), safe(`${id} (${label})`));
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const base = path.basename(entry.name); // achata e impede path traversal
    if (!base) continue;
    await fsp.writeFile(path.join(dest, base), await entry.async("nodebuffer"));
  }
  return dest;
});

ipcMain.handle("bs:uninstall", async (_e, id) => {
  const want = String(id).toLowerCase();
  for (const e of await fsp.readdir(importDir()).catch(() => [])) {
    if (e.toLowerCase().startsWith(want + " ") || e.toLowerCase() === want) {
      await shell.trashItem(path.join(importDir(), e)); // vai para a Lixeira
    }
  }
  return true;
});

// exclui uma musica baixada/importada (so dentro da pasta de musicas do app; vai para a Lixeira)
ipcMain.handle("songs:delete", async (_e, dir) => {
  const target = path.resolve(String(dir));
  const root = path.resolve(importDir());
  if (path.dirname(target) !== root) throw new Error("só músicas baixadas ou importadas pelo app podem ser excluídas aqui");
  await shell.trashItem(target);
  allowedSongDirs.delete(target);
  return true;
});
ipcMain.handle("songs:canDelete", async (_e, dir) => path.dirname(path.resolve(String(dir))) === path.resolve(importDir()));

ipcMain.handle("songs:dirs", async () => loadSettings().songDirs);
ipcMain.handle("songs:removeDir", async (_e, dir) => {
  const s = loadSettings();
  s.songDirs = s.songDirs.filter((d) => d !== dir);
  saveSettings(s);
  return s.songDirs;
});
ipcMain.handle("songs:openImportDir", async () => {
  await fsp.mkdir(importDir(), { recursive: true });
  return shell.openPath(importDir());
});

ipcMain.handle("prefs:get", async () => loadSettings().prefs || null);
ipcMain.handle("prefs:set", async (_e, prefs) => {
  const s = loadSettings();
  s.prefs = prefs;
  saveSettings(s);
  return true;
});
ipcMain.handle("app:toggleFullscreen", async () => {
  if (win) win.setFullScreen(!win.isFullScreen());
});
ipcMain.handle("app:quit", async () => app.quit());

// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1024,
    minHeight: 600,
    backgroundColor: "#05040f",
    title: "Win Saber",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  if (isDev) win.loadURL(process.env.WINSABER_DEV_URL);
  else win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

app.whenReady().then(() => {
  // so a webcam (e o microfone nao) e liberada, e so para a propria janela
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const media = details && details.mediaTypes ? details.mediaTypes : [];
    cb(permission === "media" && !media.includes("audio"));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
