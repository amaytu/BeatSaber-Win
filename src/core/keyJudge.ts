// Juiz do modo teclado: cada mao tem 4 teclas de direcao (vermelhas: W A S D,
// azuis: I J K L). Um "golpe" e o conjunto de teclas da mesma mao apertadas quase
// juntas (diagonal = 2 teclas). O golpe acerta a nota mais proxima no tempo da cor
// daquela mao se a direcao bater; a nota vale pela precisao de tempo.
//
// Emite os mesmos eventos do juiz da webcam (good/bad/miss/bomb/score), entao a
// cena, os sons e o HUD funcionam igual nos dois modos.
import {
  Beatmap, CUT_ANY, FLAG_CHAIN_HEAD, FLAG_DOT, KIND_BOMB, KIND_CHAIN_LINK, NoteData,
  SCORE_CHAIN_HEAD_MAX, SCORE_CHAIN_LINK_MAX, SCORE_NOTE_MAX,
} from "./map";
import { JudgeEvent, NoteState } from "./judge";
import { ScoreState } from "./score";
import { Vec2, angleBetween, directionFromAngle } from "./vec";

export type Hand = 0 | 1; // 0 = esquerda/vermelho, 1 = direita/azul
export type KeyDir = "up" | "down" | "left" | "right";

export const KEY_VECTORS: Record<KeyDir, Vec2> = {
  up: new Vec2(0, 1), down: new Vec2(0, -1), left: new Vec2(-1, 0), right: new Vec2(1, 0),
};

/** Um golpe: teclas de uma mao apertadas quase juntas. */
export interface Strike {
  hand: Hand;
  time: number;      // tempo da musica do primeiro aperto (s)
  dirs: KeyDir[];
}

export interface KeyJudgeConfig {
  perfect: number;   // s: |erro| para "Perfeito"
  great: number;     // s: "Otimo"
  good: number;      // s: "Bom" (e a janela total; depois disso e miss)
  /** true: diagonal aceita so uma das duas teclas, e reta aceita diagonal que a contenha */
  lenientDiagonals: boolean;
  bombWindow: number;
}

export const defaultKeyJudgeConfig = (): KeyJudgeConfig => ({
  perfect: 0.045, great: 0.09, good: 0.135, lenientDiagonals: true, bombWindow: 0.06,
});

export type Grade = "Perfeito" | "Ótimo" | "Bom";

const maxScoreFor = (n: NoteData) =>
  n.kind === KIND_CHAIN_LINK ? SCORE_CHAIN_LINK_MAX : n.flags & FLAG_CHAIN_HEAD ? SCORE_CHAIN_HEAD_MAX : SCORE_NOTE_MAX;

/** Direcao do golpe (unitaria) a partir das teclas; null se as teclas se anulam. */
export function strikeDirection(dirs: KeyDir[]): Vec2 | null {
  let v = new Vec2();
  for (const d of new Set(dirs)) v = v.add(KEY_VECTORS[d]);
  return v.length() > 0.1 ? v.normalized() : null;
}

export class KeyJudge {
  state: Uint8Array;
  events: (JudgeEvent & { grade?: Grade })[] = [];
  head = 0;
  /** teclas seguradas por mao (para os elos de corrente) */
  held: [boolean, boolean] = [false, false];

  constructor(public map: Beatmap, public score: ScoreState, public cfg: KeyJudgeConfig = defaultKeyJudgeConfig()) {
    this.state = new Uint8Array(map.notes.length);
  }

  private matches(n: NoteData, dir: Vec2 | null): boolean {
    if ((n.flags & FLAG_DOT) !== 0 || n.cutDir === CUT_ANY) return true;
    if (!dir) return false;
    const angle = angleBetween(dir, directionFromAngle(n.angle));
    // exato: <= 22.5 graus (reta x reta, diagonal x diagonal). Leniente: vizinha de 45 graus vale.
    return angle <= (this.cfg.lenientDiagonals ? 46 : 22.5);
  }

  private grade(err: number): { grade: Grade; factor: number } {
    const e = Math.abs(err);
    if (e <= this.cfg.perfect) return { grade: "Perfeito", factor: 1 };
    if (e <= this.cfg.great) return { grade: "Ótimo", factor: 0.87 };
    return { grade: "Bom", factor: 0.6 };
  }

