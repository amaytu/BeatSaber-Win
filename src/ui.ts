// Telas de menu (HTML/CSS sobre a cena 3D): inicio, musicas, configuracoes,
// camera/calibracao e resultados.
import { DIFFICULTY_LABELS, DifficultyInfo, difficultyIndex } from "./core/map";
import { rankFromAccuracy } from "./core/score";
import * as audio from "./audio";
import { host, type BsMap, type BsSort } from "./host";
import { Song, coverUrl, getSongs, playableDifficulties, previewUrl, scanLibrary } from "./library";
import { prefs, savePrefs, defaultPrefs } from "./prefs";
import { HAND_CONNECTIONS, HandTracker, tracker } from "./tracking";
import type { PlayResult } from "./game/play";

export interface UiActions {
  play(song: Song, diff: DifficultyInfo): void;
  applyPrefs(): void;
  ensureCamera(): Promise<boolean>;
  /** troca o modo de controle (liga/desliga a camera conforme o modo) */
  setControlMode(mode: "camera" | "keyboard"): Promise<void>;
}

const ui = () => document.getElementById("ui")!;
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const diffColor = (d: DifficultyInfo) => `var(--diff-${difficultyIndex(d.difficulty)})`;
const diffLabel = (d: DifficultyInfo) => DIFFICULTY_LABELS[difficultyIndex(d.difficulty)] ?? d.difficulty;

let actions: UiActions;
let cleanupScreen: (() => void) | null = null;

export function initUi(a: UiActions) { actions = a; }

function mount(html: string, onCleanup?: () => void): HTMLElement {
  cleanupScreen?.();
  cleanupScreen = onCleanup ?? null;
  ui().innerHTML = html;
  return ui().firstElementChild as HTMLElement;
}

export function leaveScreen() {
  cleanupScreen?.();
  cleanupScreen = null;
  ui().innerHTML = "";
}

export function toast(msg: string) {
  const t = document.getElementById("toast")!;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout((t as unknown as { _h: number })._h);
  (t as unknown as { _h: number })._h = window.setTimeout(() => t.classList.remove("show"), 2600);
}

/** Navegacao por teclado entre botoes (setas) */
function keyNav(root: HTMLElement, onBack?: () => void) {
  const h = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT" && e.key !== "Escape") return;
    const btns = [...root.querySelectorAll<HTMLElement>("button.btn:not(:disabled)")];
    const i = btns.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowRight") { btns[(i + 1) % btns.length]?.focus(); e.preventDefault(); }
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") { btns[(i - 1 + btns.length) % btns.length]?.focus(); e.preventDefault(); }
    else if (e.key === "Escape" && onBack) { onBack(); e.preventDefault(); }
  };
  window.addEventListener("keydown", h);
  return () => window.removeEventListener("keydown", h);
}

// ---------------------------------------------------------------------------
// inicio
// ---------------------------------------------------------------------------
export function showMenu() {
  const songs = getSongs();
  const root = mount(`
    <div class="screen">
      <div class="logo"><span class="a">WIN</span> <span class="b">SABER</span></div>
      <div class="tagline">ritmo · luz · suas mãos</div>
      <div class="mode-switch" id="mode">
        <button data-mode="keyboard">⌨ Teclado</button>
        <button data-mode="camera">◉ Câmera</button>
      </div>
      <div class="menu panel">
        <button class="btn primary" data-a="play">Jogar</button>
        <button class="btn" data-a="download">Baixar músicas</button>
        <button class="btn" data-a="settings">Configurações</button>
        <button class="btn" data-a="quit">Sair</button>
      </div>
      <div class="chips" id="chips"></div>
      <div class="hints" id="menuHint"></div>
    </div>`, () => { clearInterval(timer); offKeys(); });
  const chips = root.querySelector("#chips")!;
  const hint = root.querySelector("#menuHint")!;
  const refresh = () => {
    const f = tracker.latest;
    const hands = f ? f.hands.filter(Boolean).length : 0;
    root.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.classList.toggle("sel", b.dataset.mode === prefs.controlMode));
    const control = prefs.controlMode === "keyboard"
      ? `<span class="chip ok">Teclado: W A S D · I J K L</span>`
      : `<span class="chip ${tracker.cameraActive ? "ok" : "warn"}">Câmera: ${tracker.cameraActive ? `${tracker.fps.toFixed(0)} fps (${tracker.delegate})` : "desligada"}</span>` +
        `<span class="chip ${hands === 2 ? "ok" : hands ? "warn" : "bad"}">Mãos: ${hands}/2</span>`;
    chips.innerHTML = control + `<span class="chip ${songs.length ? "info" : "warn"}">Músicas: ${songs.length}</span>`;
    hint.innerHTML = prefs.controlMode === "keyboard"
      ? "<b>Mouse</b> ou <b>setas + Enter</b> nos menus · no jogo: vermelhas <b>W A S D</b>, azuis <b>I J K L</b> (diagonal = 2 teclas)"
      : "<b>Mouse</b> ou <b>setas + Enter</b> nos menus · no jogo, corte com as mãos na frente da câmera";
  };
  refresh();
  const timer = window.setInterval(refresh, 500);
  const offKeys = keyNav(root);
  (root.querySelector("button") as HTMLElement).focus();
  root.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const mode = (t.closest("[data-mode]") as HTMLElement | null)?.dataset.mode as "camera" | "keyboard" | undefined;
    if (mode) {
      audio.sfxClick();
      await actions.setControlMode(mode);
      refresh();
      return;
    }
    const a = t.dataset.a;
    if (!a) return;
    audio.sfxClick();
    // Jogar abre a lista de musicas (a ultima jogada ja vem selecionada)
    if (a === "play") showSongs();
    else if (a === "download") showDownloads();
    else if (a === "settings") showSettings();
    else if (a === "quit") host.quit();
  });
}

