// Rastreamento das maos pela webcam com MediaPipe Hand Landmarker (offline, GPU).
// Para cada quadro novo da camera entrega a posicao de cada mao ja convertida
// para a grade do jogo (lanes 0..4, layers 0..3), suavizada por um filtro One Euro.
import type { WorkerIn, WorkerOut } from "./tracking.worker";
import { prefs } from "./prefs";
import { Vec2 } from "./core/vec";

export interface TrackedHand {
  /** posicao da palma na imagem espelhada (0..1), como o jogador se ve */
  img: Vec2;
  /** velocidade suavizada na grade (lanes/s), usada para prever o movimento */
  gridVel: Vec2;
  /** posicao na grade do jogo (lanes, layers) */
  grid: Vec2;
  landmarks: { x: number; y: number }[]; // espelhados
}

export interface HandFrame {
  time: number;        // performance.now() da captura (ms)
  dt: number;          // s desde o quadro anterior
  hands: [TrackedHand | null, TrackedHand | null]; // [esquerda (vermelho), direita (azul)]
}

type Listener = (f: HandFrame) => void;

// --- filtro One Euro (Casiez et al.): suaviza tremidas sem atrasar movimentos rapidos ---
class LowPass {
  y = 0;
  init = false;
  filter(x: number, a: number) {
    this.y = this.init ? a * x + (1 - a) * this.y : x;
    this.init = true;
    return this.y;
  }
}
class OneEuro {
  private x = new LowPass();
  private dx = new LowPass();
  private last = 0;
  constructor(public minCutoff = 2.0, public beta = 10, public dCutoff = 1.5) {}
  reset() { this.x.init = false; this.dx.init = false; }
  filter(v: number, dt: number) {
    if (dt <= 0) dt = 1 / 30;
    const alpha = (cut: number) => 1 / (1 + 1 / (2 * Math.PI * cut * dt));
    const d = this.x.init ? (v - this.last) / dt : 0;
    const ed = this.dx.filter(d, alpha(this.dCutoff));
    const cutoff = this.minCutoff + this.beta * Math.abs(ed);
    this.last = this.x.filter(v, alpha(cutoff));
    return this.last;
  }
}

const PALM = [0, 5, 9, 13, 17];

/** Um worker de rastreamento (GPU ou CPU) e sua medicao de tempo. */
interface Engine { name: "GPU" | "CPU"; worker: Worker; busy: boolean; total: number; n: number; seen: number }

export class HandTracker {
  video: HTMLVideoElement;
  private engines: Engine[] = [];
  private chosen: Engine | null = null;
  private stream: MediaStream | null = null;
  private listeners = new Set<Listener>();
  private lastTime = 0;
  private running = false;
  private filters = [[new OneEuro(), new OneEuro()], [new OneEuro(), new OneEuro()]];
  private lastPos: (Vec2 | null)[] = [null, null];
  private lastGrid: (Vec2 | null)[] = [null, null];
  private lastSeen = [0, 0];
  private vel: Vec2[] = [new Vec2(), new Vec2()];
  fps = 0;
  detectMs = 0;
  private fpsCount = 0;
  private fpsT0 = 0;
  delegate = "";
  latest: HandFrame | null = null;

  constructor() {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    // fora do documento o Chromium pode nao decodificar quadros: fica anexado e invisivel
    this.video.style.cssText = "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.appendChild(this.video);
  }

