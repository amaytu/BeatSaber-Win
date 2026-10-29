// Prepara os assets do rastreamento de maos para rodar 100% offline:
//  - copia o runtime WASM do MediaPipe (node_modules) para public/mediapipe/wasm
//  - baixa o modelo hand_landmarker.task (Google, Apache 2.0) para public/models
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmDst = join(root, "public", "mediapipe", "wasm");
const modelDst = join(root, "public", "models", "hand_landmarker.task");
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

mkdirSync(wasmDst, { recursive: true });
for (const f of readdirSync(wasmSrc)) copyFileSync(join(wasmSrc, f), join(wasmDst, f));
console.log("MediaPipe WASM copiado para public/mediapipe/wasm");

if (existsSync(modelDst) && statSync(modelDst).size > 1_000_000) {
  console.log("Modelo de maos ja presente.");
} else {
  mkdirSync(dirname(modelDst), { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Falha ao baixar o modelo: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(modelDst, buf);
  console.log(`Modelo de maos baixado (${(buf.length / 1e6).toFixed(1)} MB)`);
}