// ---------------------------------------------------------------------------
// musicas
// ---------------------------------------------------------------------------
export function showSongs() {
  let list = getSongs();
  let filter = "";
  let selected = Math.max(0, list.findIndex((s) => s.id === prefs.lastSong));
  let diffSel = 0;
  let previewTimer = 0;
  let previewId = "";
  const root = mount(`
    <div class="screen dim">
      <h1 class="title">Músicas</h1><div class="underline"></div>
      <div class="songs-layout">
        <div class="panel song-list">
          <div class="song-tools">
            <input class="search" id="search" placeholder="Buscar música, artista ou mapper…" />
            <button class="btn small" data-a="download" title="Baixar músicas do BeatSaver">Baixar</button>
            <button class="btn small" data-a="import" title="Importar .zip do BeatSaver">+ .zip</button>
            <button class="btn small" data-a="folder" title="Adicionar pasta (ex.: CustomLevels)">+ pasta</button>
            <button class="btn small" data-a="rescan" title="Recarregar">⟳</button>
          </div>
          <div class="list" id="list"></div>
        </div>
        <div class="panel details" id="details"></div>
      </div>
      <div class="hints"><b>↑↓</b> música · <b>←→</b> dificuldade · <b>Enter</b> jogar · <b>Delete</b> excluir · <b>Esc</b> voltar</div>
    </div>`, () => { offKeys(); clearTimeout(previewTimer); audio.stopPreview(); });

  const listEl = root.querySelector("#list") as HTMLElement;
  const detailsEl = root.querySelector("#details") as HTMLElement;
  const search = root.querySelector("#search") as HTMLInputElement;

  const visible = () => {
    if (!filter) return list;
    const q = filter.toLowerCase();
    return list.filter((s) => `${s.info.songName} ${s.info.subName} ${s.info.artist} ${s.info.mapper}`.toLowerCase().includes(q));
  };

  const renderList = () => {
    const v = visible();
    if (!v.length) {
      listEl.innerHTML = `<div class="empty">${list.length ? "Nada encontrado." : "Nenhuma música ainda.<br>Use <b>+ .zip</b> para importar mapas baixados do BeatSaver<br>ou <b>+ pasta</b> para usar a pasta CustomLevels."}</div>`;
      detailsEl.innerHTML = "";
      return;
    }
    selected = Math.min(selected, v.length - 1);
    listEl.innerHTML = v.map((s, i) => {
      const diffs = playableDifficulties(s).filter((d) => d.characteristic === "Standard");
      return `<div class="song-item ${i === selected ? "sel" : ""}" data-i="${i}">
        <img class="thumb" data-cover="${i}" alt="" />
        <div class="txt"><div class="t">${esc(s.info.songName || "(sem nome)")}</div><div class="s">${esc(s.info.artist)}${s.info.mapper ? " · " + esc(s.info.mapper) : ""}</div></div>
        <div class="dots">${diffs.map((d) => `<i style="background:${diffColor(d)};box-shadow:0 0 6px ${diffColor(d)}"></i>`).join("")}</div>
      </div>`;
    }).join("");
    // capas sob demanda (so as visiveis)
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const img = en.target as HTMLImageElement;
        io.unobserve(img);
        const song = v[Number(img.dataset.cover)];
        coverUrl(song).then((u) => { if (u) img.src = u; });
      }
    }, { root: listEl });
    listEl.querySelectorAll("img[data-cover]").forEach((img) => io.observe(img));
    renderDetails();
  };

  const renderDetails = () => {
    const s = visible()[selected];
    if (!s) return;
    const diffs = playableDifficulties(s);
    diffSel = Math.min(diffSel, Math.max(0, diffs.length - 1));
    const lastIdx = diffs.findIndex((d) => s.id === prefs.lastSong && `${d.characteristic}/${d.difficulty}` === prefs.lastDiff);
    detailsEl.innerHTML = `
      <img class="cover" id="cover" alt="" />
      <h2>${esc(s.info.songName)}</h2>
      ${s.info.subName ? `<div class="sub">${esc(s.info.subName)}</div>` : ""}
      <div class="artist">${esc(s.info.artist)}</div>
      <div class="meta"><div><small>BPM</small><span>${Math.round(s.info.bpm)}</span></div>
        <div><small>MAPPER</small><span>${esc(s.info.mapper || "?")}</span></div>
        <div><small>FORMATO</small><span>v${s.info.version}</span></div></div>
      <div class="diffs">${diffs.map((d, i) => `
        <div class="diff ${i === diffSel ? "sel" : ""}" data-d="${i}" style="color:${diffColor(d)}">
          <div class="bar"></div><div class="name" style="color:var(--text)">${esc(diffLabel(d))}</div>
          <div class="info">${d.characteristic !== "Standard" ? esc(d.characteristic) + " · " : ""}NJS ${(d.njs || 0).toFixed(1)}${i === lastIdx ? " · último" : ""}</div>
        </div>`).join("")}</div>
      <button class="btn primary" style="margin-top:16px;width:100%" data-a="play" ${diffs.length ? "" : "disabled"}>Jogar</button>
      <button class="btn small" style="margin-top:10px" data-a="delete" hidden title="Vai para a Lixeira">Excluir música</button>`;
    // so musicas baixadas/importadas pelo app (pastas externas, como CustomLevels, ficam intocadas)
    host.canDeleteSong(s.dir).then((ok) => {
      const b = detailsEl.querySelector("[data-a=delete]") as HTMLElement | null;
      if (b && ok && visible()[selected] === s) b.hidden = false;
    });
    coverUrl(s).then((u) => { const img = detailsEl.querySelector("#cover") as HTMLImageElement | null; if (u && img) img.src = u; });
    // previa: a anterior para na hora; a nova comeca logo que o cursor para (120 ms
    // evita trocar a cada musica ao segurar a seta)
    clearTimeout(previewTimer);
    if (previewId !== s.id) {
      audio.stopPreview();
      previewId = s.id;
      previewTimer = window.setTimeout(() => {
        audio.startPreview(() => previewUrl(s), s.info.previewStart, s.info.previewDuration);
      }, 120);
      // ja deixa o audio das vizinhas pronto
      const v = visible();
      for (const k of [selected - 1, selected + 1]) if (v[k]) previewUrl(v[k]);
    }
  };

  const select = (i: number) => {
    const n = visible().length;
    if (!n) return;
    selected = (i + n) % n;
    diffSel = 0;
    listEl.querySelectorAll(".song-item").forEach((el, k) => el.classList.toggle("sel", k === selected));
    listEl.querySelector(".song-item.sel")?.scrollIntoView({ block: "nearest" });
    renderDetails();
  };

  const play = () => {
    const s = visible()[selected];
    if (!s) return;
    const d = playableDifficulties(s)[diffSel];
    if (!d) return;
    prefs.lastSong = s.id;
    prefs.lastDiff = `${d.characteristic}/${d.difficulty}`;
    savePrefs();
    actions.play(s, d);
  };

  const rescan = async () => {
    list = await scanLibrary();
    renderList();
  };

  root.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    const item = t.closest(".song-item") as HTMLElement | null;
    const diff = t.closest(".diff") as HTMLElement | null;
    const a = t.closest("[data-a]") as HTMLElement | null;
    if (item) { audio.sfxClick(); select(Number(item.dataset.i)); }
    else if (diff) { audio.sfxClick(); diffSel = Number(diff.dataset.d); renderDetails(); }
    else if (a?.dataset.a === "play") play();
    else if (a?.dataset.a === "download") showDownloads();
    else if (a?.dataset.a === "import") { const n = await host.importZips(); if (n) { toast(`${n} mapa(s) importado(s)`); await rescan(); } }
    else if (a?.dataset.a === "folder") { const d = await host.addSongFolder(); if (d) { toast("Pasta adicionada"); await rescan(); } }
    else if (a?.dataset.a === "delete") {
      const s = visible()[selected];
      if (!s || !confirm(`Excluir "${s.info.songName}"?\n\nA pasta vai para a Lixeira.`)) return;
      clearTimeout(previewTimer);
      audio.stopPreview();
      previewId = "";
      try {
        await host.deleteSong(s.dir);
        toast(`"${s.info.songName}" excluída`);
        if (prefs.lastSong === s.id) { prefs.lastSong = ""; prefs.lastDiff = ""; savePrefs(); }
        await rescan();
      } catch (err) {
        toast(`Não foi possível excluir: ${(err as Error).message}`);
      }
    }
    else if (a?.dataset.a === "rescan") { await rescan(); toast(`${list.length} música(s)`); }
  });
  root.addEventListener("dblclick", (e) => { if ((e.target as HTMLElement).closest(".song-item, .diff")) play(); });
  search.addEventListener("input", () => { filter = search.value.trim(); selected = 0; renderList(); });
  const offKeys = (() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") { audio.sfxClick(); showMenu(); return; }
      if (e.key === "Delete" && document.activeElement !== search) {
        const b = detailsEl.querySelector("[data-a=delete]") as HTMLButtonElement | null;
        if (b && !b.hidden) b.click();
        return;
      }
      if (document.activeElement === search && !["ArrowUp", "ArrowDown", "Enter"].includes(e.key)) return;
      if (e.key === "ArrowDown") { select(selected + 1); e.preventDefault(); }
      else if (e.key === "ArrowUp") { select(selected - 1); e.preventDefault(); }
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const s = visible()[selected];
        const n = s ? playableDifficulties(s).length : 0;
        if (n) { diffSel = (diffSel + (e.key === "ArrowRight" ? 1 : -1) + n) % n; renderDetails(); }
        e.preventDefault();
      } else if (e.key === "Enter") { play(); e.preventDefault(); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  })();
  renderList();
}

