// Leitura dos mapas da comunidade (info.dat v2/v4 e dificuldades v2/v3/v4).
// Mesmo algoritmo de tools/bs2wbs.py (conversor de referencia em Python), mas em vez
// de serializar um .wbs devolve o mapa ja pronto em memoria. tests/map.test.ts
// compara o resultado com os .wbs gerados pelo Python.

export const KIND_NOTE = 0;
export const KIND_BOMB = 1;
export const KIND_CHAIN_LINK = 2;
export const COLOR_LEFT = 0;
export const COLOR_RIGHT = 1;
export const COLOR_NONE = 255;
export const FLAG_CHAIN_HEAD = 0x01;
export const FLAG_DOT = 0x02;
export const CUT_ANY = 8;

export const DIFFICULTIES = ["Easy", "Normal", "Hard", "Expert", "ExpertPlus"] as const;
export const DIFFICULTY_LABELS = ["Easy", "Normal", "Hard", "Expert", "Expert+"];
const DEFAULT_NJS = [10, 10, 10, 12, 16];
export const CHARACTERISTICS = ["Standard", "OneSaber", "NoArrows", "360Degree", "90Degree", "Lightshow", "Lawless", "Legacy"];
const BASE_ANGLE = [90, 270, 180, 0, 135, 45, 225, 315];

export const SCORE_NOTE_MAX = 115;
export const SCORE_CHAIN_HEAD_MAX = 85;
export const SCORE_CHAIN_LINK_MAX = 20;

export interface NoteData {
  time: number;
  x: number; // lane (0..3, pode ser fracionario com Mapping Extensions)
  y: number; // layer (0..2)
  kind: number;
  color: number;
  cutDir: number;
  flags: number;
  angle: number; // direcao do corte em graus (0 = direita, anti-horario)
}
export interface ObstacleData { time: number; duration: number; x: number; y: number; w: number; h: number }
export interface LightEvent { time: number; type: number; value: number; brightness: number }

export interface Beatmap {
  notes: NoteData[];
  obstacles: ObstacleData[];
  events: LightEvent[];
  bpm: number;
  njs: number;
  halfJumpSeconds: number;
  jumpDistance: number;
  lastObjectTime: number;
  maxScore: number;
  difficultyIndex: number;
  characteristicIndex: number;
  format: number;
}

export interface DifficultyInfo {
  characteristic: string;
  difficulty: string;
  filename: string;
  njs: number;
  offset: number;
}

