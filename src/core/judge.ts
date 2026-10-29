// Julgamento de cortes: janela de tempo, posicao, direcao, bombas, misses e
// finalizacao da pontuacao pos-swing. Porta de source/core/judge.cpp.
import {
  Beatmap, FLAG_CHAIN_HEAD, FLAG_DOT, CUT_ANY, KIND_BOMB, KIND_CHAIN_LINK, NoteData,
  SCORE_CHAIN_HEAD_MAX, SCORE_CHAIN_LINK_MAX, SCORE_NOTE_MAX,
} from "./map";
import { HandSaber } from "./saber";
import { ScoreState, computeCutScore } from "./score";
import { Vec2, angleBetween, directionFromAngle, distancePointSegment } from "./vec";

export enum NoteState { Pending = 0, CutGood, CutBad, Missed, BombHit, Passed }
export type JudgeEventType = "good" | "bad" | "miss" | "bomb" | "score";

export interface JudgeEvent {
  type: JudgeEventType;
  saber: number;
  note: number;
  dir: Vec2;
  timing: number; // s; negativo = adiantado
  cutScore?: number;
  pre?: number;
  post?: number;
  acc?: number;
}

export interface JudgeConfig {
  windowEarly: number;
  windowLate: number;
  badCutWindow: number;
  directionTolerance: number;
  positionTolerance: number; // lanes; <= 0 desliga
  bombTolerance: number;
  angleScale: number;
  accuracyWindow: number;
  anyColor: boolean;
}

export const defaultJudgeConfig = (): JudgeConfig => ({
  windowEarly: 0.15, windowLate: 0.12, badCutWindow: 0.07, directionTolerance: 60, positionTolerance: 1.5,
  bombTolerance: 0.55, angleScale: 0.7, accuracyWindow: 0.12, anyColor: false,
});

interface PendingCut {
  note: number; swingId: number; saber: number; chainHead: boolean;
  preAngle: number; angleAtCut: number; postAngle: number; timingError: number; age: number; mult: number;
}

const maxScoreFor = (n: NoteData) =>
  n.kind === KIND_CHAIN_LINK ? SCORE_CHAIN_LINK_MAX : n.flags & FLAG_CHAIN_HEAD ? SCORE_CHAIN_HEAD_MAX : SCORE_NOTE_MAX;

export class Judge {
  state: Uint8Array;
  events: JudgeEvent[] = [];
  head = 0;
  private lastTime = -1000;
  private lastCutSwing = [-1, -1];
  private pending: PendingCut[] = [];

  constructor(public map: Beatmap, public score: ScoreState, public cfg: JudgeConfig = defaultJudgeConfig()) {
    this.state = new Uint8Array(map.notes.length);
  }

  private emit(e: JudgeEvent) { this.events.push(e); }

  private touches(s: HandSaber, n: NoteData, tol: number) {
    if (tol <= 0) return true;
    return distancePointSegment(new Vec2(n.x + 0.5, n.y + 0.5), s.prevPointer, s.pointer) <= tol;
  }

  private finalize(pc: PendingCut) {
    const n = this.map.notes[pc.note];
    let parts = { pre: 0, post: 0, acc: 0, total: SCORE_CHAIN_LINK_MAX };
    if (n.kind !== KIND_CHAIN_LINK) {
      parts = computeCutScore(pc.preAngle, pc.postAngle, Math.abs(pc.timingError), this.cfg.angleScale, this.cfg.accuracyWindow, pc.chainHead);
    }
    this.score.addCutScore(parts.total, pc.mult, maxScoreFor(n));
    this.emit({ type: "score", saber: pc.saber, note: pc.note, dir: new Vec2(), timing: pc.timingError, cutScore: parts.total, pre: parts.pre, post: parts.post, acc: parts.acc });
  }