// ---------------------------------------------------------------------------
// configuracoes
// ---------------------------------------------------------------------------
interface SliderDef { key: keyof typeof prefs; label: string; help: string; min: number; max: number; step: number; fmt: (v: number) => string }

const SLIDERS: SliderDef[] = [
  { key: "predictionMs", label: "Antecipação do sabre", help: "O sabre é desenhado onde a mão vai estar. Mais = menos atraso visível (mas pode passar do ponto ao parar).", min: 0, max: 120, step: 5, fmt: (v) => `${v} ms` },
  { key: "inputLatencyMs", label: "Latência da câmera", help: "Atraso da webcam + rastreamento. Aumente se os cortes parecerem atrasados.", min: 0, max: 250, step: 5, fmt: (v) => `${v} ms` },
  { key: "audioOffsetMs", label: "Offset de áudio", help: "Positivo atrasa as notas em relação à música (fones Bluetooth costumam pedir ~150 ms).", min: -300, max: 400, step: 5, fmt: (v) => `${v > 0 ? "+" : ""}${v} ms` },
  { key: "swingThreshold", label: "Velocidade mínima do corte", help: "Menor = cortes registram com movimentos mais lentos.", min: 100, max: 500, step: 10, fmt: (v) => String(v) },
  { key: "directionTolerance", label: "Tolerância de direção", help: "Desvio máximo entre o movimento da mão e a seta.", min: 30, max: 90, step: 5, fmt: (v) => `${v}°` },
  { key: "smoothing", label: "Resposta do rastreamento", help: "Menor = mais suave (menos tremida); maior = acompanha movimentos rápidos mais de perto.", min: 0.3, max: 3, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: "musicVolume", label: "Volume da música", help: "", min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "sfxVolume", label: "Volume dos efeitos", help: "", min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "bloom", label: "Brilho neon (bloom)", help: "Reduza se o computador ficar lento.", min: 0, max: 2, step: 0.1, fmt: (v) => v.toFixed(1) },
];