export interface SongInfo {
  version: number;
  songName: string;
  subName: string;
  artist: string;
  mapper: string;
  bpm: number;
  songFile: string;
  coverFile: string;
  audioDataFile: string;
  previewStart: number;
  previewDuration: number;
  difficulties: DifficultyInfo[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
function num(o: unknown, k: string, d = 0): number {
  if (!isObj(o)) return d;
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}
function arr(o: unknown, k: string): unknown[] {
  if (!isObj(o)) return [];
  const v = o[k];
  return Array.isArray(v) ? v : [];
}
function str(o: unknown, k: string, d = ""): string {
  if (!isObj(o)) return d;
  const v = o[k];
  return typeof v === "string" ? v : d;
}
// int() do Python trunca em direcao a zero
const int = (v: number) => Math.trunc(v);

export function parseJsonText(text: string): unknown {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

// ---------------------------------------------------------------------------
// info.dat
// ---------------------------------------------------------------------------
export function parseInfo(doc: unknown): SongInfo {
  if (!isObj(doc)) throw new Error("info.dat inválido");
  const info: SongInfo = {
    version: 2, songName: "", subName: "", artist: "", mapper: "", bpm: 120, songFile: "",
    coverFile: "", audioDataFile: "", previewStart: 0, previewDuration: 12, difficulties: [],
  };
  if (str(doc, "version").startsWith("4")) {
    info.version = 4;
    const song = doc["song"], audio = doc["audio"];
    info.songName = str(song, "title");
    info.subName = str(song, "subTitle");
    info.artist = str(song, "author");
    info.bpm = num(audio, "bpm", 120);
    info.songFile = str(audio, "songFilename");
    info.audioDataFile = str(audio, "audioDataFilename");
    info.previewStart = num(audio, "previewStartTime", 0);
    info.previewDuration = num(audio, "previewDuration", 12);
    info.coverFile = str(doc, "coverImageFilename");
    for (const d of arr(doc, "difficultyBeatmaps")) {
      info.difficulties.push({
        characteristic: str(d, "characteristic", "Standard"),
        difficulty: str(d, "difficulty", "Expert"),
        filename: str(d, "beatmapDataFilename"),
        njs: num(d, "noteJumpMovementSpeed", 0),
        offset: num(d, "noteJumpStartBeatOffset", 0),
      });
      const mappers = arr(isObj(d) ? d["beatmapAuthors"] : undefined, "mappers");
      if (!info.mapper && typeof mappers[0] === "string") info.mapper = mappers[0];
    }
  } else {
    info.songName = str(doc, "_songName");
    info.subName = str(doc, "_songSubName");
    info.artist = str(doc, "_songAuthorName");
    info.mapper = str(doc, "_levelAuthorName");
    info.bpm = num(doc, "_beatsPerMinute", 120);
    info.songFile = str(doc, "_songFilename");
    info.coverFile = str(doc, "_coverImageFilename");
    info.previewStart = num(doc, "_previewStartTime", 0);
    info.previewDuration = num(doc, "_previewDuration", 12);
    info.audioDataFile = "BPMInfo.dat";
    for (const s of arr(doc, "_difficultyBeatmapSets")) {
      const ch = str(s, "_beatmapCharacteristicName", "Standard");
      for (const d of arr(s, "_difficultyBeatmaps")) {
        info.difficulties.push({
          characteristic: ch,
          difficulty: str(d, "_difficulty", "Expert"),
          filename: str(d, "_beatmapFilename"),
          njs: num(d, "_noteJumpMovementSpeed", 0),
          offset: num(d, "_noteJumpStartBeatOffset", 0),
        });
      }
    }
  }
  if (info.bpm <= 0) info.bpm = 120;
  return info;
}

// ---------------------------------------------------------------------------
// beats -> segundos
// ---------------------------------------------------------------------------
class TimeMap {
  changes: [number, number, number][] = []; // beat, bpm, tempo no beat
  regions: [number, number, number, number][] = []; // beat ini, beat fim, tempo ini, s/beat
  constructor(public bpm: number) {}

  setBpmChanges(raw: [number, number][]): boolean {
    const pts = raw.filter(([, m]) => m > 0).sort((a, b) => a[0] - b[0]);
    if (!pts.length) return false;
    const ch: [number, number, number][] = [];
    if (pts[0][0] > 0) ch.push([0, this.bpm, 0]);
    for (const [b, m] of pts) {
      let t: number;
      if (ch.length) {
        const [pb, pm, pt] = ch[ch.length - 1];
        t = pt + ((b - pb) * 60) / pm;
      } else t = (b * 60) / this.bpm;
      ch.push([b, m, t]);
    }
    this.changes = ch;
    return true;
  }

  setRegions(raw: [number, number, number, number][], freq: number): boolean {
    if (freq <= 0) return false;
    const regs: [number, number, number, number][] = [];
    for (const [si, ei, sb, eb] of raw) {
      if (eb <= sb || ei <= si) continue;
      regs.push([sb, eb, si / freq, (ei - si) / freq / (eb - sb)]);
    }
    regs.sort((a, b) => a[0] - b[0]);
    if (!regs.length) return false;
    this.regions = regs;
    return true;
  }

  toSeconds(beat: number): number {
    if (this.changes.length) {
      let seg = this.changes[0];
      for (const c of this.changes) {
        if (c[0] <= beat) seg = c;
        else break;
      }
      return seg[2] + ((beat - seg[0]) * 60) / seg[1];
    }
    if (this.regions.length) {
      const first = this.regions[0];
      if (beat < first[0]) return first[2] + (beat - first[0]) * first[3];
      let seg = first;
      for (const r of this.regions) {
        if (r[0] <= beat) seg = r;
        else break;
      }
      return seg[2] + (beat - seg[0]) * seg[3];
    }
    return (beat * 60) / this.bpm;
  }
}

function loadAudioRegions(doc: unknown): [[number, number, number, number][], number] {
  if (!isObj(doc)) return [[], 0];
  if ("bpmData" in doc) {
    return [arr(doc, "bpmData").map((r) => [num(r, "si"), num(r, "ei"), num(r, "sb"), num(r, "eb")]), num(doc, "songFrequency", 44100)];
  }
  return [
    arr(doc, "_regions").map((r) => [num(r, "_startSampleIndex"), num(r, "_endSampleIndex"), num(r, "_startBeat"), num(r, "_endBeat")]),
    num(doc, "_songFrequency", 44100),
  ];
}

// ---------------------------------------------------------------------------
// dificuldade
// ---------------------------------------------------------------------------
function swingAngle(cutDir: number, offset: number): [number, number, number] {
  let flags = 0;
  let cd = int(cutDir);
  const off = int(offset);
  let ang: number;
  if (cd >= 1000 && cd <= 1360) {
    ang = 270 + (cd - 1000) + off; // Mapping Extensions
    cd = 1;
  } else if (cd >= 0 && cd <= 7) {
    ang = BASE_ANGLE[cd] + off;
  } else {
    cd = CUT_ANY;
    flags |= FLAG_DOT;
    ang = off;
  }
  ang = (((ang % 360) + 360) % 360);
  return [cd, ang, flags];
}

const mePosition = (v: number) => (v >= 1000 ? (v - 1000) / 1000 : v <= -1000 ? (v + 1000) / 1000 : v);

export function difficultyIndex(name: string): number {
  const i = (DIFFICULTIES as readonly string[]).indexOf(name);
  return i < 0 ? 3 : i;
}

export function computeJump(bpm: number, njs: number, offset: number): [number, number] {
  const n = 60 / bpm;
  let hjd = 4;
  while (njs * n * hjd > 17.999) hjd /= 2;
  hjd += offset;
  if (hjd < 0.25) hjd = 0.25;
  const hjdSec = n * hjd;
  return [hjdSec, njs * hjdSec * 2];
}

function detectFormat(doc: Json): number {
  const v = str(doc, "version");
  if (v.startsWith("4")) return 4;
  if (v.startsWith("3") || "colorNotes" in doc) return 3;
  return 2;
}

export function convertDifficulty(diffDoc: unknown, info: SongInfo, dinfo: DifficultyInfo, audioDoc?: unknown): Beatmap {
  if (!isObj(diffDoc)) throw new Error("arquivo de dificuldade inválido");
  const fmt = detectFormat(diffDoc);
  const tm = new TimeMap(info.bpm);

  const bpmRaw: [number, number][] = [];
  if (fmt === 3) {
    for (const e of arr(diffDoc, "bpmEvents")) bpmRaw.push([num(e, "b"), num(e, "m")]);
  } else if (fmt === 2) {
    for (const e of arr(diffDoc, "_events")) if (int(num(e, "_type", -1)) === 100) bpmRaw.push([num(e, "_time"), num(e, "_floatValue")]);
    if (!bpmRaw.length) {
      const cd = diffDoc["_customData"];
      if (isObj(cd)) {
        let lst = cd["_BPMChanges"];
        if (!Array.isArray(lst)) lst = cd["_bpmChanges"];
        if (Array.isArray(lst)) {
          for (const e of lst) {
            let b = num(e, "_BPM", 0);
            if (b <= 0) b = num(e, "_bpm", 0);
            bpmRaw.push([num(e, "_time"), b]);
          }
        }
      }
    }
  }
  if (!tm.setBpmChanges(bpmRaw) && audioDoc !== undefined) {
    const [regs, freq] = loadAudioRegions(audioDoc);
    tm.setRegions(regs, freq);
  }

  const notes: NoteData[] = [];
  const obstacles: ObstacleData[] = [];
  const events: LightEvent[] = [];
  const colorKeys = new Map<string, number>();
  const chains: [number, number, number, number, number, number, number, number, number][] = [];

  const addColorNote = (beat: number, x: number, y: number, color: number, cut: number, off: number) => {
    const [cd, ang, fl] = swingAngle(cut, off);
    const key = `${beat}|${x}|${y}|${color}`;
    if (!colorKeys.has(key)) colorKeys.set(key, notes.length);
    notes.push({ time: tm.toSeconds(beat), x, y, kind: KIND_NOTE, color, cutDir: cd, flags: fl, angle: ang });
  };
  const addBomb = (beat: number, x: number, y: number) =>
    notes.push({ time: tm.toSeconds(beat), x, y, kind: KIND_BOMB, color: COLOR_NONE, cutDir: CUT_ANY, flags: FLAG_DOT, angle: 0 });
  const addObstacle = (beat: number, durBeats: number, x: number, y: number, w: number, h: number) => {
    const t0 = tm.toSeconds(beat), t1 = tm.toSeconds(beat + durBeats);
    if (t1 - t0 <= 0 || w <= 0 || h <= 0) return;
    obstacles.push({ time: t0, duration: t1 - t0, x, y, w, h });
  };
  const addEvent = (beat: number, type: number, value: number, f: number) => {
    if (type >= 0 && type <= 4) events.push({ time: tm.toSeconds(beat), type, value, brightness: f });
  };

  if (fmt === 2) {
    for (const n of arr(diffDoc, "_notes")) {
      const t = int(num(n, "_type", -1));
      const beat = num(n, "_time");
      const x = mePosition(num(n, "_lineIndex")), y = mePosition(num(n, "_lineLayer"));
      if (t === 0 || t === 1) addColorNote(beat, x, y, t, num(n, "_cutDirection", 8), 0);
      else if (t === 3) addBomb(beat, x, y);
    }
    for (const o of arr(diffDoc, "_obstacles")) {
      const t = int(num(o, "_type", 0));
      const x = mePosition(num(o, "_lineIndex"));
      let w = num(o, "_width", 1);
      if (w >= 1000) w = (w - 1000) / 1000;
      let y = 0, h = 5;
      if (t === 1) { y = 2; h = 3; }
      else if (t === 2) { y = num(o, "_lineLayer"); h = num(o, "_height", 5); }
      addObstacle(num(o, "_time"), num(o, "_duration"), x, y, w, h);
    }
    for (const e of arr(diffDoc, "_events")) addEvent(num(e, "_time"), int(num(e, "_type", -1)), int(num(e, "_value")), num(e, "_floatValue", 1));
  } else if (fmt === 3) {
    for (const n of arr(diffDoc, "colorNotes")) addColorNote(num(n, "b"), num(n, "x"), num(n, "y"), int(num(n, "c")) & 1, num(n, "d", 8), num(n, "a"));
    for (const n of arr(diffDoc, "bombNotes")) addBomb(num(n, "b"), num(n, "x"), num(n, "y"));
    for (const o of arr(diffDoc, "obstacles")) addObstacle(num(o, "b"), num(o, "d"), num(o, "x"), num(o, "y"), num(o, "w", 1), num(o, "h", 5));
    for (const c of arr(diffDoc, "burstSliders"))
      chains.push([num(c, "b"), num(c, "x"), num(c, "y"), int(num(c, "c")) & 1, num(c, "tb"), num(c, "tx"), num(c, "ty"), int(num(c, "sc", 1)), num(c, "s", 1)]);
    for (const e of arr(diffDoc, "basicBeatmapEvents")) addEvent(num(e, "b"), int(num(e, "et", -1)), int(num(e, "i")), num(e, "f", 1));
  } else {
    const cdata = arr(diffDoc, "colorNotesData"), bdata = arr(diffDoc, "bombNotesData");
    const odata = arr(diffDoc, "obstaclesData"), chdata = arr(diffDoc, "chainsData");
    for (const n of arr(diffDoc, "colorNotes")) {
      const i = int(num(n, "i"));
      if (i >= 0 && i < cdata.length) {
        const d = cdata[i];
        addColorNote(num(n, "b"), num(d, "x"), num(d, "y"), int(num(d, "c")) & 1, num(d, "d", 8), num(d, "a"));
      }
    }
    for (const n of arr(diffDoc, "bombNotes")) {
      const i = int(num(n, "i"));
      if (i >= 0 && i < bdata.length) addBomb(num(n, "b"), num(bdata[i], "x"), num(bdata[i], "y"));
    }
    for (const o of arr(diffDoc, "obstacles")) {
      const i = int(num(o, "i"));
      if (i >= 0 && i < odata.length) {
        const d = odata[i];
        addObstacle(num(o, "b"), num(d, "d"), num(d, "x"), num(d, "y"), num(d, "w", 1), num(d, "h", 5));
      }
    }
    for (const c of arr(diffDoc, "chains")) {
      const i = int(num(c, "i")), ci = int(num(c, "ci"));
      if (i >= 0 && i < cdata.length && ci >= 0 && ci < chdata.length) {
        const h = cdata[i], d = chdata[ci];
        chains.push([num(c, "hb"), num(h, "x"), num(h, "y"), int(num(h, "c")) & 1, num(c, "tb"), num(d, "tx"), num(d, "ty"), int(num(d, "c", 1)), num(d, "s", 1)]);
      }
    }
  }

  for (const [hb, hx, hy, col, tb, tx, ty, sc, sq] of chains) {
    const head = colorKeys.get(`${hb}|${hx}|${hy}|${col}`);
    if (head !== undefined) notes[head].flags |= FLAG_CHAIN_HEAD;
    if (sc < 2) continue;
    for (let i = 1; i < sc; i++) {
      const f = i / (sc - 1);
      notes.push({
        time: tm.toSeconds(hb + (tb - hb) * f), x: hx + (tx - hx) * f * sq, y: hy + (ty - hy) * f * sq,
        kind: KIND_CHAIN_LINK, color: col, cutDir: CUT_ANY, flags: FLAG_DOT, angle: 0,
      });
    }
  }

  // ordenacao estavel por tempo (igual ao sort do Python)
  notes.sort((a, b) => a.time - b.time);
  obstacles.sort((a, b) => a.time - b.time);
  events.sort((a, b) => a.time - b.time);

  let maxScore = 0, mult = 1, progress = 0;
  for (const n of notes) {
    if (n.kind === KIND_BOMB) continue;
    const value = n.kind === KIND_CHAIN_LINK ? SCORE_CHAIN_LINK_MAX : n.flags & FLAG_CHAIN_HEAD ? SCORE_CHAIN_HEAD_MAX : SCORE_NOTE_MAX;
    maxScore += value * mult;
    if (mult < 8 && ++progress >= mult * 2) { mult *= 2; progress = 0; }
  }
  let last = 0;
  for (const n of notes) last = Math.max(last, n.time);
  for (const o of obstacles) last = Math.max(last, o.time + o.duration);

  const di = difficultyIndex(dinfo.difficulty);
  const njs = dinfo.njs > 0 ? dinfo.njs : DEFAULT_NJS[di];
  const [hjd, jd] = computeJump(info.bpm, njs, dinfo.offset);
  const ci = CHARACTERISTICS.indexOf(dinfo.characteristic);
  return {
    notes, obstacles, events, bpm: info.bpm, njs, halfJumpSeconds: hjd, jumpDistance: jd, lastObjectTime: last,
    maxScore, difficultyIndex: di, characteristicIndex: ci < 0 ? 255 : ci, format: fmt,
  };
}
