// Pontuacao, combo, multiplicador e energia. Porta de source/core/score.cpp.

export const SCORE_PRE_MAX = 70;
export const SCORE_POST_MAX = 30;
export const SCORE_ACC_MAX = 15;

const ENERGY_GOOD = 0.01;
const ENERGY_BAD_CUT = -0.1;
const ENERGY_MISS = -0.15;
const ENERGY_CHAIN_MISS = -0.03;
const ENERGY_BOMB = -0.15;

const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class ScoreState {
  score = 0;
  maxPossible = 0;
  combo = 0;
  maxCombo = 0;
  multiplier = 1;
  multProgress = 0;
  idealMult = 1;
  idealProgress = 0;
  goodCuts = 0;
  badCuts = 0;
  misses = 0;
  bombsHit = 0;
  totalCutScore = 0;
  cutCount = 0;
  energy = 0.5;
  failed = false;

  constructor(public noFail = false) {}

  accuracy(): number {
    return this.maxPossible ? this.score / this.maxPossible : 1;
  }

  private addEnergy(d: number) {
    this.energy = Math.min(1, Math.max(0, this.energy + d));
    if (this.energy <= 0 && !this.noFail) this.failed = true;
  }

  private break() {
    this.combo = 0;
    if (this.multiplier > 1) this.multiplier /= 2;
    this.multProgress = 0;
  }

  private advanceIdeal(maxForNote: number) {
    this.maxPossible += maxForNote * this.idealMult;
    if (this.idealMult < 8 && ++this.idealProgress >= this.idealMult * 2) {
      this.idealMult *= 2;
      this.idealProgress = 0;
    }
  }

  /** No instante do corte: retorna o multiplicador a aplicar quando a pontuacao for finalizada. */
  onGoodCut(chainLink: boolean): number {
    const m = this.multiplier;
    this.combo++;
    if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    this.goodCuts++;
    if (this.multiplier < 8 && ++this.multProgress >= this.multiplier * 2) {
      this.multiplier *= 2;
      this.multProgress = 0;
    }
    this.addEnergy(chainLink ? ENERGY_GOOD * 0.2 : ENERGY_GOOD);
    return m;
  }

  addCutScore(cutScore: number, multAtCut: number, maxForNote: number) {
    this.score += cutScore * multAtCut;
    this.totalCutScore += cutScore;
    this.cutCount++;
    this.advanceIdeal(maxForNote);
  }

  onBadCut(maxForNote: number) {
    this.badCuts++;
    this.break();
    this.advanceIdeal(maxForNote);
    this.addEnergy(ENERGY_BAD_CUT);
  }

  onMiss(maxForNote: number, chainLink: boolean) {
    this.misses++;
    this.break();
    this.advanceIdeal(maxForNote);
    this.addEnergy(chainLink ? ENERGY_CHAIN_MISS : ENERGY_MISS);
  }

  onBomb() {
    this.bombsHit++;
    this.break();
    this.addEnergy(ENERGY_BOMB);
  }
}

export interface CutParts { pre: number; post: number; acc: number; total: number }

export function computeCutScore(
  preAngle: number, postAngle: number, timingError: number, angleScale: number, timingWindow: number, chainHead: boolean,
): CutParts {
  if (angleScale <= 0.05) angleScale = 0.05;
  const pre = Math.floor(SCORE_PRE_MAX * sat(preAngle / (100 * angleScale)) + 0.5);
  const post = chainHead ? 0 : Math.floor(SCORE_POST_MAX * sat(postAngle / (60 * angleScale)) + 0.5);
  const accF = timingWindow > 0 ? 1 - sat(timingError / timingWindow) : 1;
  const acc = Math.floor(SCORE_ACC_MAX * accF + 0.5);
  return { pre, post, acc, total: pre + post + acc };
}

export const RANKS = ["SS", "S", "A", "B", "C", "D", "E"] as const;
export type Rank = (typeof RANKS)[number];

export function rankFromAccuracy(acc: number): Rank {
  if (acc >= 0.9) return "SS";
  if (acc >= 0.8) return "S";
  if (acc >= 0.65) return "A";
  if (acc >= 0.5) return "B";
  if (acc >= 0.35) return "C";
  if (acc >= 0.2) return "D";
  return "E";
}