export function showSettings() {
  const p = prefs as unknown as Record<string, number | boolean>;
  const root = mount(`
    <div class="screen dim">
      <h1 class="title">Configurações</h1><div class="underline"></div>
      <div class="panel settings">
        <div class="section">Tela e câmera</div>
        <div class="row"><label>Câmera e calibração<small>Escolher a câmera e ajustar a área de jogo às suas mãos.</small></label><button class="btn small" data-a="calib">Abrir</button></div>
        <div class="row"><label>Tela cheia<small>Também pela tecla F11 em qualquer tela.</small></label><button class="btn small" data-a="fullscreen">Alternar</button></div>
        <div class="section">Jogo</div>
        ${SLIDERS.map((s) => `<div class="row"><label>${s.label}${s.help ? `<small>${s.help}</small>` : ""}</label>
          <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${p[s.key]}" data-k="${s.key}"><span class="val" id="v-${s.key}">${s.fmt(p[s.key] as number)}</span></div>`).join("")}
        <div class="row"><label>Gráficos<small>Desempenho: sem brilho pós-processado, ideal para notebooks. Use Qualidade só com placa de vídeo dedicada.</small></label>
          <select data-sel="quality"><option value="0">Desempenho</option><option value="1">Equilíbrio</option><option value="2">Qualidade</option></select></div>
        <div class="row"><label>Assistência de posição<small>Livre: só direção e tempo contam. Rígida: a mão precisa passar pelo cubo.</small></label>
          <select data-sel="positionAssist"><option value="0">Livre</option><option value="1">Normal</option><option value="2">Rígida</option></select></div>
        <div class="row"><label>Diagonais fáceis (teclado)<small>Nota diagonal aceita só uma das duas teclas, e nota reta aceita a diagonal que a contém.</small></label><input type="checkbox" data-b="lenientDiagonals"></div>
        <div class="row"><label>No Fail<small>Não perde quando a energia acaba.</small></label><input type="checkbox" data-b="noFail"></div>
        <div class="row"><label>Mostrar câmera no canto</label><input type="checkbox" data-b="showCamera"></div>
        <div class="row"><label>Trocar mãos<small>Use se o sabre vermelho seguir a mão direita.</small></label><input type="checkbox" data-b="swapHands"></div>
        <div class="section">Pastas de músicas</div>
        <div id="dirs"></div>
        <div class="row"><button class="btn small" data-a="addDir">Adicionar pasta</button><button class="btn small" data-a="openImport">Abrir pasta de importados</button><span style="flex:1"></span><button class="btn small" data-a="defaults">Restaurar padrões</button></div>
      </div>
      <div class="hints"><b>Esc</b> salvar e voltar</div>
    </div>`, () => offKeys());
  (root.querySelector("[data-sel=positionAssist]") as HTMLSelectElement).value = String(prefs.positionAssist);
  (root.querySelector("[data-sel=quality]") as HTMLSelectElement).value = String(prefs.quality);
  root.querySelectorAll<HTMLInputElement>("input[data-b]").forEach((i) => (i.checked = !!p[i.dataset.b!]));

  const dirsEl = root.querySelector("#dirs")!;
  const renderDirs = async () => {
    const dirs = await host.songDirs();
    dirsEl.innerHTML = dirs.map((d) => `<div class="row"><label style="font-weight:400;font-size:13px;word-break:break-all">${esc(d)}</label><button class="btn small" data-rm="${esc(d)}">Remover</button></div>`).join("");
  };
  renderDirs();

  root.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.k) {
      const def = SLIDERS.find((s) => s.key === t.dataset.k)!;
      p[def.key] = Number(t.value);
      root.querySelector(`#v-${def.key}`)!.textContent = def.fmt(Number(t.value));
    } else if (t.dataset.b) p[t.dataset.b] = t.checked;
    else if ((t as unknown as HTMLSelectElement).dataset.sel === "positionAssist") prefs.positionAssist = Number(t.value) as 0 | 1 | 2;
    else if ((t as unknown as HTMLSelectElement).dataset.sel === "quality") prefs.quality = Number(t.value) as 0 | 1 | 2;
    savePrefs();
    actions.applyPrefs();
  });
  root.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.a === "calib") { audio.sfxClick(); showCalibration(); return; }
    if (t.dataset.a === "fullscreen") { host.toggleFullscreen(); return; }
    if (t.dataset.rm) { await host.removeSongDir(t.dataset.rm); await renderDirs(); await scanLibrary(); }
    else if (t.dataset.a === "addDir") { if (await host.addSongFolder()) { await renderDirs(); await scanLibrary(); } }
    else if (t.dataset.a === "openImport") host.openImportDir();
    else if (t.dataset.a === "defaults") {
      const keep = { cameraId: prefs.cameraId, lastSong: prefs.lastSong, lastDiff: prefs.lastDiff, areaCx: prefs.areaCx, areaCy: prefs.areaCy, areaW: prefs.areaW, areaH: prefs.areaH };
      Object.assign(prefs, defaultPrefs(), keep);
      savePrefs();
      actions.applyPrefs();
      showSettings();
    }
  });
  const offKeys = keyNav(root, () => { audio.sfxClick(); showMenu(); });
}

