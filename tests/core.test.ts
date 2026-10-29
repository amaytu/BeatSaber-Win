// Testes do nucleo TypeScript:
//  1. leitura de mapas: compara com os .wbs gerados por tools/bs2wbs.py (referencia)
//  2. robo: uma "mao" virtual passa por cada nota na direcao certa -> 100% de acertos;
//     na direcao contraria -> cortes errados; parada -> misses.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Beatmap, CUT_ANY, KIND_BOMB, KIND_CHAIN_LINK, convertDifficulty, parseInfo, parseJsonText } from "../src/core/map";
import { KeyJudge, keysForAngle } from "../src/core/keyJudge";
import { HandSaber } from "../src/core/saber";
import { Judge, NoteState } from "../src/core/judge";
import { ScoreState } from "../src/core/score";
import { Vec2, directionFromAngle } from "../src/core/vec";

const repo = join(__dirname, "..");

function findPython(): string | null {
  for (const cmd of ["python3", "python", "py"]) {
    try {
      execFileSync(cmd, ["--version"], { stdio: "ignore" });
      return cmd;
    } catch {}
  }
  return null;
}

// gera as musicas demo (v2/v3/v4) + mapas extremos e converte com o Python
function makeSongs(): string | null {
  const py = findPython();
  if (!py) return null;
  const dir = mkdtempSync(join(tmpdir(), "winsaber-"));
  const songs = join(dir, "songs");
  execFileSync(py, [join(repo, "tools", "make_demo_song.py"), songs], { stdio: "ignore" });
  execFileSync(py, [join(repo, "tests", "make_edge_cases.py"), songs, "1234"], { stdio: "ignore" });
  execFileSync(py, [join(repo, "tools", "bs2wbs.py"), "--force", songs], { stdio: "ignore" });
  return songs;
}

function findCI(dir: string, name: string): string | null {
  const low = name.toLowerCase();
  const hit = readdirSync(dir).find((f) => f.toLowerCase() === low);
  return hit ? join(dir, hit) : null;
}

function loadSong(dir: string) {
  const info = parseInfo(parseJsonText(readFileSync(findCI(dir, "info.dat")!, "utf8")));
  const ap = info.audioDataFile ? findCI(dir, info.audioDataFile) : null;
  const audio = ap ? parseJsonText(readFileSync(ap, "utf8")) : undefined;
  return { info, audio };
}

const f32 = (v: number) => Math.fround(v);

