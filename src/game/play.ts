// Gameplay: liga a entrada -> juiz -> cena/HUD/sons, sincronizado pelo relogio do audio.
//  - modo camera: maos (webcam) -> sabres -> juiz de cortes. A camera chega com atraso,
//    entao o juiz avalia o "passado" (tempo da musica - latencia de entrada).
//  - modo teclado: W A S D (vermelhas) e I J K L (azuis) -> juiz por precisao de tempo.
import { Beatmap, DifficultyInfo, DIFFICULTY_LABELS, difficultyIndex } from "../core/map";
import { Judge, JudgeEvent, defaultJudgeConfig } from "../core/judge";
import { HandSaber } from "../core/saber";
import { KeyJudge, defaultKeyJudgeConfig } from "../core/keyJudge";
import { KEYMAP, KeyboardInput } from "../keyboard";
import { ScoreState, rankFromAccuracy } from "../core/score";
import * as audio from "../audio";
import { prefs } from "../prefs";
import { Song, loadAudio, loadBeatmap } from "../library";
import { tracker } from "../tracking";
import { GameScene } from "./scene";

export interface PlayResult {
  song: Song;
  diff: DifficultyInfo;
  map: Beatmap;
  score: ScoreState;
  failed: boolean;
}

const LEAD_IN = 3;
const FAIL_TIME = 1.8;
type Phase = "leadin" | "playing" | "paused" | "failing" | "done";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class Gameplay {
  private map!: Beatmap;
  private judge!: Judge;
  private keyMode = false;
  private keyJudge: KeyJudge | null = null;
  private keys: KeyboardInput | null = null;
  private score!: ScoreState;
  private sabers = [new HandSaber(), new HandSaber()];
  private phase: Phase = "leadin";
  private ready = false; // so vira true quando mapa, audio e juiz estao prontos
  private failTimer = 0;
  private unsub: (() => void) | null = null;
  private hud: HTMLElement;
  private el: Record<string, HTMLElement> = {};
  private pauseEl: HTMLElement | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);
  private song!: Song;
  private diff!: DifficultyInfo;

  constructor(private scene: GameScene, private ui: HTMLElement, private onEnd: (r: PlayResult | null, retry?: boolean) => void) {
    this.hud = document.getElementById("hud")!;
  }

  async start(song: Song, diff: DifficultyInfo) {
    this.song = song;
    this.diff = diff;
    this.ui.innerHTML = `<div class="screen dim"><div class="center-msg" style="font-size:42px">Carregando…</div></div>`;
    audio.stopPreview();
    const [map, buf] = await Promise.all([loadBeatmap(song, diff), loadAudio(song)]);
    if (!buf) throw new Error(`Áudio "${song.info.songFile}" não encontrado.`);
    const decoded = await audio.decode(buf);
    this.map = map;
    this.score = new ScoreState(prefs.noFail);
    const cfg = defaultJudgeConfig();
    cfg.directionTolerance = prefs.directionTolerance;
    cfg.positionTolerance = [0, 1.5, 0.9][prefs.positionAssist];
    this.judge = new Judge(map, this.score, cfg);
    this.keyMode = prefs.controlMode === "keyboard";
    if (this.keyMode) {
      const kcfg = defaultKeyJudgeConfig();
      kcfg.lenientDiagonals = prefs.lenientDiagonals;
      const kj = new KeyJudge(map, this.score, kcfg);
      this.keyJudge = kj;
      // o instante do evento de tecla vira tempo da musica (precisao independe dos quadros)
      const songTimeAt = (eventMs: number) => audio.songTime() - (performance.now() - eventMs) / 1000;
      this.keys = new KeyboardInput(songTimeAt, (st) => {
        if (this.phase === "leadin" || this.phase === "playing") kj.strike(st);
      });
      this.keys.onKeyVisual = (code, on) => this.hud.querySelector(`[data-key="${code}"]`)?.classList.toggle("on", on);
      this.keys.attach();
    }
    for (const s of this.sabers) {
      s.params.swingStart = prefs.swingThreshold;
      s.params.swingEnd = prefs.swingThreshold * 0.4;
      s.reset();
    }
    if (!this.keyMode) this.unsub = tracker.on((f) => {
      if (this.phase === "paused") return;
      f.hands.forEach((h, i) => this.sabers[i].update(h ? h.grid : null, f.dt, h?.gridVel, f.time));
    });
    this.scene.setMap(map);
    this.buildHud();
    this.ui.innerHTML = "";
    this.phase = "leadin";
    audio.applyVolumes();
    audio.playSong(decoded, LEAD_IN);
    this.ready = true;
    window.addEventListener("keydown", this.keyHandler);
  }

  /** Chamado a cada quadro da tela pelo loop principal. */
  frame(dt: number) {
    if (!this.ready) return;
    const t = audio.songTime();
    if (this.phase === "leadin" && t >= 0) this.phase = "playing";
    if (this.phase === "leadin" || this.phase === "playing") {
      if (this.keyJudge && this.keys) {
        this.keys.flush();
        this.keyJudge.held = [this.keys.held(0), this.keys.held(1)];
        this.keyJudge.update(t);
        for (const e of this.keyJudge.events) this.onEvent(e, t);
        this.keyJudge.events.length = 0;
      } else {
        this.judge.update(t - prefs.inputLatencyMs / 1000, this.sabers, [0, 1]);
        for (const e of this.judge.events) this.onEvent(e, t);
        this.judge.events.length = 0;
      }
      if (this.score.failed && this.phase === "playing") {
        this.phase = "failing";
        this.failTimer = 0;
        audio.fadeOutSong(FAIL_TIME);
      }
      const dur = audio.songDuration();
      if (t > this.map.lastObjectTime + 1.5 && (t > dur + 0.3 || t > this.map.lastObjectTime + 6)) this.finish(false);
    } else if (this.phase === "failing") {
      this.failTimer += dt;
      if (this.failTimer >= FAIL_TIME) this.finish(true);
    }
    const j = this.keyJudge ?? this.judge;
    this.scene.update(t, dt, j.state, j.head, this.sabers);
    this.updateHud(t);
  }

  private onEvent(e: JudgeEvent & { grade?: string }, t: number) {
    const n = this.map.notes[e.note];
    const color = n.color === 0 ? 0 : 1;
    switch (e.type) {
      case "good":
        this.scene.spawnCut(n, t, e.dir, color);
        audio.sfxCut(color === 0 ? -0.4 : 0.4);
        break;
      case "score":
        if (e.grade && n.kind === 0) {
          this.floater(n.x + 0.5, n.y + 0.5, e.grade, e.grade === "Perfeito" ? "#ffffff" : e.grade === "Ótimo" ? "#bfe3ff" : "#9fa8d8");
          break;
        }
        if (e.cutScore !== undefined && n.kind === 0) this.floater(n.x + 0.5, n.y + 0.5, String(e.cutScore), e.cutScore >= 110 ? "#ffffff" : e.cutScore >= 100 ? "#bfe3ff" : "#9fa8d8");
        break;
      case "bad":
        audio.sfxBad();
        this.scene.addShake(0.04);
        this.floater(n.x + 0.5, n.y + 0.5, "✕", "#ff5a6e");
        break;
      case "miss":
        this.floater(n.x + 0.5, n.y + 0.5, "MISS", "#8c8cb4");
        break;
      case "bomb":
        audio.sfxBomb();
        this.scene.addShake(0.08);
        this.floater(n.x + 0.5, n.y + 0.5, "BOMBA", "#ff5a6e");
        break;
    }
  }

  private floater(lane: number, layer: number, text: string, color: string) {
    const p = this.scene.projectGrid(lane, layer, window.innerWidth, window.innerHeight);
    const d = document.createElement("div");
    d.className = "floater";
    d.textContent = text;
    d.style.color = color;
    d.style.left = `${p.x}px`;
    d.style.top = `${p.y}px`;
    this.hud.appendChild(d);
    requestAnimationFrame(() => {
      d.style.transform = "translate(-50%, -150%)";
      d.style.opacity = "0";
    });
    setTimeout(() => d.remove(), 650);
  }

  // ---------------------------------------------------------------------------
  private buildHud() {
    const di = difficultyIndex(this.diff.difficulty);
    this.hud.innerHTML = `
      <div class="hud-progress" id="h-prog"></div>
      <div class="hud-left">
        <div class="hud-label">COMBO</div>
        <div class="hud-big" id="h-combo">0</div>
        <div class="mult"><svg viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="42" fill="rgba(8,6,28,.7)" stroke="rgba(120,110,200,.35)" stroke-width="8"/>
          <circle id="h-mring" cx="50" cy="50" r="42" fill="none" stroke="#7cb8ff" stroke-width="8" stroke-linecap="round" stroke-dasharray="264" stroke-dashoffset="264"/>
        </svg><span id="h-mult">x1</span></div>
      </div>
      <div class="hud-right">
        <div class="hud-label">PONTOS</div>
        <div class="hud-big" id="h-score">0</div>
        <div class="hud-mid" id="h-acc">100.0%</div>
        <div class="hud-rank" id="h-rank">SS</div>
        <div class="hud-label" style="margin-top:8px">${esc(DIFFICULTY_LABELS[di])}${prefs.noFail ? " · NO FAIL" : ""}</div>
      </div>
      <div class="energy"><div id="h-energy"></div></div>
      <div class="center-msg" id="h-count"></div>
      <div class="center-sub" id="h-sub"></div>
      <div class="warn-chip chip warn hidden" id="h-warn"></div>
      <div class="fail-overlay hidden" id="h-fail"></div>
      ${this.keyMode ? keyClusters() : ""}`;
    for (const id of ["h-prog", "h-combo", "h-mring", "h-mult", "h-score", "h-acc", "h-rank", "h-energy", "h-count", "h-sub", "h-warn", "h-fail"]) {
      this.el[id] = this.hud.querySelector("#" + id) as HTMLElement;
    }
    this.hud.classList.remove("hidden");
  }

  private updateHud(t: number) {
    const s = this.score;
    const el = this.el;
    const dur = audio.songDuration() || this.map.lastObjectTime || 1;
    el["h-prog"].style.width = `${Math.min(100, Math.max(0, (t / dur) * 100))}%`;
    el["h-combo"].textContent = String(s.combo);
    el["h-mult"].textContent = `x${s.multiplier}`;
    const mp = s.multiplier >= 8 ? 1 : s.multProgress / (s.multiplier * 2);
    el["h-mring"].setAttribute("stroke-dashoffset", String(264 * (1 - mp)));
    el["h-mring"].setAttribute("stroke", s.multiplier >= 8 ? "#ffd75a" : "#7cb8ff");
    el["h-score"].textContent = s.score.toLocaleString("pt-BR");
    const acc = s.accuracy();
    el["h-acc"].textContent = `${(acc * 100).toFixed(1)}%`;
    el["h-rank"].textContent = rankFromAccuracy(acc);
    const e = s.energy;
    const ec = e < 0.25 ? "#ff3c50" : e < 0.5 ? "#ffb347" : "#8fd0ff";
    el["h-energy"].style.width = `${e * 100}%`;
    el["h-energy"].style.background = `linear-gradient(90deg, ${ec}aa, ${ec})`;
    el["h-energy"].style.boxShadow = `0 0 12px ${ec}`;

    if (this.phase === "leadin") {
      const n = Math.ceil(-t);
      el["h-count"].textContent = n >= 1 && n <= 3 ? String(n) : "";
      el["h-sub"].textContent = this.keyMode
        ? "Vermelhas: W A S D · Azuis: I J K L · diagonal = duas teclas juntas"
        : "Mãos na frente do corpo · vermelho = mão esquerda, azul = direita";
    } else {
      el["h-count"].textContent = this.phase === "failing" ? "FALHOU" : "";
      el["h-sub"].textContent = this.phase === "playing" && t > this.map.lastObjectTime + 1 ? "Enter: encerrar" : "";
    }
    el["h-fail"].classList.toggle("hidden", this.phase !== "failing");
    const missing = this.keyMode ? 0 : this.sabers.filter((x) => !x.tracked).length;
    el["h-warn"].classList.toggle("hidden", missing === 0 || this.phase === "paused");
    el["h-warn"].textContent = !tracker.cameraActive ? "Câmera desligada" : missing === 2 ? "Nenhuma mão visível" : "Só uma mão visível";
  }

  // ---------------------------------------------------------------------------
  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape" || e.key === " ") {
      e.preventDefault();
      if (this.phase === "paused") this.resume();
      else if (this.phase === "playing" || this.phase === "leadin") this.pause();
    } else if (e.key === "Enter" && this.phase === "playing" && audio.songTime() > this.map.lastObjectTime + 1) {
      this.finish(false);
    }
  }

  private pause() {
    this.phase = "paused";
    audio.pauseSong();
    this.pauseEl = document.createElement("div");
    this.pauseEl.className = "screen dim";
    this.pauseEl.innerHTML = `
      <h1 class="title" style="margin-top:18vh">PAUSADO</h1><div class="underline"></div>
      <div style="color:#b6b4e0;margin-bottom:18px">${esc(this.song.info.songName)}</div>
      <div class="menu panel">
        <button class="btn" data-a="resume">Continuar</button>
        <button class="btn" data-a="restart">Reiniciar</button>
        <button class="btn" data-a="quit">Sair para as músicas</button>
      </div>`;
    this.pauseEl.addEventListener("click", (ev) => {
      const a = (ev.target as HTMLElement).dataset.a;
      audio.sfxClick();
      if (a === "resume") this.resume();
      else if (a === "restart") { this.cleanup(); this.onEnd(null, true); }
      else if (a === "quit") { this.cleanup(); this.onEnd(null); }
    });
    this.ui.appendChild(this.pauseEl);
    (this.pauseEl.querySelector("button") as HTMLButtonElement).focus();
  }

  private resume() {
    this.pauseEl?.remove();
    this.pauseEl = null;
    for (const s of this.sabers) s.reset();
    this.phase = audio.songTime() < 0 ? "leadin" : "playing";
    audio.resumeSong();
  }

  private finish(failed: boolean) {
    if (this.phase === "done") return;
    this.phase = "done";
    if (!this.keyJudge) this.judge.flush();
    const result: PlayResult = { song: this.song, diff: this.diff, map: this.map, score: this.score, failed };
    this.cleanup();
    this.onEnd(result);
  }

  cleanup() {
    this.ready = false;
    this.phase = "done";
    audio.stopSong();
    this.unsub?.();
    this.unsub = null;
    this.keys?.detach();
    this.keys = null;
    this.keyJudge = null;
    window.removeEventListener("keydown", this.keyHandler);
    this.pauseEl?.remove();
    this.hud.classList.add("hidden");
    this.hud.innerHTML = "";
    this.scene.setMap(null);
  }
}

/** Teclas no canto da tela (acendem ao apertar): W A S D a esquerda, I J K L a direita. */
function keyClusters() {
  const cluster = (hand: 0 | 1) => {
    const codes = Object.entries(KEYMAP).filter(([, [h]]) => h === hand);
    const at = (dir: string) => codes.find(([, [, d]]) => d === dir)![0];
    const k = (code: string) => `<div class="key" data-key="${code}">${code.slice(3)}</div>`;
    return `<div class="keys ${hand ? "right" : "left"}"><span></span>${k(at("up"))}<span></span>${k(at("left"))}${k(at("down"))}${k(at("right"))}</div>`;
  };
  return cluster(0) + cluster(1);
}