// ---------------------------------------------------------------------------
// camera e calibracao da area de jogo
// ---------------------------------------------------------------------------
export function drawCamera(canvas: HTMLCanvasElement, showArea: boolean) {
  const v = tracker.video;
  if (!v.videoWidth) return;
  // a previa do canto e pequena: desenha em baixa resolucao para nao competir com o jogo
  const scale = showArea ? 1 : 320 / v.videoWidth;
  const cw = Math.round(v.videoWidth * scale), ch = Math.round(v.videoHeight * scale);
  if (canvas.width !== cw) { canvas.width = cw; canvas.height = ch; }
  const g = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height;
  g.save();
  g.translate(W, 0);
  g.scale(-1, 1); // espelho: o jogador se ve como num espelho
  g.drawImage(v, 0, 0, W, H);
  g.restore();
  g.fillStyle = "rgba(5,3,18,.35)";
  g.fillRect(0, 0, W, H);
  if (showArea) {
    const x = (prefs.areaCx - prefs.areaW / 2) * W, y = (prefs.areaCy - prefs.areaH / 2) * H;
    const w = prefs.areaW * W, h = prefs.areaH * H;
    g.strokeStyle = "rgba(190,170,255,.9)";
    g.lineWidth = 3;
    g.setLineDash([12, 8]);
    g.strokeRect(x, y, w, h);
    g.setLineDash([]);
    // grade 4x3 das notas (lanes 0..4 -> 0.5..4.5 da area)
    g.strokeStyle = "rgba(150,130,255,.35)";
    g.lineWidth = 1.5;
    for (let i = 0; i <= 4; i++) { const gx = x + ((i + 0.5) / 5) * w; g.beginPath(); g.moveTo(gx, y + h * 0.125); g.lineTo(gx, y + h * 0.875); g.stroke(); }
    for (let j = 0; j <= 3; j++) { const gy = y + ((j + 0.5) / 4) * h; g.beginPath(); g.moveTo(x + w * 0.1, gy); g.lineTo(x + w * 0.9, gy); g.stroke(); }
  }
  const f = tracker.latest;
  if (!f) return;
  f.hands.forEach((hand, i) => {
    if (!hand) return;
    const c = i === 0 ? "#ff3b62" : "#3ba2ff";
    g.strokeStyle = c;
    g.fillStyle = c;
    g.lineWidth = 3;
    g.lineWidth = showArea ? 3 : 2;
    for (const [a, b] of HAND_CONNECTIONS) {
      g.beginPath();
      g.moveTo(hand.landmarks[a].x * W, hand.landmarks[a].y * H);
      g.lineTo(hand.landmarks[b].x * W, hand.landmarks[b].y * H);
      g.stroke();
    }
    g.beginPath();
    g.arc(hand.img.x * W, hand.img.y * H, showArea ? 12 : 6, 0, Math.PI * 2);
    g.fill();
  });
}

