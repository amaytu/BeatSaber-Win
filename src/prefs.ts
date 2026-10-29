// Preferencias do jogador (salvas em userData/settings.json pelo processo principal).
import { host } from "./host";

export interface Prefs {
  /** versao das preferencias (migracoes de padroes) */
  version: number;
  /** forma de jogar: camera (maos pela webcam) ou teclado (W A S D / I J K L) */
  controlMode: "camera" | "keyboard";
  /** teclado: diagonal aceita so uma das duas teclas (e reta aceita diagonal que a contenha) */
  lenientDiagonals: boolean;
  cameraId: string;
  /** atraso da camera + rastreamento (ms): o juiz olha o passado por esse tempo */
  inputLatencyMs: number;
  /** offset de audio (ms): positivo atrasa as notas */
  audioOffsetMs: number;
  /** area de jogo na imagem da camera (0..1): centro e tamanho */
  areaCx: number;
  areaCy: number;
  areaW: number;
  areaH: number;
  swapHands: boolean;
  /** suavizacao do rastreamento (One Euro): menor = mais suave, maior = mais responsivo */
  smoothing: number;
  swingThreshold: number;
  directionTolerance: number;
  positionAssist: 0 | 1 | 2; // livre, normal, rigida
  noFail: boolean;
  musicVolume: number;
  sfxVolume: number;
  showCamera: boolean;
  bloom: number;
  /** 0 = desempenho (sem bloom), 1 = equilibrio (bloom em meia resolucao), 2 = qualidade */
  quality: 0 | 1 | 2;
  /** quanto o sabre "antecipa" o movimento da mao para esconder o atraso da camera (ms) */
  predictionMs: number;
  lastSong: string;
  lastDiff: string;
}

const PREFS_VERSION = 2;

export const defaultPrefs = (): Prefs => ({
  version: PREFS_VERSION,
  controlMode: "keyboard",
  lenientDiagonals: true,
  cameraId: "",
  inputLatencyMs: 70,
  audioOffsetMs: 0,
  areaCx: 0.5,
  areaCy: 0.5,
  areaW: 0.6,
  areaH: 0.55,
  swapHands: false,
  smoothing: 1,
  swingThreshold: 230,
  directionTolerance: 65,
  positionAssist: 0,
  noFail: false,
  musicVolume: 0.8,
  sfxVolume: 0.7,
  showCamera: true,
  bloom: 1,
  quality: 0,
  predictionMs: 50,
  lastSong: "",
  lastDiff: "",
});

export let prefs: Prefs = defaultPrefs();

export async function loadPrefs() {
  const p = (await host.getPrefs()) as Partial<Prefs> | null;
  prefs = { ...defaultPrefs(), ...(p || {}) };
  if ((prefs.version ?? 1) < 2) {
    // v2: padroes ajustados para webcam (menos atraso, posicao livre)
    const d = defaultPrefs();
    prefs.inputLatencyMs = d.inputLatencyMs;
    prefs.positionAssist = d.positionAssist;
    prefs.smoothing = d.smoothing;
    prefs.version = PREFS_VERSION;
    savePrefs();
  }
}

let saveTimer = 0;
export function savePrefs() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => host.setPrefs(prefs), 300);
}