  private updatePending(dt: number, sabers: HandSaber[]) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const pc = this.pending[i];
      const s = sabers[pc.saber];
      pc.age += dt;
      const same = s.swinging && s.swingId === pc.swingId;
      if (same) pc.postAngle = s.swingAngle - pc.angleAtCut;
      if (!same || pc.age > 0.4 || pc.chainHead) {
        this.finalize(pc);
        this.pending.splice(i, 1);
      }
    }
  }

  flush() {
    for (const pc of this.pending) this.finalize(pc);
    this.pending = [];
  }

  /** sabers[i] corta a cor saberColor[i] (0 = esquerda/vermelho, 1 = direita/azul). */
  update(now: number, sabers: HandSaber[], saberColor: number[]) {
    let dt = this.lastTime > -999 ? now - this.lastTime : 0;
    if (dt < 0) dt = 0;
    this.lastTime = now;
    const notes = this.map.notes;
    const count = notes.length;
    const cfg = this.cfg;
    this.updatePending(dt, sabers);

    for (let si = 0; si < sabers.length && si < 2; si++) {
      const s = sabers[si];
      if (!s.tracked) continue;
      let groupTime = -1;
      const cand: number[] = [];
      for (let i = this.head; i < count; i++) {
        const n = notes[i];
        const dtNote = n.time - now;
        if (dtNote > cfg.windowEarly) break;
        if (this.state[i] !== NoteState.Pending || dtNote < -cfg.windowLate) continue;
        if (n.kind === KIND_BOMB) {
          if (Math.abs(dtNote) <= 0.06 && s.speed > 30 && this.touches(s, n, cfg.bombTolerance)) {
            this.state[i] = NoteState.BombHit;
            this.score.onBomb();
            this.emit({ type: "bomb", saber: si, note: i, dir: s.velocity.normalized(), timing: -dtNote });
          }
          continue;
        }
        if (!cfg.anyColor && n.color !== saberColor[si]) continue;
        if (groupTime >= 0 && n.time > groupTime + 0.05) break;
        const link = n.kind === KIND_CHAIN_LINK;
        const ok = link
          ? s.speed >= s.swingEndSpeed && this.touches(s, n, cfg.positionTolerance)
          : s.swinging && this.touches(s, n, cfg.positionTolerance);
        if (groupTime < 0) groupTime = n.time;
        if (!ok) continue;
        if (cand.length < 16) cand.push(i);
      }

      const dir = s.swingDir;
      for (let pass = 0; pass < 2; pass++) {
        for (const i of cand) {
          if (this.state[i] !== NoteState.Pending) continue;
          const n = notes[i];
          const link = n.kind === KIND_CHAIN_LINK;
          const timing = now - n.time;
          const dot = (n.flags & FLAG_DOT) !== 0 || n.cutDir === CUT_ANY || link;
          const good = dot || angleBetween(dir, directionFromAngle(n.angle)) <= cfg.directionTolerance;
          if (pass === 0 && good) {
            this.state[i] = NoteState.CutGood;
            this.lastCutSwing[si] = s.swingId;
            const mult = this.score.onGoodCut(link);
            this.emit({ type: "good", saber: si, note: i, dir, timing });
            const pc: PendingCut = {
              note: i, swingId: s.swingId, saber: si, chainHead: (n.flags & FLAG_CHAIN_HEAD) !== 0,
              preAngle: s.swingAngle, angleAtCut: s.swingAngle, postAngle: 0, timingError: timing, age: 0, mult,
            };
            if (link) this.finalize(pc);
            else this.pending.push(pc);
          } else if (pass === 1 && !good && Math.abs(timing) <= cfg.badCutWindow && this.lastCutSwing[si] !== s.swingId) {
            this.state[i] = NoteState.CutBad;
            this.score.onBadCut(maxScoreFor(n));
            this.emit({ type: "bad", saber: si, note: i, dir, timing });
          }
        }
      }
    }

    // misses e bombas que passaram
    while (this.head < count) {
      const n = notes[this.head];
      if (this.state[this.head] !== NoteState.Pending) { this.head++; continue; }
      if (now - n.time <= cfg.windowLate) break;
      if (n.kind === KIND_BOMB) this.state[this.head] = NoteState.Passed;
      else {
        this.state[this.head] = NoteState.Missed;
        this.score.onMiss(maxScoreFor(n), n.kind === KIND_CHAIN_LINK);
        this.emit({ type: "miss", saber: 0, note: this.head, dir: new Vec2(), timing: 0 });
      }
      this.head++;
    }
  }
}