export async function showCalibration() {
  const root = mount(`
    <div class="screen dim">
      <h1 class="title">Câmera e calibração</h1><div class="underline"></div>
      <div class="calib">
        <div class="panel view"><canvas id="calibCanvas"></canvas></div>
        <div class="panel side">
          <p>Fique a uns <b>1,5–2 m</b> da câmera, com o tronco e as duas mãos aparecendo. O retângulo tracejado é a área de jogo: ele vira a grade 4×3 das notas.</p>
          <p>Abra os braços na altura do peito e clique em <b>Centralizar nas mãos</b> (ou aperte <b>C</b>; você tem 3 s para se posicionar).</p>
          <div class="row"><label>Câmera</label><select id="camSel"></select></div>
          <div class="row"><label>Largura da área</label><input type="range" min="0.25" max="1" step="0.01" id="aw"></div>
          <div class="row"><label>Altura da área</label><input type="range" min="0.2" max="1" step="0.01" id="ah"></div>
          <button class="btn" data-a="center">Centralizar nas mãos</button>
          <button class="btn small" data-a="reset">Área padrão</button>
          <div class="status-line" id="st"></div>
          <span style="flex:1"></span>
          <button class="btn" data-a="back">Voltar</button>
        </div>
      </div>
    </div>`, () => {
      cancelAnimationFrame(raf); offKeys(); clearTimeout(countdown);
      if (prefs.controlMode === "keyboard") tracker.stopCamera(); // no teclado a camera so liga para calibrar
    });
  const canvas = root.querySelector("#calibCanvas") as HTMLCanvasElement;
  const st = root.querySelector("#st") as HTMLElement;
  const aw = root.querySelector("#aw") as HTMLInputElement, ah = root.querySelector("#ah") as HTMLInputElement;
  aw.value = String(prefs.areaW);
  ah.value = String(prefs.areaH);
  let raf = 0, countdown = 0, countEnd = 0;
  const loop = () => {
    drawCamera(canvas, true);
    if (countEnd) {
      const left = Math.ceil((countEnd - performance.now()) / 1000);
      const g = canvas.getContext("2d")!;
      g.font = "800 120px 'Exo 2'";
      g.textAlign = "center";
      g.fillStyle = "#fff";
      g.fillText(String(Math.max(1, left)), canvas.width / 2, canvas.height / 2);
    }
    const f = tracker.latest;
    const hands = f ? f.hands.filter(Boolean).length : 0;
    st.innerHTML = tracker.cameraActive
      ? `<span class="chip ${hands === 2 ? "ok" : "warn"}">Mãos: ${hands}/2</span> <span class="chip info">${tracker.fps.toFixed(0)} fps · ${tracker.detectMs.toFixed(0)} ms · ${tracker.delegate}</span>`
      : `<span class="chip bad">Câmera desligada</span>`;
    raf = requestAnimationFrame(loop);
  };
  loop();

  const camSel = root.querySelector("#camSel") as HTMLSelectElement;
  const ok = await actions.ensureCamera();
  const cams = await HandTracker.listCameras();
  camSel.innerHTML = cams.map((c, i) => `<option value="${esc(c.deviceId)}">${esc(c.label || `Câmera ${i + 1}`)}</option>`).join("");
  camSel.value = prefs.cameraId || (cams[0]?.deviceId ?? "");
  camSel.addEventListener("change", async () => {
    prefs.cameraId = camSel.value;
    savePrefs();
    await tracker.startCamera().catch((e) => toast("Falha ao abrir a câmera: " + e.message));
  });
  if (!ok) toast("Não foi possível abrir a câmera.");

  const center = () => {
    const f = tracker.latest;
    const hs = f ? f.hands.filter((h): h is NonNullable<typeof h> => !!h) : [];
    if (!hs.length) { toast("Nenhuma mão visível."); return; }
    const cx = hs.reduce((a, h) => a + h.img.x, 0) / hs.length;
    const cy = hs.reduce((a, h) => a + h.img.y, 0) / hs.length;
    prefs.areaCx = Math.min(0.9, Math.max(0.1, cx));
    prefs.areaCy = Math.min(0.9, Math.max(0.1, cy));
    if (hs.length === 2) {
      // bracos abertos ~ bordas da grade (lanes 0 e 4)
      const span = Math.abs(hs[0].img.x - hs[1].img.x);
      prefs.areaW = Math.min(1, Math.max(0.25, span * 1.25));
      aw.value = String(prefs.areaW);
    }
    savePrefs();
    audio.sfxClick();
    toast("Área centralizada");
  };
  const startCountdown = () => {
    countEnd = performance.now() + 3000;
    clearTimeout(countdown);
    countdown = window.setTimeout(() => { countEnd = 0; center(); }, 3000);
  };
  root.addEventListener("input", () => { prefs.areaW = Number(aw.value); prefs.areaH = Number(ah.value); savePrefs(); });
  root.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).dataset.a;
    if (a === "center") startCountdown();
    else if (a === "reset") {
      const d = defaultPrefs();
      Object.assign(prefs, { areaCx: d.areaCx, areaCy: d.areaCy, areaW: d.areaW, areaH: d.areaH });
      aw.value = String(prefs.areaW);
      ah.value = String(prefs.areaH);
      savePrefs();
    } else if (a === "back") { audio.sfxClick(); showSettings(); }
  });
  const offKeys = (() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") showSettings();
      else if (e.key.toLowerCase() === "c") startCountdown();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  })();
}

// ---------------------------------------------------------------------------
// resultados
// ---------------------------------------------------------------------------
export function showResults(r: PlayResult, retry: () => void) {
  const s = r.score;
  const acc = r.map.maxScore ? s.score / r.map.maxScore : 0;
  const rank = r.failed ? "F" : rankFromAccuracy(acc);
  const rc = r.failed ? "#ff4a64" : rank.startsWith("S") ? "#ffd75a" : rank === "A" || rank === "B" ? "#6ec8ff" : "#e690a8";
  const total = r.map.notes.filter((n) => n.kind !== 1).length;
  const root = mount(`
    <div class="screen dim">
      <h1 class="title">${r.failed ? "GAME OVER" : "NÍVEL CONCLUÍDO"}</h1><div class="underline"></div>
      <div style="color:#d8d6ff;font-size:18px;margin-bottom:16px">${esc(r.song.info.songName)} <span style="color:#9a98c8">[${esc(diffLabel(r.diff))}]</span></div>
      <div class="panel results">
        <div>
          <div class="rank-ring"><svg viewBox="0 0 100 100">
            <circle cx="50" cy="50" r="44" fill="none" stroke="rgba(120,110,200,.25)" stroke-width="5"/>
            <circle cx="50" cy="50" r="44" fill="none" stroke="${rc}" stroke-width="5" stroke-linecap="round" stroke-dasharray="276.5" stroke-dashoffset="${276.5 * (1 - acc)}" style="filter:drop-shadow(0 0 4px ${rc})"/>
          </svg><div class="r" style="color:${rc};text-shadow:0 0 18px ${rc},0 0 40px ${rc}">${rank}</div></div>
          <div style="text-align:center;font-size:34px;font-weight:800;margin-top:8px">${s.score.toLocaleString("pt-BR")}</div>
          <div style="text-align:center;color:#b9b8e4">Precisão ${(acc * 100).toFixed(2)}%</div>
        </div>
        <div class="stats">
          <span>Notas acertadas</span><span style="color:var(--ok)">${s.goodCuts} / ${total}</span>
          <span>Notas perdidas</span><span style="color:var(--warn)">${s.misses}</span>
          <span>Cortes errados</span><span style="color:var(--bad)">${s.badCuts}</span>
          <span>Bombas atingidas</span><span style="color:var(--bad)">${s.bombsHit}</span>
          <span>Combo máximo</span><span>${s.maxCombo}</span>
          <span>Média por corte (115)</span><span>${s.cutCount ? (s.totalCutScore / s.cutCount).toFixed(1) : "0"}</span>
          <span>Energia final</span><span>${Math.round(s.energy * 100)}%</span>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn" data-a="retry">${r.failed ? "Tentar de novo" : "Jogar de novo"}</button>
        <button class="btn primary" data-a="songs">Continuar</button>
      </div>
      <div class="hints"><b>Enter</b> continuar · <b>R</b> repetir</div>
    </div>`, () => offKeys());
  (root.querySelector("[data-a=songs]") as HTMLElement).focus();
  root.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).dataset.a;
    if (a === "retry") retry();
    else if (a === "songs") showSongs();
  });
  const offKeys = (() => {
    const h = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "r") retry();
      else if (e.key === "Escape") showSongs();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  })();
}

