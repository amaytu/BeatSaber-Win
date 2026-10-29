// Audio: musica decodificada inteira (WebAudio), relogio da musica a partir do
// relogio do proprio AudioContext (sem deriva), preview com fade e efeitos sintetizados.
import { prefs } from "./prefs";

const ctx = new AudioContext({ latencyHint: "interactive" });
const musicGain = ctx.createGain();
const sfxGain = ctx.createGain();
musicGain.connect(ctx.destination);
sfxGain.connect(ctx.destination);

export function applyVolumes() {
  musicGain.gain.value = prefs.musicVolume;
  sfxGain.gain.value = prefs.sfxVolume;
}

export async function decode(buf: ArrayBuffer): Promise<AudioBuffer> {
  return ctx.decodeAudioData(buf.slice(0));
}

// ---------------------------------------------------------------------------
// musica do gameplay
// ---------------------------------------------------------------------------
let song: AudioBufferSourceNode | null = null;
let songStartCtx = 0;   // ctx.currentTime em que o tempo 0 da musica toca
let pausedAt: number | null = null;
let songBuffer: AudioBuffer | null = null;

/** Agenda a musica para que o instante 0 aconteca daqui a `leadIn` segundos. */
export function playSong(buffer: AudioBuffer, leadIn: number) {
  stopSong();
  songBuffer = buffer;
  songStartCtx = ctx.currentTime + leadIn;
  startSource(0, songStartCtx);
  pausedAt = null;
}

function startSource(offset: number, when: number) {
  if (!songBuffer) return;
  song = ctx.createBufferSource();
  song.buffer = songBuffer;
  song.connect(musicGain);
  song.start(Math.max(when, ctx.currentTime), Math.max(0, offset));
}

export function stopSong() {
  if (song) {
    try { song.stop(); } catch {}
    song.disconnect();
    song = null;
  }
  pausedAt = null;
}

export function pauseSong() {
  if (pausedAt !== null) return;
  pausedAt = songTime();
  if (song) {
    try { song.stop(); } catch {}
    song.disconnect();
    song = null;
  }
}

export function resumeSong() {
  if (pausedAt === null) return;
  const t = pausedAt;
  pausedAt = null;
  songStartCtx = ctx.currentTime + 0.05 - t;
  if (t >= 0) startSource(t, ctx.currentTime + 0.05);
  else startSource(0, songStartCtx);
}

/** Tempo da musica (s) como ouvido pelo jogador (desconta a latencia de saida). */
export function songTime(): number {
  if (pausedAt !== null) return pausedAt;
  const outLat = (ctx.outputLatency || 0) + ctx.baseLatency;
  return ctx.currentTime - songStartCtx - outLat - prefs.audioOffsetMs / 1000;
}

export const songDuration = () => songBuffer?.duration ?? 0;

export function fadeOutSong(seconds: number) {
  const g = musicGain.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(g.value, ctx.currentTime);
  g.linearRampToValueAtTime(0, ctx.currentTime + seconds);
  setTimeout(() => { stopSong(); applyVolumes(); }, seconds * 1000 + 50);
}

// ---------------------------------------------------------------------------
// preview na selecao de musicas
//
// Usa um <audio> em streaming (comeca a tocar em milissegundos, sem decodificar a
// musica inteira). Cada pedido recebe uma "senha": qualquer stopPreview() (troca de
// musica, saida da tela, inicio do jogo) invalida pedidos ainda carregando, entao
// uma previa atrasada nunca toca por cima do gameplay.
// ---------------------------------------------------------------------------
let previewEl: HTMLAudioElement | null = null;
let previewToken = 0;
let previewFade = 0;

/** Para a previa na hora e cancela qualquer previa ainda carregando. */
export function stopPreview() {
  previewToken++;
  cancelAnimationFrame(previewFade);
  if (previewEl) {
    previewEl.pause();
    previewEl.removeAttribute("src");
    previewEl.load();
    previewEl = null;
  }
}

/**
 * Toca a previa de `getUrl()` em loop entre `start` e `start + duration`.
 * Se outra previa (ou stopPreview) acontecer enquanto carrega, esta e descartada.
 */
export async function startPreview(getUrl: () => Promise<string | null>, start: number, duration: number) {
  stopPreview();
  const token = previewToken;
  const url = await getUrl();
  if (!url || token !== previewToken) return;
  const el = new Audio();
  el.preload = "auto";
  el.volume = 0;
  el.src = url;
  previewEl = el;
  const loopStart = Math.max(0, start);
  const loopEnd = loopStart + Math.max(6, duration || 12);
  el.addEventListener("timeupdate", () => {
    if (el.currentTime >= loopEnd) el.currentTime = loopStart;
  });
  el.addEventListener("ended", () => {
    el.currentTime = loopStart;
    el.play().catch(() => {});
  });
  try {
    el.currentTime = loopStart;
    await el.play();
  } catch {
    return; // formato nao suportado ou interrompido
  }
  if (token !== previewToken) { el.pause(); return; }
  // fade-in curto (150 ms)
  const target = Math.min(1, prefs.musicVolume * 0.75);
  const t0 = performance.now();
  const step = () => {
    if (token !== previewToken) return;
    const k = Math.min(1, (performance.now() - t0) / 150);
    el.volume = target * k;
    if (k < 1) previewFade = requestAnimationFrame(step);
  };
  previewFade = requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// efeitos sonoros procedurais
// ---------------------------------------------------------------------------
function noiseBuffer(seconds: number) {
  const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
const noise = noiseBuffer(0.4);

export function sfxCut(pan = 0, strength = 1) {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(3200, t);
  bp.frequency.exponentialRampToValueAtTime(900, t + 0.12);
  bp.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.5 * strength, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  src.connect(bp).connect(g).connect(p).connect(sfxGain);
  src.start(t);
  src.stop(t + 0.2);
  // "estalo" tonal
  const o = ctx.createOscillator();
  const og = ctx.createGain();
  o.type = "triangle";
  o.frequency.setValueAtTime(1400, t);
  o.frequency.exponentialRampToValueAtTime(300, t + 0.08);
  og.gain.setValueAtTime(0.18 * strength, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  o.connect(og).connect(p);
  o.start(t);
  o.stop(t + 0.1);
}

export function sfxBad() {
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sawtooth";
  o.frequency.setValueAtTime(220, t);
  o.frequency.exponentialRampToValueAtTime(90, t + 0.2);
  g.gain.setValueAtTime(0.18, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g).connect(sfxGain);
  o.start(t);
  o.stop(t + 0.25);
}

export function sfxBomb() {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 500;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.7, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
  src.connect(lp).connect(g).connect(sfxGain);
  src.start(t);
  src.stop(t + 0.4);
}

export function sfxClick() {
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = "sine";
  o.frequency.setValueAtTime(1800, t);
  o.frequency.exponentialRampToValueAtTime(1200, t + 0.04);
  g.gain.setValueAtTime(0.08, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
  o.connect(g).connect(sfxGain);
  o.start(t);
  o.stop(t + 0.06);
}

/** O AudioContext so inicia apos um gesto do usuario. */
export async function resumeAudio() {
  if (ctx.state !== "running") await ctx.resume();
}
