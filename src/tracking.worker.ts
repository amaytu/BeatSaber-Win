// Worker de rastreamento: roda o MediaPipe Hand Landmarker fora da thread
// principal, para a deteccao nao disputar tempo com o desenho do jogo.
// Recebe quadros da camera como ImageBitmap (transferidos, sem copia) e devolve
// so os pontos das maos.
//
// Cada worker usa um unico delegate (GPU ou CPU): o runtime WASM do MediaPipe so
// cria um modelo por carregamento ("ModuleFactory not set" no segundo). Para
// comparar GPU x CPU a thread principal sobe dois workers e fica com o mais rapido.
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

export type WorkerIn =
  | { type: "init"; wasmBase: string; modelUrl: string; delegate: "GPU" | "CPU" }
  | { type: "frame"; bitmap: ImageBitmap; time: number };

export type WorkerOut =
  | { type: "ready"; delegate: string }
  | { type: "error"; message: string; fatal?: boolean }
  | { type: "result"; time: number; detectMs: number; hands: { lm: { x: number; y: number }[]; label: string }[] };

let landmarker: HandLandmarker | null = null;
const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    try {
      // useModule = true: carrega o runtime WASM como modulo ES (exigido em module workers)
      const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase, true);
      landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: msg.modelUrl, delegate: msg.delegate },
        runningMode: "VIDEO",
        numHands: 2,
        // limiares mais baixos: "segura" a mao mesmo borrada em movimentos rapidos
        minHandDetectionConfidence: 0.4,
        minHandPresenceConfidence: 0.35,
        minTrackingConfidence: 0.35,
      });
      post({ type: "ready", delegate: msg.delegate });
    } catch (e) {
      post({ type: "error", message: (e as Error).message, fatal: true });
    }
    return;
  }
  if (msg.type === "frame") {
    const { bitmap, time } = msg;
    if (!landmarker) { bitmap.close(); return; }
    const t0 = performance.now();
    try {
      const res = landmarker.detectForVideo(bitmap, time);
      post({
        type: "result",
        time,
        detectMs: performance.now() - t0,
        hands: res.landmarks.map((lm, i) => ({
          lm: lm.map((p) => ({ x: p.x, y: p.y })),
          label: res.handedness[i]?.[0]?.categoryName ?? "",
        })),
      });
    } catch (e) {
      post({ type: "error", message: (e as Error).message });
    } finally {
      bitmap.close();
    }
  }
};