  private hit(i: number, hand: Hand, timing: number, dir: Vec2) {
    const n = this.map.notes[i];
    const link = n.kind === KIND_CHAIN_LINK;
    this.state[i] = NoteState.CutGood;
    const mult = this.score.onGoodCut(link);
    this.events.push({ type: "good", saber: hand, note: i, dir, timing });
    const max = maxScoreFor(n);
    const g = link ? { grade: "Perfeito" as Grade, factor: 1 } : this.grade(timing);
    const cut = Math.round(max * g.factor);
    this.score.addCutScore(cut, mult, max);
    this.events.push({ type: "score", saber: hand, note: i, dir: new Vec2(), timing, cutScore: cut, grade: g.grade });
  }

  /** Processa um golpe ja completo (teclas agrupadas). */
  strike(s: Strike) {
    const notes = this.map.notes;
    const dir = strikeDirection(s.dirs);
    // nota pendente mais proxima no tempo, da cor desta mao, dentro da janela
    let best = -1, bestErr = Infinity;
    for (let i = this.head; i < notes.length; i++) {
      const n = notes[i];
      const err = s.time - n.time;
      if (err < -this.cfg.good) break;
      if (this.state[i] !== NoteState.Pending || n.kind === KIND_BOMB || n.kind === KIND_CHAIN_LINK) continue;
      if (n.color !== s.hand || Math.abs(err) > this.cfg.good) continue;
      // prefere a que bate a direcao; empate -> a mais proxima no tempo
      const score = Math.abs(err) + (this.matches(n, dir) ? 0 : 1);
      if (score < bestErr) { bestErr = score; best = i; }
    }
    if (best >= 0) {
      const n = notes[best];
      const timing = s.time - n.time;
      const d = dir ?? directionFromAngle(n.angle);
      if (this.matches(n, dir)) {
        this.hit(best, s.hand, timing, d);
        // notas simultaneas da mesma cor e direcao compativel (ex.: 2 cubos empilhados) saem juntas
        for (let i = this.head; i < notes.length; i++) {
          const o = notes[i];
          if (o.time - n.time > 0.03) break;
          if (i !== best && this.state[i] === NoteState.Pending && o.kind !== KIND_BOMB && o.kind !== KIND_CHAIN_LINK &&
              o.color === s.hand && Math.abs(o.time - n.time) <= 0.03 && this.matches(o, dir)) {
            this.hit(i, s.hand, s.time - o.time, d);
          }
        }
      } else {
        this.state[best] = NoteState.CutBad;
        this.score.onBadCut(maxScoreFor(n));
        this.events.push({ type: "bad", saber: s.hand, note: best, dir: d, timing });
      }
      return;
    }
    // golpe sem nota: so pune se houver uma bomba do lado desta mao bem agora
    for (let i = this.head; i < notes.length; i++) {
      const n = notes[i];
      if (n.time - s.time > this.cfg.bombWindow) break;
      if (n.kind !== KIND_BOMB || this.state[i] !== NoteState.Pending) continue;
      const side: Hand = n.x < 2 ? 0 : 1;
      if (side === s.hand && Math.abs(s.time - n.time) <= this.cfg.bombWindow) {
        this.state[i] = NoteState.BombHit;
        this.score.onBomb();
        this.events.push({ type: "bomb", saber: s.hand, note: i, dir: new Vec2(), timing: s.time - n.time });
        return;
      }
    }
  }

  /** Chamado a cada quadro: elos de corrente (tecla segurada) e misses. */
  update(now: number) {
    const notes = this.map.notes;
    for (let i = this.head; i < notes.length; i++) {
      const n = notes[i];
      if (n.time > now) break;
      if (this.state[i] !== NoteState.Pending || n.kind !== KIND_CHAIN_LINK) continue;
      if (this.held[n.color as Hand]) this.hit(i, n.color as Hand, 0, directionFromAngle(n.angle));
    }
    while (this.head < notes.length) {
      const n = notes[this.head];
      if (this.state[this.head] !== NoteState.Pending) { this.head++; continue; }
      if (now - n.time <= this.cfg.good) break;
      if (n.kind === KIND_BOMB) this.state[this.head] = NoteState.Passed;
      else {
        this.state[this.head] = NoteState.Missed;
        this.score.onMiss(maxScoreFor(n), n.kind === KIND_CHAIN_LINK);
        this.events.push({ type: "miss", saber: 0, note: this.head, dir: new Vec2(), timing: 0 });
      }
      this.head++;
    }
  }
}

/** Teclas de uma direcao para tocar uma nota (usado pelo robo de testes e pela legenda). */
export function keysForAngle(angle: number): KeyDir[] {
  const v = directionFromAngle(angle);
  const out: KeyDir[] = [];
  if (v.y > 0.38) out.push("up");
  if (v.y < -0.38) out.push("down");
  if (v.x > 0.38) out.push("right");
  if (v.x < -0.38) out.push("left");
  return out;
}