// ---------------------------------------------------------------------------
// baixar musicas do BeatSaver (API publica)
// ---------------------------------------------------------------------------
const SORTS: { key: BsSort; label: string }[] = [
  { key: "Rating", label: "Mais bem avaliadas" },
  { key: "Latest", label: "Recentes" },
  { key: "Curated", label: "Curadas" },
  { key: "Relevance", label: "Relevância" },
];
const DIFF_ORDER = ["Easy", "Normal", "Hard", "Expert", "ExpertPlus"];
// dificuldade pela densidade de notas (notas por segundo de alguma dificuldade do mapa)
const NPS_LEVELS: { label: string; min: number; max: number }[] = [
  { label: "Todas", min: 0, max: 0 },
  { label: "Leve (até 3 notas/s)", min: 0, max: 3 },
  { label: "Média (3–5 notas/s)", min: 3, max: 5 },
  { label: "Difícil (5–7 notas/s)", min: 5, max: 7 },
  { label: "Insana (7+ notas/s)", min: 7, max: 0 },
];
/**
 * Densidade das dificuldades Standard. Sem filtro: a faixa do mapa ("2.1–6.8 notas/s").
 * Com filtro: quais dificuldades se encaixam ("Easy 1.9 · Normal 2.7 notas/s").
 */
