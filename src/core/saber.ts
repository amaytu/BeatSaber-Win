// Sabre controlado pela posicao da mao (webcam). Porta da maquina de estados de
// swing de source/core/saber.cpp: la o ponteiro vinha do giroscopio (yaw/pitch);
// aqui vem direto da posicao da mao projetada na grade 4x3 (em lanes/layers).
//
// Para reaproveitar os limiares e a pontuacao pre/pos-swing do juiz (definidos
// em graus), distancias sao convertidas em "graus equivalentes":
// 1 lane = DEG_PER_LANE. Assim um swing de 2 lanes vale os 100 graus de pre-swing.
import { Vec2 } from "./vec";

export const DEG_PER_LANE = 50;
/** tempo maximo (s) que o sabre segue sozinho quando a camera perde a mao */
export const COAST_S = 0.25;
const HISTORY = 4;

export interface SaberParams {
  swingStart: number; // graus-eq/s para iniciar um swing
  swingEnd: number;   // graus-eq/s abaixo do qual o swing termina
}

export const defaultSaberParams = (): SaberParams => ({ swingStart: 230, swingEnd: 90 });

export class HandSaber {
  pointer = new Vec2(2, 1.5);
  prevPointer = new Vec2(2, 1.5);
  velocity = new Vec2(); // graus-eq/s
  speed = 0;
  swinging = false;
  swingId = 0;
  swingAngle = 0;
  swingDir = new Vec2(0, -1);
  tracked = false;
  /** posicao desenhada na tela (prevista; ver predict) */
  display = new Vec2(2, 1.5);
  private handVel = new Vec2(); // lanes/s (suavizada pelo rastreamento)
  private stamp = 0;            // instante (ms) da ultima amostra
  private lostTime = 0;         // s sem a mao (seguindo a trajetoria prevista)
  private slowTime = 0;
  private hist: Vec2[] = [];

  constructor(public params: SaberParams = defaultSaberParams()) {}

  get swingEndSpeed() { return this.params.swingEnd; }

  reset() {
    this.velocity = new Vec2();
    this.speed = 0;
    this.swinging = false;
    this.slowTime = 0;
    this.hist = [];
    this.prevPointer = this.pointer.clone();
  }

  /**
   * Posicao para desenhar o sabre agora: extrapola a ultima amostra pela velocidade
   * da mao (tempo desde a amostra + predicao). Esconde o atraso da camera e deixa o
   * sabre fluido entre quadros da camera (30 fps) na taxa da tela.
   */
  predict(nowMs: number, predictionS: number): Vec2 {
    if (!this.tracked) return this.display;
    const ahead = Math.min(0.12, Math.max(0, (nowMs - this.stamp) / 1000 + predictionS));
    // menos predicao quando a mao esta quase parada (evita tremer)
    const v = this.handVel.length() < 0.6 ? this.handVel.scale(0.3) : this.handVel;
    this.display = this.pointer.add(v.scale(ahead));
    return this.display;
  }

  /** Nova amostra da mao (em lanes/layers) ou null se a mao sumiu do quadro. */
  update(p: Vec2 | null, dt: number, handVel?: Vec2, stampMs?: number) {
    // p e reatribuido durante a previsao
    if (dt <= 0) return;
    if (handVel) this.handVel = handVel;
    if (stampMs !== undefined) this.stamp = stampMs;
    if (!p) {
      // A camera perdeu a mao (borrao em corte rapido). Por ate COAST_S o sabre segue
      // a trajetoria prevista pela ultima velocidade, desacelerando, e o swing continua
      // valendo: a nota no caminho ainda e cortada. Quando a mao volta, a trajetoria
      // se reconecta como parte do mesmo movimento.
      if (this.tracked && this.lostTime + dt <= COAST_S) {
        this.lostTime += dt;
        const decay = 1 - this.lostTime / COAST_S;
        p = this.pointer.add(this.handVel.scale(dt * (0.4 + 0.6 * decay)));
      }
    } else {
      this.lostTime = 0;
    }
    this.prevPointer = this.pointer.clone();
    if (!p) {
      // sem mao por tempo demais: congela e encerra o swing
      this.tracked = false;
      this.velocity = new Vec2();
      this.speed = 0;
      this.swinging = false;
      this.hist = [];
      return;
    }
    if (!this.tracked) {
      // mao reapareceu: nao gera um "swing" teleportado
      this.tracked = true;
      this.pointer = p.clone();
      this.prevPointer = p.clone();
      this.display = p.clone();
      this.hist = [p.clone()];
      return;
    }
    this.pointer = p.clone();
    this.velocity = this.pointer.sub(this.prevPointer).scale(DEG_PER_LANE / dt);
    this.speed = this.velocity.length();

    // historico curto para a direcao do swing (reage rapido em ida-e-volta)
    this.hist.push(p.clone());
    if (this.hist.length > HISTORY) this.hist.shift();
    let recent = this.pointer.sub(this.hist[0]);

    const dirNow = this.velocity.normalized();
    if (this.speed >= this.params.swingStart) {
      const reversed = this.swinging && dirNow.dot(this.swingDir) < -0.2;
      if (!this.swinging || reversed) {
        this.swinging = true;
        this.swingId++;
        this.swingAngle = 0;
        this.hist = [this.prevPointer.clone(), this.pointer.clone()];
        recent = this.pointer.sub(this.prevPointer);
        this.swingDir = dirNow;
      }
    }
    if (this.swinging) {
      this.swingAngle += this.speed * dt;
      if (this.speed > this.params.swingEnd) {
        const d = recent.normalized();
        if (d.length() > 0.5) this.swingDir = d;
      }
      if (this.speed < this.params.swingEnd) {
        this.slowTime += dt;
        if (this.slowTime > 0.06) this.swinging = false;
      } else this.slowTime = 0;
    } else this.slowTime = 0;
  }
}
