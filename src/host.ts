// API do processo principal (electron/preload.cjs).
export interface SongFolder { dir: string; infoText: string; mtime: number }

export interface BsMap {
  id: string;
  name: string;
  songName: string;
  songSubName: string;
  artist: string;
  mapper: string;
  bpm: number;
  duration: number;
  upvotes: number;
  downvotes: number;
  score: number;
  coverURL: string;
  previewURL: string;
  downloadURL: string;
  automapper: boolean;
  needsMods: boolean;
  diffs: { characteristic: string; difficulty: string; ne: boolean; me: boolean; nps: number }[];
  installed: boolean;
}
export type BsSort = "Rating" | "Latest" | "Relevance" | "Curated";

export interface HostApi {
  listSongs(): Promise<SongFolder[]>;
  readSongFile(dir: string, name: string): Promise<ArrayBuffer | null>;
  importZips(): Promise<number>;
  addSongFolder(): Promise<string | null>;
  songDirs(): Promise<string[]>;
  deleteSong(dir: string): Promise<boolean>;
  canDeleteSong(dir: string): Promise<boolean>;
  removeSongDir(dir: string): Promise<string[]>;
  openImportDir(): Promise<string>;
  /** minNps/maxNps: filtro de dificuldade (notas por segundo); 0 = sem limite */
  searchBeatSaver(query: string, sort: BsSort, page: number, minNps?: number, maxNps?: number): Promise<BsMap[]>;
  installBeatSaver(id: string, downloadURL: string, label: string): Promise<string>;
  uninstallBeatSaver(id: string): Promise<boolean>;
  getPrefs(): Promise<unknown>;
  setPrefs(p: unknown): Promise<boolean>;
  toggleFullscreen(): Promise<void>;
  quit(): Promise<void>;
}

declare global {
  interface Window { host: HostApi }
}

export const host: HostApi = window.host;
