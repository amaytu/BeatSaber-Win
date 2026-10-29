// Ponto de entrada: cena 3D sempre ativa ao fundo, rastreamento das maos,
// biblioteca de musicas e troca de telas.
import * as audio from "./audio";
import { DifficultyInfo } from "./core/map";
import { HandSaber } from "./core/saber";
import { GameScene } from "./game/scene";
import { Gameplay, PlayResult } from "./game/play";
import { Song, scanLibrary } from "./library";
import { host } from "./host";
import { loadPrefs, prefs, savePrefs } from "./prefs";
import { tracker } from "./tracking";
import { drawCamera, initUi, leaveScreen, showMenu, showResults, showSongs, toast } from "./ui";

const canvas = document.getElementById("gl") as HTMLCanvasElement;
const scene = new GameScene(canvas);
const camBox = document.getElementById("cam")!;
const camCanvas = document.getElementById("camCanvas") as HTMLCanvasElement;
const camInfo = document.getElementById("camInfo")!;

// nos menus os sabres seguem as maos (feedback imediato de que a camera funciona)
const menuSabers = [new HandSaber(), new HandSaber()];
tracker.on((f) => {
  if (!game) f.hands.forEach((h, i) => menuSabers[i].update(h ? h.grid : null, f.dt, h?.gridVel, f.time));
  if (prefs.showCamera && (game || !document.getElementById("calibCanvas"))) {
    drawCamera(camCanvas, false);
    camInfo.textContent = `${tracker.fps.toFixed(0)} fps · ${tracker.detectMs.toFixed(0)} ms · ${tracker.delegate}`;
  }
});

let game: Gameplay | null = null;
let lastSong: { song: Song; diff: DifficultyInfo } | null = null;

function resize() {
  scene.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);
// F11: tela cheia em qualquer tela
window.addEventListener("keydown", (e) => {
  if (e.key === "F11") { e.preventDefault(); host.toggleFullscreen(); }
});
resize();

let last = performance.now();
function loop(now: number) {
  // agenda o proximo quadro primeiro: um erro neste quadro nao pode parar o jogo
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  try {
    if (game) game.frame(dt);
    else scene.update(now / 1000, dt, null, 0, menuSabers);
    camBox.classList.toggle("hidden", !prefs.showCamera || !tracker.cameraActive || !!document.getElementById("calibCanvas"));
    scene.render();
  } catch (e) {
    console.error("erro no quadro", e);
  }
}

// o modelo de maos so e carregado na primeira vez que o modo camera e usado
let trackerReady: Promise<boolean> | null = null;
function ensureTracker(onStatus?: (m: string) => void): Promise<boolean> {
  if (!trackerReady) {
    trackerReady = tracker.init(onStatus).then(
      () => true,
      (e) => {
        console.error(e);
        trackerReady = null;
        toast("Falha ao carregar o rastreamento de mãos.");
        return false;
      },
    );
  }
  return trackerReady;
}

async function ensureCamera(): Promise<boolean> {
  if (!(await ensureTracker())) return false;
  if (tracker.cameraActive) return true;
  try {
    await tracker.startCamera();
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

async function setControlMode(mode: "camera" | "keyboard") {
  prefs.controlMode = mode;
  savePrefs();
  if (mode === "camera") {
    toast("Modo câmera: ligando a câmera…");
    if (!(await ensureCamera())) toast("Não foi possível abrir a câmera. Verifique em Configurações → Câmera e calibração.");
  } else {
    tracker.stopCamera(); // teclado: libera a webcam e o processamento
  }
}

async function play(song: Song, diff: DifficultyInfo) {
  await audio.resumeAudio();
  if (prefs.controlMode === "camera" && !tracker.cameraActive && !(await ensureCamera()))
    toast("Câmera indisponível: as mãos não serão detectadas.");
  lastSong = { song, diff };
  leaveScreen();
  game = new Gameplay(scene, document.getElementById("ui")!, onGameEnd);
  try {
    await game.start(song, diff);
  } catch (e) {
    game.cleanup();
    game = null;
    toast(`Erro ao carregar: ${(e as Error).message}`);
    showMenu();
  }
}

function onGameEnd(result: PlayResult | null, retry?: boolean) {
  game = null;
  if (retry && lastSong) { play(lastSong.song, lastSong.diff); return; }
  if (result) showResults(result, () => lastSong && play(lastSong.song, lastSong.diff));
  else showSongs();
}

function applyPrefs() {
  audio.applyVolumes();
  scene.setBloom(prefs.bloom);
  scene.setQuality(prefs.quality);
}

async function main() {
  await loadPrefs();
  applyPrefs();
  initUi({ play, applyPrefs, ensureCamera, setControlMode });
  requestAnimationFrame(loop);
  document.getElementById("ui")!.innerHTML = `<div class="screen"><div class="logo" style="margin-top:28vh"><span class="a">WIN</span> <span class="b">SABER</span></div><div class="tagline" id="boot">Iniciando…</div></div>`;
  const boot = (m: string) => { const el = document.getElementById("boot"); if (el) el.textContent = m; };
  // o AudioContext so destrava apos um gesto do usuario
  window.addEventListener("pointerdown", () => audio.resumeAudio(), { once: true });
  window.addEventListener("keydown", () => audio.resumeAudio(), { once: true });
  boot("Lendo músicas…");
  await scanLibrary();
  if (prefs.controlMode === "camera") {
    await ensureTracker(boot);
    boot("Abrindo a câmera…");
    if (!(await ensureCamera())) toast("Não foi possível abrir a câmera. Verifique em Configurações → Câmera e calibração.");
  }
  showMenu();
}

main();
