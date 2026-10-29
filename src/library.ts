// Biblioteca de musicas: pastas no formato da comunidade (info.dat + .dat + audio + capa).
import { host } from "./host";
import { Beatmap, DifficultyInfo, SongInfo, convertDifficulty, parseInfo, parseJsonText } from "./core/map";

export interface Song {
  id: string;
  dir: string;
  info: SongInfo;
  mtime: number;
}

let songs: Song[] = [];
const coverCache = new Map<string, Promise<string | null>>();
const textDecoder = new TextDecoder("utf-8");

export async function scanLibrary(): Promise<Song[]> {
  const folders = await host.listSongs();
  const out: Song[] = [];
  for (const f of folders) {
    try {
      const info = parseInfo(parseJsonText(f.infoText));
      out.push({ id: f.dir, dir: f.dir, info, mtime: f.mtime });
    } catch {
      /* info.dat ilegivel: ignora */
    }
  }
  out.sort((a, b) => (a.info.songName || "").localeCompare(b.info.songName || "", "pt", { sensitivity: "base" }));
  songs = out;
  return out;
}

export const getSongs = () => songs;

export function coverUrl(song: Song): Promise<string | null> {
  let p = coverCache.get(song.id);
  if (!p) {
    p = (async () => {
      if (!song.info.coverFile) return null;
      const buf = await host.readSongFile(song.dir, song.info.coverFile).catch(() => null);
      if (!buf) return null;
      const type = /\.png$/i.test(song.info.coverFile) ? "image/png" : "image/jpeg";
      return URL.createObjectURL(new Blob([buf], { type }));
    })();
    coverCache.set(song.id, p);
  }
  return p;
}

async function readJson(song: Song, name: string): Promise<unknown | undefined> {
  if (!name) return undefined;
  const buf = await host.readSongFile(song.dir, name).catch(() => null);
  if (!buf) return undefined;
  return parseJsonText(textDecoder.decode(buf));
}

export async function loadBeatmap(song: Song, d: DifficultyInfo): Promise<Beatmap> {
  const doc = await readJson(song, d.filename);
  if (doc === undefined) throw new Error(`Arquivo "${d.filename}" não encontrado na pasta da música.`);
  let audio: unknown;
  try {
    audio = await readJson(song, song.info.audioDataFile);
  } catch {
    audio = undefined;
  }
  return convertDifficulty(doc, song.info, d, audio);
}

// URLs de audio das previas: as ultimas musicas vistas ficam prontas (voltar a uma e instantaneo)
const previewCache = new Map<string, Promise<string | null>>();
const PREVIEW_CACHE_MAX = 8;

function audioMime(file: string) {
  if (/\.(egg|ogg)$/i.test(file)) return "audio/ogg";
  if (/\.wav$/i.test(file)) return "audio/wav";
  if (/\.mp3$/i.test(file)) return "audio/mpeg";
  return "application/octet-stream";
}

/** URL (blob) do audio da musica para a previa, com cache das mais recentes. */
export function previewUrl(song: Song): Promise<string | null> {
  const hit = previewCache.get(song.id);
  if (hit) {
    previewCache.delete(song.id); // move para o fim (mais recente)
    previewCache.set(song.id, hit);
    return hit;
  }
  const p = loadAudio(song).then((buf) => (buf ? URL.createObjectURL(new Blob([buf], { type: audioMime(song.info.songFile) })) : null));
  previewCache.set(song.id, p);
  while (previewCache.size > PREVIEW_CACHE_MAX) {
    const [oldId, old] = previewCache.entries().next().value!;
    previewCache.delete(oldId);
    old.then((u) => u && URL.revokeObjectURL(u));
  }
  return p;
}

export async function loadAudio(song: Song): Promise<ArrayBuffer | null> {
  return host.readSongFile(song.dir, song.info.songFile).catch(() => null);
}

/** Dificuldades jogaveis (Standard primeiro, depois as outras caracteristicas). */
export function playableDifficulties(song: Song): DifficultyInfo[] {
  const order = ["Easy", "Normal", "Hard", "Expert", "ExpertPlus"];
  return song.info.difficulties
    .filter((d) => d.characteristic !== "Lightshow")
    .sort((a, b) => {
      const ca = a.characteristic === "Standard" ? 0 : 1, cb = b.characteristic === "Standard" ? 0 : 1;
      if (ca !== cb) return ca - cb;
      if (a.characteristic !== b.characteristic) return a.characteristic.localeCompare(b.characteristic);
      return order.indexOf(a.difficulty) - order.indexOf(b.difficulty);
    });
}
