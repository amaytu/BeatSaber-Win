// Entrada do modo teclado: notas vermelhas em W A S D, azuis em I J K L.
// Usa a posicao fisica das teclas (KeyboardEvent.code), entao funciona em qualquer
// layout. Teclas da mesma mao apertadas quase juntas viram um golpe diagonal.
import type { Hand, KeyDir, Strike } from "./core/keyJudge";

export const KEYMAP: Record<string, [Hand, KeyDir]> = {
  KeyW: [0, "up"], KeyA: [0, "left"], KeyS: [0, "down"], KeyD: [0, "right"],
  KeyI: [1, "up"], KeyJ: [1, "left"], KeyK: [1, "down"], KeyL: [1, "right"],
};

/** janela (s) para juntar duas teclas da mesma mao numa diagonal */
const CHORD_S = 0.035;

interface Pending { time: number; at: number; dirs: KeyDir[] }

export class KeyboardInput {
  private pending: (Pending | null)[] = [null, null];
  private down = new Set<string>();
  /** tecla -> elemento visual aceso no HUD */
  onKeyVisual: ((code: string, on: boolean) => void) | null = null;
  private kd = (e: KeyboardEvent) => this.onDown(e);
  private ku = (e: KeyboardEvent) => this.onUp(e);

  /**
   * @param songTimeAt converte o instante do evento (performance.now) em tempo da musica
   * @param onStrike recebe cada golpe completo
   */
  constructor(private songTimeAt: (eventMs: number) => number, private onStrike: (s: Strike) => void) {}

  attach() {
    window.addEventListener("keydown", this.kd, true);
    window.addEventListener("keyup", this.ku, true);
  }

  detach() {
    window.removeEventListener("keydown", this.kd, true);
    window.removeEventListener("keyup", this.ku, true);
    this.down.clear();
    this.pending = [null, null];
  }

  /** Alguma tecla desta mao esta segurada (elos de corrente). */
  held(hand: Hand): boolean {
    for (const c of this.down) if (KEYMAP[c][0] === hand) return true;
    return false;
  }

  private onDown(e: KeyboardEvent) {
    const m = KEYMAP[e.code];
    if (!m || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    if (e.repeat || this.down.has(e.code)) return;
    this.down.add(e.code);
    this.onKeyVisual?.(e.code, true);
    const [hand, dir] = m;
    const t = this.songTimeAt(e.timeStamp);
    const p = this.pending[hand];
    if (p && t - p.time <= CHORD_S) {
      if (!p.dirs.includes(dir)) p.dirs.push(dir);
      return;
    }
    if (p) this.emit(hand);
    this.pending[hand] = { time: t, at: performance.now(), dirs: [dir] };
  }

  private onUp(e: KeyboardEvent) {
    if (!KEYMAP[e.code]) return;
    this.down.delete(e.code);
    this.onKeyVisual?.(e.code, false);
  }

  private emit(hand: Hand) {
    const p = this.pending[hand];
    if (!p) return;
    this.pending[hand] = null;
    this.onStrike({ hand, time: p.time, dirs: p.dirs });
  }

  /** Fecha os golpes cuja janela de diagonal ja passou (chamar a cada quadro). */
  flush() {
    const now = performance.now();
    for (const hand of [0, 1] as Hand[]) {
      const p = this.pending[hand];
      if (p && (now - p.at) / 1000 > CHORD_S) this.emit(hand);
    }
  }
}