  /**
   * Sobe os workers com o MediaPipe (fora da thread do jogo): um com GPU e outro
   * com CPU. Nos primeiros quadros os dois sao medidos; o mais rapido fica e o
   * outro e encerrado (em GPU integrada ocupada com o jogo, a CPU costuma ganhar).
   */
  async init(onStatus?: (msg: string) => void) {
    onStatus?.("Carregando modelo de mãos…");
    const start = (delegate: "GPU" | "CPU") =>
      new Promise<Engine>((resolve, reject) => {
        const worker = new Worker(new URL("./tracking.worker.ts", import.meta.url), { type: "module" });
        const eng: Engine = { name: delegate, worker, busy: false, total: 0, n: 0, seen: 0 };
        worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
          const m = ev.data;
          if (m.type === "ready") { worker.onmessage = (e2: MessageEvent<WorkerOut>) => this.onResult(eng, e2.data); resolve(eng); }
          else if (m.type === "error") { worker.terminate(); reject(new Error(m.message)); }
        };
        worker.onerror = (e) => { worker.terminate(); reject(new Error(e.message)); };
        const msg: WorkerIn = {
          type: "init",
          wasmBase: new URL("./mediapipe/wasm", location.href).href,
          modelUrl: new URL("./models/hand_landmarker.task", location.href).href,
          delegate,
        };
        worker.postMessage(msg);
      });
    const results = await Promise.allSettled([start("CPU"), start("GPU")]);
    this.engines = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    for (const r of results) if (r.status === "rejected") console.warn("rastreamento indisponivel:", r.reason);
    if (!this.engines.length) throw new Error("rastreamento de mãos indisponível");
    if (this.engines.length === 1) this.chosen = this.engines[0];
    this.delegate = this.chosen ? this.chosen.name : "medindo…";
  }

  private onResult(eng: Engine, m: WorkerOut) {
    if (m.type === "error") {
      eng.busy = false;
      console.warn("falha no rastreamento", m.message);
      return;
    }
    if (m.type !== "result") return;
    eng.busy = false;
    this.detectMs = this.detectMs * 0.85 + m.detectMs * 0.15;
    if (!this.chosen) {
      // medicao: ignora os primeiros quadros (aquecimento / compilacao de shaders)
      if (++eng.seen > 4) { eng.total += m.detectMs; eng.n++; }
      if (this.engines.every((e) => e.n >= 20)) {
        const avg = (e: Engine) => e.total / e.n;
        const best = [...this.engines].sort((a, b) => avg(a) - avg(b))[0];
        console.info(`rastreamento: ${this.engines.map((e) => `${e.name} ${avg(e).toFixed(1)} ms`).join(" x ")} -> ${best.name}`);
        for (const e of this.engines) if (e !== best) e.worker.terminate();
        this.engines = [best];
        this.chosen = best;
        this.delegate = best.name;
      }
    }
    // dois workers em paralelo podem responder fora de ordem: descarta resultados velhos
    if (m.time <= this.lastTime) return;
    this.process(m.hands, m.time);
  }

  static async listCameras(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "videoinput");
  }

  async startCamera() {
    this.stopCamera();
    // resolucao baixa = rastreamento mais rapido (o modelo trabalha em ~224 px de qualquer forma)
    const video: MediaTrackConstraints = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } };
    if (prefs.cameraId) video.deviceId = { exact: prefs.cameraId };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (e) {
      if (!prefs.cameraId) throw e;
      delete video.deviceId; // camera salva sumiu: usa a padrao
      this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
    this.video.srcObject = this.stream;
    await this.video.play();
    this.running = true;
    this.lastTime = 0;
    for (const e of this.engines) e.busy = false;
    this.rvfcSeen = false;
    this.scheduleFrame();
    this.pollFallback();
  }

  stopCamera() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  get cameraActive() { return this.running; }

  on(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }

  private lastVideoTime = -1;
  private rvfcSeen = false;

  private scheduleFrame() {
    if (!this.running) return;
    // requestVideoFrameCallback dispara assim que a camera entrega o quadro (sem
    // esperar o proximo quadro da tela); o rAF fica de reserva caso ele nao dispare.
    this.video.requestVideoFrameCallback(() => { this.rvfcSeen = true; this.onFrame(); this.scheduleFrame(); });
  }

  private pollFallback() {
    if (!this.running) return;
    if (!this.rvfcSeen) this.onFrame();
    requestAnimationFrame(() => this.pollFallback());
  }

  private onFrame() {
    if (!this.running || !this.engines.length) return;
    const vt = this.video.currentTime;
    if (this.video.readyState < 2 || vt === this.lastVideoTime) return;
    // primeiro worker livre (na medicao, o que tem menos amostras); todos ocupados:
    // descarta o quadro (enfileirar so aumentaria o atraso)
    const free = this.engines.filter((e) => !e.busy).sort((a, b) => a.n - b.n)[0];
    if (!free) return;
    this.lastVideoTime = vt;
    free.busy = true;
    const time = performance.now();
    // o modelo trabalha em ~200 px: reduzir aqui economiza conversao no worker
    createImageBitmap(this.video, { resizeWidth: 320, resizeHeight: 240, resizeQuality: "low" }).then(
      (bitmap) => {
        const msg: WorkerIn = { type: "frame", bitmap, time };
        free.worker.postMessage(msg, [bitmap]);
      },
      () => { free.busy = false; },
    );
  }

  /** Converte a posicao espelhada (0..1) para a grade do jogo. */
  static toGrid(img: Vec2): Vec2 {
    const lanes = 2 + ((img.x - prefs.areaCx) / prefs.areaW) * 5;
    const layers = 1.5 - ((img.y - prefs.areaCy) / prefs.areaH) * 4;
    return new Vec2(lanes, layers);
  }

  private process(raw: { lm: { x: number; y: number }[]; label: string }[], now: number) {
    const dt = this.lastTime ? (now - this.lastTime) / 1000 : 1 / 30;
    this.lastTime = now;
    this.fpsCount++;
    if (now - this.fpsT0 > 1000) {
      this.fps = (this.fpsCount * 1000) / (now - this.fpsT0);
      this.fpsCount = 0;
      this.fpsT0 = now;
    }

    // candidatos: palma (media de 5 pontos), espelhada
    const found = raw.map(({ lm, label }) => {
      let x = 0, y = 0;
      for (const k of PALM) { x += lm[k].x; y += lm[k].y; }
      return { img: new Vec2(1 - x / PALM.length, y / PALM.length), lm: lm.map((p) => ({ x: 1 - p.x, y: p.y })), label };
    });

    // atribuicao: 2 maos -> a mais a esquerda na imagem espelhada e a esquerda.
    // 1 mao -> a mais proxima da ultima posicao conhecida (prevista pela velocidade);
    // senao o rotulo do MediaPipe (que supoe imagem espelhada, entao vem trocado).
    const slots: (typeof found[number] | null)[] = [null, null];
    if (found.length >= 2) {
      const [a, b] = found[0].img.x <= found[1].img.x ? [found[0], found[1]] : [found[1], found[0]];
      slots[0] = a; slots[1] = b;
    } else if (found.length === 1) {
      const h = found[0];
      let side: number;
      const d0 = this.lastPos[0] ? h.img.sub(this.lastPos[0]).length() : Infinity;
      const d1 = this.lastPos[1] ? h.img.sub(this.lastPos[1]).length() : Infinity;
      if (Math.min(d0, d1) < 0.25) side = d0 <= d1 ? 0 : 1;
      else side = h.label === "Left" ? 1 : h.label === "Right" ? 0 : h.img.x < 0.5 ? 0 : 1;
      slots[side] = h;
    }
    if (prefs.swapHands) slots.reverse();

    const hands: [TrackedHand | null, TrackedHand | null] = [null, null];
    for (let s = 0; s < 2; s++) {
      const h = slots[s];
      const [fx, fy] = this.filters[s];
      if (!h) {
        // perda curta (borrao num corte rapido): mantem filtro e ultima posicao para
        // reconectar a trajetoria; o sabre segue sozinho pela velocidade (HandSaber)
        if (now - this.lastSeen[s] > 350) {
          fx.reset(); fy.reset();
          this.lastPos[s] = null;
          this.lastGrid[s] = null;
          this.vel[s] = new Vec2();
        }
        continue;
      }
      const gap = this.lastGrid[s] ? (now - this.lastSeen[s]) / 1000 : dt;
      this.lastSeen[s] = now;
      // beta alto: quase sem filtro em movimentos rapidos (sem atraso), suave quando parado
      const beta = 10 * prefs.smoothing;
      fx.beta = beta; fy.beta = beta;
      const img = new Vec2(fx.filter(h.img.x, gap), fy.filter(h.img.y, gap));
      const grid = HandTracker.toGrid(img);
      const lg = this.lastGrid[s];
      if (lg && gap > 0) {
        const v = grid.sub(lg).scale(1 / gap);
        this.vel[s] = this.vel[s].scale(0.35).add(v.scale(0.65));
      }
      this.lastPos[s] = img;
      this.lastGrid[s] = grid;
      hands[s] = { img, grid, gridVel: this.vel[s].clone(), landmarks: h.lm };
    }
    const frame: HandFrame = { time: now, dt, hands };
    this.latest = frame;
    for (const l of this.listeners) l(frame);
  }
}
export const tracker = new HandTracker();

// ligacoes entre pontos da mao para desenhar o esqueleto
export const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