describe("leitura de mapas = bs2wbs.py", () => {
  const songs = makeSongs();
  it.skipIf(!songs)("todas as dificuldades batem com os .wbs de referencia", () => {
    let compared = 0;
    for (const name of readdirSync(songs!)) {
      const dir = join(songs!, name);
      if (!findCI(dir, "info.dat")) continue;
      const { info, audio } = loadSong(dir);
      for (const d of info.difficulties) {
        const src = findCI(dir, d.filename);
        const wbs = join(dir, `${d.characteristic}_${d.difficulty}.wbs`);
        if (!src || !existsSync(wbs)) continue;
        const map = convertDifficulty(parseJsonText(readFileSync(src, "utf8")), info, d, audio);
        const buf = readFileSync(wbs);
        const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const nNotes = v.getUint32(8), nObs = v.getUint32(12), nEv = v.getUint32(16);
        expect(map.notes.length, `${name}/${d.difficulty} notas`).toBe(nNotes);
        expect(map.obstacles.length).toBe(nObs);
        expect(map.events.length).toBe(nEv);
        expect(f32(map.halfJumpSeconds)).toBe(v.getFloat32(28));
        expect(f32(map.lastObjectTime)).toBe(v.getFloat32(36));
        expect(map.maxScore).toBe(v.getUint32(40));
        for (let i = 0; i < nNotes; i++) {
          const o = 64 + i * 16;
          const n = map.notes[i];
          expect(f32(n.time), `${name} nota ${i} tempo`).toBe(v.getFloat32(o));
          expect(n.kind).toBe(v.getUint8(o + 8));
          expect(n.color).toBe(v.getUint8(o + 9));
          expect(n.flags).toBe(v.getUint8(o + 11));
          expect(n.angle).toBe(v.getInt16(o + 12));
        }
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// robo
// ---------------------------------------------------------------------------
function play(map: Beatmap, mode: "perfect" | "reverse" | "idle") {
  const score = new ScoreState(true);
  const judge = new Judge(map, score);
  const sabers = [new HandSaber(), new HandSaber()];
  const colors = [0, 1];
  const fps = 30; // taxa tipica de webcam
  const dt = 1 / fps;
  const end = map.lastObjectTime + 1;
  // cada sabre visita a proxima nota da sua cor: chega 0.1 s antes vindo de tras
  // da direcao do corte e atravessa a nota em 0.2 s (~ 9 lanes/s)
  for (let t = -1; t < end; t += dt) {
    for (let si = 0; si < 2; si++) {
      const s = sabers[si];
      let pos = new Vec2(si === 0 ? 1 : 3, 1);
      if (mode !== "idle") {
        const next = map.notes.find((n, i) => n.kind !== KIND_BOMB && n.color === colors[si] && judge.state[i] === NoteState.Pending && n.time > t - 0.1);
        if (next) {
          const center = new Vec2(next.x + 0.5, next.y + 0.5);
          let dir = directionFromAngle(next.angle);
          if (mode === "reverse") dir = dir.scale(-1);
          const k = Math.min(1, Math.max(-1, (t - next.time) / 0.1)); // -1..1 em torno da nota
          pos = center.add(dir.scale(k * 1.0));
        }
      }
      s.update(pos, dt);
    }
    judge.update(t, sabers, colors);
  }
  judge.flush();
  return score;
}

// robo do modo teclado: aperta as teclas da direcao de cada nota no tempo certo
function playKeys(map: Beatmap, mode: "perfect" | "reverse" | "idle" | "late") {
  const score = new ScoreState(true);
  const judge = new KeyJudge(map, score);
  const end = map.lastObjectTime + 1;
  const pending = map.notes
    .map((n, i) => ({ n, i }))
    .filter(({ n }) => n.kind !== KIND_BOMB && n.kind !== KIND_CHAIN_LINK);
  let k = 0;
  for (let t = -1; t < end; t += 1 / 120) {
    if (mode !== "idle") {
      while (k < pending.length && pending[k].n.time + (mode === "late" ? 0.08 : 0.01) <= t) {
        const { n, i } = pending[k++];
        if (judge.state[i] !== NoteState.Pending) continue; // ja saiu junto com outra nota
        const angle = mode === "reverse" ? n.angle + 180 : n.angle;
        const dirs = n.cutDir === CUT_ANY ? (["up"] as const) : keysForAngle(angle);
        judge.strike({ hand: n.color as 0 | 1, time: t, dirs: [...dirs] });
      }
    }
    judge.held = mode === "idle" ? [false, false] : [true, true]; // segura as teclas nas correntes
    judge.update(t);
  }
  return score;
}

describe("robo do modo teclado", () => {
  const songs = makeSongs();
  it.skipIf(!songs)("teclas certas acertam tudo; invertidas erram; paradas perdem", () => {
    const dir = join(songs!, "Win Saber Demo v3");
    const { info, audio } = loadSong(dir);
    const d = info.difficulties.find((x) => x.difficulty === "Expert")!;
    const map = convertDifficulty(parseJsonText(readFileSync(findCI(dir, d.filename)!, "utf8")), info, d, audio);
    const total = map.notes.filter((n) => n.kind !== KIND_BOMB).length;

    const perfect = playKeys(map, "perfect");
    expect(perfect.goodCuts).toBe(total);
    expect(perfect.accuracy()).toBeGreaterThan(0.99);

    const late = playKeys(map, "late");
    // 80 ms atrasado: vale "Otimo" (nao "Perfeito"); em trechos densos o golpe atrasado
    // pode ficar mais perto da proxima nota, entao nem todas saem
    expect(late.goodCuts).toBeGreaterThan(total * 0.95);
    expect(late.accuracy()).toBeLessThan(0.95);

    const reverse = playKeys(map, "reverse");
    expect(reverse.badCuts).toBeGreaterThan(total * 0.5);

    const idle = playKeys(map, "idle");
    expect(idle.misses).toBe(total);
  });
});

describe("robo de gameplay", () => {
  const songs = makeSongs();
  it.skipIf(!songs)("perfeito acerta tudo; invertido erra; parado perde", () => {
    const dir = join(songs!, "Win Saber Demo v2");
    const { info, audio } = loadSong(dir);
    const d = info.difficulties.find((x) => x.difficulty === "Expert")!;
    const map = convertDifficulty(parseJsonText(readFileSync(findCI(dir, d.filename)!, "utf8")), info, d, audio);
    const total = map.notes.filter((n) => n.kind !== KIND_BOMB).length;

    const perfect = play(map, "perfect");
    expect(perfect.goodCuts).toBe(total);
    expect(perfect.misses).toBe(0);

    const reverse = play(map, "reverse");
    expect(reverse.badCuts).toBeGreaterThan(total * 0.5);

    const idle = play(map, "idle");
    expect(idle.misses).toBe(total);
  });
});