function npsRange(m: BsMap, lv: { min: number; max: number }): string {
  const std = m.diffs.filter((d) => d.characteristic === "Standard" && d.nps > 0)
    .sort((a, b) => DIFF_ORDER.indexOf(a.difficulty) - DIFF_ORDER.indexOf(b.difficulty));
  if (!std.length) return "";
  if (lv.min > 0 || lv.max > 0) {
    const fit = std.filter((d) => d.nps >= lv.min && (lv.max <= 0 || d.nps <= lv.max));
    if (fit.length) return "✓ " + fit.map((d) => `${d.difficulty === "ExpertPlus" ? "Expert+" : d.difficulty} ${d.nps.toFixed(1)}`).join(" · ") + " notas/s";
  }
  const lo = Math.min(...std.map((d) => d.nps)), hi = Math.max(...std.map((d) => d.nps));
  return lo === hi ? `${lo.toFixed(1)} notas/s` : `${lo.toFixed(1)}–${hi.toFixed(1)} notas/s`;
}
const fmtDur = (s: number) => (s > 0 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");

export function showDownloads() {
  let sort: BsSort = "Rating";
  let query = "";
  let page = 0;
  let maps: BsMap[] = [];
  let loading = false;
  let hideMods = true;
  let level = 0; // indice em NPS_LEVELS
  let preview: HTMLAudioElement | null = null;
  let previewId = "";
  let changed = false; // instalou/removeu algo: recarrega a biblioteca ao sair
  const root = mount(`
    <div class="screen dim">
      <h1 class="title">Baixar músicas</h1><div class="underline"></div>
      <div class="dl-bar">
        <input class="search" id="q" placeholder="Buscar no BeatSaver (música, artista, mapper)…" style="min-width:280px" />
        <div class="dl-tabs">${SORTS.map((s) => `<button class="btn small ${s.key === sort ? "sel" : ""}" data-sort="${s.key}">${s.label}</button>`).join("")}</div>
        <select id="level" class="search" style="flex:none;width:auto;padding:7px 10px" title="Dificuldade">${NPS_LEVELS.map((l, i) => `<option value="${i}">${l.label}</option>`).join("")}</select>
        <label style="font-size:13px;color:#b9b6e2;display:flex;gap:6px;align-items:center"><input type="checkbox" id="mods" checked style="accent-color:var(--violet)"> Esconder mapas que precisam de mods</label>
        <span style="flex:1"></span>
        <button class="btn small" data-a="back">Voltar</button>
      </div>
      <div class="dl-grid" id="grid"></div>
      <div class="hints">Mapas do <b>beatsaver.com</b> · a lista de músicas é atualizada ao sair · <b>Esc</b> voltar</div>
    </div>`, () => { offKeys(); stopPreview(); if (changed) scanLibrary(); });
  const grid = root.querySelector("#grid") as HTMLElement;
  const q = root.querySelector("#q") as HTMLInputElement;

  const stopPreview = () => { preview?.pause(); preview = null; previewId = ""; };

  const card = (m: BsMap) => {
    const total = m.upvotes + m.downvotes;
    const pct = total ? Math.round((m.upvotes / total) * 100) : 0;
    const std = m.diffs.filter((d) => d.characteristic === "Standard").sort((a, b) => DIFF_ORDER.indexOf(a.difficulty) - DIFF_ORDER.indexOf(b.difficulty));
    const dots = std.map((d) => `<i style="background:var(--diff-${Math.max(0, DIFF_ORDER.indexOf(d.difficulty))})"></i>`).join("");
    const tag = m.needsMods ? `<span class="tag">precisa de mods</span>` : m.automapper ? `<span class="tag">gerado por IA</span>` : "";
    return `<div class="panel card" data-id="${esc(m.id)}">
      <img src="${esc(m.coverURL)}" alt="" loading="lazy" />
      <div class="info">
        <div class="t" title="${esc(m.songName)}">${esc(m.songName)}</div>
        <div class="a">${esc(m.artist)}</div>
        <div class="m">${esc(m.mapper)} · ${fmtDur(m.duration)} · ${Math.round(m.bpm)} BPM ${tag}</div>
        <div class="m" title="Notas por segundo de cada dificuldade">${npsRange(m, NPS_LEVELS[level])}</div>
        <div class="dots" style="margin-top:2px">${dots}</div>
        <div class="actions">
          <button class="btn small" data-act="preview">${previewId === m.id ? "■ Parar" : "▶ Ouvir"}</button>
          ${m.installed
            ? `<span class="chip ok">✓ Instalada</span><button class="btn small" data-act="remove" title="Vai para a Lixeira">Excluir</button>`
            : `<button class="btn small primary" data-act="install">Instalar</button>`}
          <span class="rating">▲ ${pct}%</span>
        </div>
      </div>
    </div>`;
  };

  const render = () => {
    const visible = hideMods ? maps.filter((m) => !m.needsMods && !m.automapper) : maps;
    grid.innerHTML = visible.map(card).join("") +
      (loading ? `<div class="empty dl-more">Carregando…</div>`
        : maps.length ? `<button class="btn small dl-more" data-act="more">Carregar mais</button>`
        : `<div class="empty dl-more">Nada encontrado.</div>`);
  };

  const load = async (reset: boolean) => {
    if (loading) return;
    if (reset) { page = 0; maps = []; grid.scrollTop = 0; }
    loading = true;
    render();
    try {
      const lv = NPS_LEVELS[level];
      const got = await host.searchBeatSaver(query, sort, page, lv.min, lv.max);
      const seen = new Set(maps.map((m) => m.id));
      maps = maps.concat(got.filter((m) => !seen.has(m.id)));
      page++;
    } catch (e) {
      toast(`Falha ao acessar o BeatSaver: ${(e as Error).message}`);
    }
    loading = false;
    render();
    // o filtro de mods pode deixar a pagina quase vazia (sem rolagem para carregar mais)
    const shown = hideMods ? maps.filter((m) => !m.needsMods && !m.automapper).length : maps.length;
    if (shown < 12 && page < 6 && maps.length >= page * 20) load(false);
  };

  const setSort = (s: BsSort) => {
    sort = s;
    root.querySelectorAll("[data-sort]").forEach((b) => b.classList.toggle("sel", (b as HTMLElement).dataset.sort === sort));
  };

  root.addEventListener("click", async (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.a === "back") { audio.sfxClick(); showMenu(); return; }
    if (t.dataset.sort) { setSort(t.dataset.sort as BsSort); load(true); return; }
    const act = t.dataset.act;
    if (act === "more") { load(false); return; }
    const id = (t.closest(".card") as HTMLElement | null)?.dataset.id;
    const m = maps.find((x) => x.id === id);
    if (!m || !act) return;
    if (act === "preview") {
      if (previewId === m.id) stopPreview();
      else {
        stopPreview();
        audio.stopPreview();
        preview = new Audio(m.previewURL);
        preview.volume = Math.min(1, prefs.musicVolume);
        preview.play().catch(() => toast("Prévia indisponível."));
        previewId = m.id;
      }
      render();
    } else if (act === "install") {
      (t as HTMLButtonElement).disabled = true;
      t.textContent = "Baixando…";
      try {
        await host.installBeatSaver(m.id, m.downloadURL, `${m.artist} - ${m.songName} - ${m.mapper}`);
        m.installed = true;
        changed = true;
        audio.sfxClick();
        toast(`"${m.songName}" instalada`);
      } catch (err) {
        toast(`Falha ao instalar: ${(err as Error).message}`);
      }
      render();
    } else if (act === "remove") {
      if (!confirm(`Excluir "${m.songName}"?\n\nA pasta vai para a Lixeira.`)) return;
      await host.uninstallBeatSaver(m.id);
      m.installed = false;
      changed = true;
      render();
    }
  });
  let searchTimer = 0;
  q.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      query = q.value.trim();
      if (query && sort === "Rating") setSort("Relevance");
      load(true);
    }, 400);
  });
  (root.querySelector("#level") as HTMLSelectElement).addEventListener("change", (e) => {
    level = Number((e.target as HTMLSelectElement).value);
    load(true);
  });
  (root.querySelector("#mods") as HTMLInputElement).addEventListener("change", (e) => { hideMods = (e.target as HTMLInputElement).checked; render(); });
  grid.addEventListener("scroll", () => { if (grid.scrollTop + grid.clientHeight > grid.scrollHeight - 300) load(false); });
  const offKeys = (() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && document.activeElement !== q) { audio.sfxClick(); showMenu(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  })();
  load(true);
}
