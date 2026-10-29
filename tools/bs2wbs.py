#!/usr/bin/env python3
"""
bs2wbs.py - Conversor de referencia dos mapas da comunidade para o formato binario .wbs

Usado pelos testes (tests/core.test.ts) como referencia para o leitor de mapas do app.

Le pastas de musicas no formato original do Beat Saber (info.dat + <dificuldade>.dat
+ audio .ogg/.egg/.wav + capa) e gera, para cada dificuldade, um arquivo
"<Caracteristica>_<Dificuldade>.wbs" na propria pasta da musica (ou em --out).

Formatos suportados:
  * info.dat v2 (_version 2.x) e v4 (version 4.x)
  * dificuldades v2 (_notes/_obstacles/_events), v3 (colorNotes/bombNotes/
    obstacles/burstSliders/bpmEvents/basicBeatmapEvents) e v4 (colorNotes +
    colorNotesData, bombNotes + bombNotesData, obstacles + obstaclesData,
    chains + chainsData)
  * mudancas de BPM: eventos v2 tipo 100, _customData._BPMChanges, bpmEvents
    v3, BPMInfo.dat (v2) e AudioData.dat (v4)
  * Mapping Extensions (posicoes/direcoes >= 1000) em mapas v2
  * arquivos .zip baixados do BeatSaver (--extract-zips)

O mesmo algoritmo e usado pelo leitor de mapas do app (src/core/map.ts);
tests/core.test.ts compara os dois.

Uso:
  python3 tools/bs2wbs.py <pasta_de_musicas | pasta_da_musica | arquivo.zip> [...]
          [--out DIR] [--force] [--extract-zips] [-v]
"""

import argparse
import json
import math
import os
import struct
import sys
import zipfile
import zlib

WBS_MAGIC = b"WBS1"
WBS_VERSION = 1
HEADER_SIZE = 64
NOTE_SIZE = 16
OBSTACLE_SIZE = 20
EVENT_SIZE = 8

KIND_NOTE = 0
KIND_BOMB = 1
KIND_CHAIN_LINK = 2

COLOR_LEFT = 0
COLOR_RIGHT = 1
COLOR_NONE = 255

FLAG_CHAIN_HEAD = 0x01
FLAG_DOT = 0x02

HDR_FLAG_CHAINS = 0x01
HDR_FLAG_LIGHTS = 0x02
HDR_FLAG_BPM_CHANGES = 0x04

DIFFICULTIES = ["Easy", "Normal", "Hard", "Expert", "ExpertPlus"]
DEFAULT_NJS = [10.0, 10.0, 10.0, 12.0, 16.0]
CHARACTERISTICS = ["Standard", "OneSaber", "NoArrows", "360Degree", "90Degree",
                   "Lightshow", "Lawless", "Legacy"]

# Angulo de swing (graus, 0 = direita, anti-horario) para cutDirection 0..7
BASE_ANGLE = [90, 270, 180, 0, 135, 45, 225, 315]

MAX_SCORE_NOTE = 115
MAX_SCORE_CHAIN_HEAD = 85
MAX_SCORE_CHAIN_LINK = 20


# --------------------------------------------------------------------------
# utilitarios
# --------------------------------------------------------------------------

def num(obj, key, default=0.0):
    """Le um numero de um dict JSON; booleanos/strings/ausente -> default."""
    if not isinstance(obj, dict):
        return default
    v = obj.get(key, default)
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    return float(v)


def arr(obj, key):
    if not isinstance(obj, dict):
        return []
    v = obj.get(key)
    return v if isinstance(v, list) else []


def string(obj, key, default=""):
    if not isinstance(obj, dict):
        return default
    v = obj.get(key)
    return v if isinstance(v, str) else default


def to_fixed(v):
    """float (unidades de lane/layer) -> 8.8 fixo com saturacao em int16."""
    r = math.floor(v * 256.0 + 0.5)
    if r > 32767:
        r = 32767
    if r < -32768:
        r = -32768
    return int(r)


def me_position(v):
    """Mapping Extensions: |v| >= 1000 codifica posicao precisa (milesimos de lane)."""
    if v >= 1000.0:
        return (v - 1000.0) / 1000.0
    if v <= -1000.0:
        return (v + 1000.0) / 1000.0
    return v


def find_file_ci(folder, name):
    """Busca um arquivo ignorando maiusculas/minusculas (info.dat vs Info.dat)."""
    if not name:
        return None
    direct = os.path.join(folder, name)
    if os.path.isfile(direct):
        return direct
    low = name.lower()
    try:
        for entry in os.listdir(folder):
            if entry.lower() == low and os.path.isfile(os.path.join(folder, entry)):
                return os.path.join(folder, entry)
    except OSError:
        pass
    return None


def load_json(path):
    with open(path, "rb") as f:
        raw = f.read()
    if raw.startswith(b"\xef\xbb\xbf"):
        raw = raw[3:]
    return json.loads(raw.decode("utf-8", errors="replace"))


# --------------------------------------------------------------------------
# info.dat
# --------------------------------------------------------------------------

class DifficultyInfo:
    def __init__(self):
        self.characteristic = "Standard"
        self.difficulty = "Expert"
        self.filename = ""
        self.njs = 0.0
        self.offset = 0.0


class SongInfo:
    def __init__(self):
        self.version = 2
        self.song_name = ""
        self.sub_name = ""
        self.artist = ""
        self.mapper = ""
        self.bpm = 120.0
        self.song_file = ""
        self.cover_file = ""
        self.audio_data_file = ""
        self.preview_start = 0.0
        self.difficulties = []


def parse_info(doc):
    info = SongInfo()
    if not isinstance(doc, dict):
        raise ValueError("info.dat invalido")
    ver = string(doc, "version")
    if ver.startswith("4"):
        info.version = 4
        song = doc.get("song", {})
        audio = doc.get("audio", {})
        info.song_name = string(song, "title")
        info.sub_name = string(song, "subTitle")
        info.artist = string(song, "author")
        info.bpm = num(audio, "bpm", 120.0)
        info.song_file = string(audio, "songFilename")
        info.audio_data_file = string(audio, "audioDataFilename")
        info.preview_start = num(audio, "previewStartTime", 0.0)
        info.cover_file = string(doc, "coverImageFilename")
        for d in arr(doc, "difficultyBeatmaps"):
            di = DifficultyInfo()
            di.characteristic = string(d, "characteristic", "Standard")
            di.difficulty = string(d, "difficulty", "Expert")
            di.filename = string(d, "beatmapDataFilename")
            di.njs = num(d, "noteJumpMovementSpeed", 0.0)
            di.offset = num(d, "noteJumpStartBeatOffset", 0.0)
            authors = d.get("beatmapAuthors", {}) if isinstance(d, dict) else {}
            mappers = arr(authors, "mappers")
            if not info.mapper and mappers and isinstance(mappers[0], str):
                info.mapper = mappers[0]
            info.difficulties.append(di)
    else:
        info.version = 2
        info.song_name = string(doc, "_songName")
        info.sub_name = string(doc, "_songSubName")
        info.artist = string(doc, "_songAuthorName")
        info.mapper = string(doc, "_levelAuthorName")
        info.bpm = num(doc, "_beatsPerMinute", 120.0)
        info.song_file = string(doc, "_songFilename")
        info.cover_file = string(doc, "_coverImageFilename")
        info.preview_start = num(doc, "_previewStartTime", 0.0)
        info.audio_data_file = "BPMInfo.dat"
        for s in arr(doc, "_difficultyBeatmapSets"):
            ch = string(s, "_beatmapCharacteristicName", "Standard")
            for d in arr(s, "_difficultyBeatmaps"):
                di = DifficultyInfo()
                di.characteristic = ch
                di.difficulty = string(d, "_difficulty", "Expert")
                di.filename = string(d, "_beatmapFilename")
                di.njs = num(d, "_noteJumpMovementSpeed", 0.0)
                di.offset = num(d, "_noteJumpStartBeatOffset", 0.0)
                info.difficulties.append(di)
    if info.bpm <= 0.0:
        info.bpm = 120.0
    return info


# --------------------------------------------------------------------------
# Conversao de tempo (beats -> segundos)
# --------------------------------------------------------------------------

class TimeMap:
    """
    Converte beats em segundos. Usa (em ordem de prioridade):
      1. mudancas de BPM do proprio arquivo de dificuldade
      2. regioes do BPMInfo.dat / AudioData.dat
      3. BPM constante do info.dat
    """

    def __init__(self, bpm):
        self.bpm = bpm
        self.changes = []   # [(beat, bpm, time_at_beat)]
        self.regions = []   # [(start_beat, end_beat, start_time, sec_per_beat)]

    def set_bpm_changes(self, raw):
        # raw: lista de (beat, bpm) na ordem do arquivo
        pts = [(b, m) for (b, m) in raw if m > 0.0]
        pts.sort(key=lambda p: p[0])
        if not pts:
            return False
        changes = []
        if pts[0][0] > 0.0:
            changes.append((0.0, self.bpm, 0.0))
        for b, m in pts:
            if changes:
                pb, pm, pt = changes[-1]
                t = pt + (b - pb) * 60.0 / pm
            else:
                t = b * 60.0 / self.bpm
            changes.append((b, m, t))
        self.changes = changes
        return True

    def set_regions(self, raw, freq):
        # raw: lista de (si, ei, sb, eb)
        if freq <= 0.0:
            return False
        regs = []
        for si, ei, sb, eb in raw:
            if eb <= sb or ei <= si:
                continue
            spb = ((ei - si) / freq) / (eb - sb)
            regs.append((sb, eb, si / freq, spb))
        regs.sort(key=lambda r: r[0])
        if not regs:
            return False
        self.regions = regs
        return True

    def to_seconds(self, beat):
        if self.changes:
            seg = self.changes[0]
            for c in self.changes:
                if c[0] <= beat:
                    seg = c
                else:
                    break
            return seg[2] + (beat - seg[0]) * 60.0 / seg[1]
        if self.regions:
            first = self.regions[0]
            if beat < first[0]:
                return first[2] + (beat - first[0]) * first[3]
            seg = first
            for r in self.regions:
                if r[0] <= beat:
                    seg = r
                else:
                    break
            return seg[2] + (beat - seg[0]) * seg[3]
        return beat * 60.0 / self.bpm


def load_audio_regions(doc):
    """Retorna (lista_regioes, frequencia) a partir de BPMInfo.dat (v2) ou AudioData.dat (v4)."""
    if not isinstance(doc, dict):
        return [], 0.0
    if "bpmData" in doc:
        freq = num(doc, "songFrequency", 44100.0)
        regs = [(num(r, "si"), num(r, "ei"), num(r, "sb"), num(r, "eb")) for r in arr(doc, "bpmData")]
        return regs, freq
    freq = num(doc, "_songFrequency", 44100.0)
    regs = [(num(r, "_startSampleIndex"), num(r, "_endSampleIndex"),
             num(r, "_startBeat"), num(r, "_endBeat")) for r in arr(doc, "_regions")]
    return regs, freq


# --------------------------------------------------------------------------
# Conversao da dificuldade
# --------------------------------------------------------------------------

def swing_angle(cut_dir, offset):
    """Retorna (cutDirection normalizado, angulo do swing, flags)."""
    flags = 0
    cd = int(cut_dir)
    off = int(offset)
    if 1000 <= cd <= 1360:
        # Mapping Extensions: 1000 + graus, 0 = para baixo, anti-horario
        ang = 270 + (cd - 1000) + off
        cd = 1
    elif 0 <= cd <= 7:
        ang = BASE_ANGLE[cd] + off
    else:
        cd = 8
        flags |= FLAG_DOT
        ang = off
    ang = ((ang % 360) + 360) % 360
    return cd, ang, flags


def difficulty_index(name):
    try:
        return DIFFICULTIES.index(name)
    except ValueError:
        return 3


def characteristic_index(name):
    try:
        return CHARACTERISTICS.index(name)
    except ValueError:
        return 255


def compute_jump(bpm, njs, offset):
    num_ = 60.0 / bpm
    hjd = 4.0
    while njs * num_ * hjd > 17.999:
        hjd /= 2.0
    hjd += offset
    if hjd < 0.25:
        hjd = 0.25
    hjd_sec = num_ * hjd
    jump_distance = njs * hjd_sec * 2.0
    return hjd_sec, jump_distance


def detect_format(doc):
    ver = string(doc, "version")
    if ver.startswith("4"):
        return 4
    if ver.startswith("3") or "colorNotes" in doc:
        return 3
    return 2


def convert_difficulty(diff_doc, info, dinfo, audio_doc=None):
    """Converte um documento de dificuldade (dict) para bytes .wbs."""
    if not isinstance(diff_doc, dict):
        raise ValueError("arquivo de dificuldade invalido")
    fmt = detect_format(diff_doc)
    tm = TimeMap(info.bpm)
    flags = 0

    # ---- BPM ----
    bpm_raw = []
    if fmt == 3:
        for e in arr(diff_doc, "bpmEvents"):
            bpm_raw.append((num(e, "b"), num(e, "m")))
    elif fmt == 2:
        for e in arr(diff_doc, "_events"):
            if int(num(e, "_type", -1.0)) == 100:
                bpm_raw.append((num(e, "_time"), num(e, "_floatValue")))
        if not bpm_raw:
            cd = diff_doc.get("_customData")
            if isinstance(cd, dict):
                lst = cd.get("_BPMChanges")
                if not isinstance(lst, list):
                    lst = cd.get("_bpmChanges")
                if isinstance(lst, list):
                    for e in lst:
                        bpm = num(e, "_BPM", 0.0)
                        if bpm <= 0.0:
                            bpm = num(e, "_bpm", 0.0)
                        bpm_raw.append((num(e, "_time"), bpm))
    if tm.set_bpm_changes(bpm_raw):
        flags |= HDR_FLAG_BPM_CHANGES
    elif audio_doc is not None:
        regs, freq = load_audio_regions(audio_doc)
        if tm.set_regions(regs, freq):
            flags |= HDR_FLAG_BPM_CHANGES

    notes = []      # (time, x, y, kind, color, cutdir, flags, angle)
    obstacles = []  # (time, dur, x, y, w, h)
    events = []     # (time, type, value, brightness)
    color_keys = {}  # (beat, x, y, color) -> indice em notes (para cabecas de chain)
    chains = []     # (hb, hx, hy, color, tb, tx, ty, sc, s)

    def add_color_note(beat, x, y, color, cut, off):
        cdn, ang, fl = swing_angle(cut, off)
        idx = len(notes)
        notes.append([tm.to_seconds(beat), x, y, KIND_NOTE, color, cdn, fl, ang])
        key = (beat, x, y, color)
        if key not in color_keys:
            color_keys[key] = idx

    def add_bomb(beat, x, y):
        notes.append([tm.to_seconds(beat), x, y, KIND_BOMB, COLOR_NONE, 8, FLAG_DOT, 0])

    def add_obstacle(beat, dur_beats, x, y, w, h):
        t0 = tm.to_seconds(beat)
        t1 = tm.to_seconds(beat + dur_beats)
        dur = t1 - t0
        if dur <= 0.0 or w <= 0.0 or h <= 0.0:
            return
        obstacles.append((t0, dur, x, y, w, h))

    def add_event(beat, etype, value, fval):
        if 0 <= etype <= 4:
            events.append((tm.to_seconds(beat), etype, value, fval))

    if fmt == 2:
        for n in arr(diff_doc, "_notes"):
            t = int(num(n, "_type", -1.0))
            beat = num(n, "_time")
            x = me_position(num(n, "_lineIndex"))
            y = me_position(num(n, "_lineLayer"))
            if t == 0 or t == 1:
                add_color_note(beat, x, y, t, num(n, "_cutDirection", 8.0), 0.0)
            elif t == 3:
                add_bomb(beat, x, y)
        for o in arr(diff_doc, "_obstacles"):
            t = int(num(o, "_type", 0.0))
            x = me_position(num(o, "_lineIndex"))
            w = num(o, "_width", 1.0)
            if w >= 1000.0:
                w = (w - 1000.0) / 1000.0
            if t == 1:
                y, h = 2.0, 3.0
            elif t == 2:
                y, h = num(o, "_lineLayer"), num(o, "_height", 5.0)
            else:
                y, h = 0.0, 5.0
            add_obstacle(num(o, "_time"), num(o, "_duration"), x, y, w, h)
        for e in arr(diff_doc, "_events"):
            fv = num(e, "_floatValue", 1.0)
            add_event(num(e, "_time"), int(num(e, "_type", -1.0)), int(num(e, "_value")), fv)
    elif fmt == 3:
        for n in arr(diff_doc, "colorNotes"):
            add_color_note(num(n, "b"), num(n, "x"), num(n, "y"), int(num(n, "c")) & 1,
                           num(n, "d", 8.0), num(n, "a"))
        for n in arr(diff_doc, "bombNotes"):
            add_bomb(num(n, "b"), num(n, "x"), num(n, "y"))
        for o in arr(diff_doc, "obstacles"):
            add_obstacle(num(o, "b"), num(o, "d"), num(o, "x"), num(o, "y"),
                         num(o, "w", 1.0), num(o, "h", 5.0))
        for c in arr(diff_doc, "burstSliders"):
            chains.append((num(c, "b"), num(c, "x"), num(c, "y"), int(num(c, "c")) & 1,
                           num(c, "tb"), num(c, "tx"), num(c, "ty"),
                           int(num(c, "sc", 1.0)), num(c, "s", 1.0)))
        for e in arr(diff_doc, "basicBeatmapEvents"):
            add_event(num(e, "b"), int(num(e, "et", -1.0)), int(num(e, "i")), num(e, "f", 1.0))
    else:  # v4
        cdata = arr(diff_doc, "colorNotesData")
        bdata = arr(diff_doc, "bombNotesData")
        odata = arr(diff_doc, "obstaclesData")
        chdata = arr(diff_doc, "chainsData")
        for n in arr(diff_doc, "colorNotes"):
            i = int(num(n, "i"))
            if 0 <= i < len(cdata):
                d = cdata[i]
                add_color_note(num(n, "b"), num(d, "x"), num(d, "y"), int(num(d, "c")) & 1,
                               num(d, "d", 8.0), num(d, "a"))
        for n in arr(diff_doc, "bombNotes"):
            i = int(num(n, "i"))
            if 0 <= i < len(bdata):
                d = bdata[i]
                add_bomb(num(n, "b"), num(d, "x"), num(d, "y"))
        for o in arr(diff_doc, "obstacles"):
            i = int(num(o, "i"))
            if 0 <= i < len(odata):
                d = odata[i]
                add_obstacle(num(o, "b"), num(d, "d"), num(d, "x"), num(d, "y"),
                             num(d, "w", 1.0), num(d, "h", 5.0))
        for c in arr(diff_doc, "chains"):
            i = int(num(c, "i"))
            ci = int(num(c, "ci"))
            if 0 <= i < len(cdata) and 0 <= ci < len(chdata):
                h = cdata[i]
                d = chdata[ci]
                chains.append((num(c, "hb"), num(h, "x"), num(h, "y"), int(num(h, "c")) & 1,
                               num(c, "tb"), num(d, "tx"), num(d, "ty"),
                               int(num(d, "c", 1.0)), num(d, "s", 1.0)))

    # ---- chains: marca a cabeca e gera os elos ----
    for (hb, hx, hy, col, tb, tx, ty, sc, sq) in chains:
        key = (hb, hx, hy, col)
        if key in color_keys:
            notes[color_keys[key]][6] |= FLAG_CHAIN_HEAD
        if sc < 2:
            continue
        flags |= HDR_FLAG_CHAINS
        for i in range(1, sc):
            f = i / (sc - 1)
            beat = hb + (tb - hb) * f
            x = hx + (tx - hx) * f * sq
            y = hy + (ty - hy) * f * sq
            notes.append([tm.to_seconds(beat), x, y, KIND_CHAIN_LINK, col, 8, FLAG_DOT, 0])

    notes.sort(key=lambda n: n[0])
    obstacles.sort(key=lambda o: o[0])
    events.sort(key=lambda e: e[0])
    if events:
        flags |= HDR_FLAG_LIGHTS

    # ---- pontuacao maxima (progressao de multiplicador do Beat Saber) ----
    max_score = 0
    mult = 1
    progress = 0
    for n in notes:
        if n[3] == KIND_BOMB:
            continue
        if n[3] == KIND_CHAIN_LINK:
            value = MAX_SCORE_CHAIN_LINK
        elif n[6] & FLAG_CHAIN_HEAD:
            value = MAX_SCORE_CHAIN_HEAD
        else:
            value = MAX_SCORE_NOTE
        max_score += value * mult
        if mult < 8:
            progress += 1
            if progress >= mult * 2:
                mult *= 2
                progress = 0

    last_time = 0.0
    for n in notes:
        if n[0] > last_time:
            last_time = n[0]
    for o in obstacles:
        if o[0] + o[1] > last_time:
            last_time = o[0] + o[1]

    diff_idx = difficulty_index(dinfo.difficulty)
    njs = dinfo.njs if dinfo.njs > 0.0 else DEFAULT_NJS[diff_idx]
    hjd_sec, jump_dist = compute_jump(info.bpm, njs, dinfo.offset)

    # ---- serializacao (big-endian) ----
    payload = bytearray()
    for (t, x, y, kind, color, cd, fl, ang) in notes:
        payload += struct.pack(">fhhBBBBhH", t, to_fixed(x), to_fixed(y), kind, color, cd, fl, ang, 0)
    for (t, d, x, y, w, h) in obstacles:
        payload += struct.pack(">ffhhhhI", t, d, to_fixed(x), to_fixed(y), to_fixed(w), to_fixed(h), 0)
    for (t, et, val, fv) in events:
        br = math.floor(fv * 1000.0 + 0.5)
        br = 0 if br < 0 else (65535 if br > 65535 else int(br))
        payload += struct.pack(">fBBH", t, et & 0xFF, val & 0xFF, br)

    crc = zlib.crc32(bytes(payload)) & 0xFFFFFFFF
    header = struct.pack(">4sHHIIIfffffIBBBBI12x",
                         WBS_MAGIC, WBS_VERSION, flags,
                         len(notes), len(obstacles), len(events),
                         info.bpm, njs, hjd_sec, jump_dist, last_time,
                         max_score, diff_idx, characteristic_index(dinfo.characteristic) & 0xFF,
                         fmt, 0, crc)
    assert len(header) == HEADER_SIZE
    return bytes(header) + bytes(payload)


def wbs_filename(dinfo):
    return "%s_%s.wbs" % (dinfo.characteristic, dinfo.difficulty)


# --------------------------------------------------------------------------
# Processamento de pastas
# --------------------------------------------------------------------------

def convert_song_folder(folder, out_folder=None, force=False, verbose=False):
    info_path = find_file_ci(folder, "info.dat")
    if not info_path:
        return 0, 0
    out_folder = out_folder or folder
    os.makedirs(out_folder, exist_ok=True)
    try:
        info = parse_info(load_json(info_path))
    except Exception as exc:  # noqa: BLE001 - relatorio amigavel
        print("  [ERRO] %s: info.dat ilegivel (%s)" % (folder, exc))
        return 0, 1

    audio_doc = None
    if info.audio_data_file:
        ap = find_file_ci(folder, info.audio_data_file)
        if ap:
            try:
                audio_doc = load_json(ap)
            except Exception:  # noqa: BLE001
                audio_doc = None

    ok = 0
    fail = 0
    name = info.song_name or os.path.basename(folder)
    print("%s - %s" % (info.artist or "?", name))
    for dinfo in info.difficulties:
        src = find_file_ci(folder, dinfo.filename)
        dst = os.path.join(out_folder, wbs_filename(dinfo))
        if not src:
            print("  [AVISO] %s/%s: arquivo '%s' nao encontrado" %
                  (dinfo.characteristic, dinfo.difficulty, dinfo.filename))
            fail += 1
            continue
        if (not force and os.path.isfile(dst)
                and os.path.getmtime(dst) >= os.path.getmtime(src)):
            if verbose:
                print("  [ok] %s (atualizado)" % os.path.basename(dst))
            ok += 1
            continue
        try:
            data = convert_difficulty(load_json(src), info, dinfo, audio_doc)
        except Exception as exc:  # noqa: BLE001
            print("  [ERRO] %s/%s: %s" % (dinfo.characteristic, dinfo.difficulty, exc))
            fail += 1
            continue
        with open(dst, "wb") as f:
            f.write(data)
        n_notes, n_obs, n_ev = struct.unpack_from(">III", data, 8)
        print("  [ok] %-28s notas=%-5d paredes=%-4d luzes=%-5d (%d bytes)" %
              (os.path.basename(dst), n_notes, n_obs, n_ev, len(data)))
        ok += 1

    if out_folder != folder:
        # copia os arquivos da musica (info, audio, capa) quando --out e usado
        import shutil
        for extra in (os.path.basename(info_path), info.song_file, info.cover_file, info.audio_data_file):
            p = find_file_ci(folder, extra)
            if p:
                d = os.path.join(out_folder, os.path.basename(p))
                if force or not os.path.isfile(d):
                    shutil.copyfile(p, d)
    return ok, fail


def extract_zip(zpath, dest_root):
    stem = os.path.splitext(os.path.basename(zpath))[0]
    dest = os.path.join(dest_root, stem)
    os.makedirs(dest, exist_ok=True)
    with zipfile.ZipFile(zpath) as z:
        for member in z.infolist():
            if member.is_dir():
                continue
            base = os.path.basename(member.filename)  # achata e impede path traversal
            if not base:
                continue
            with z.open(member) as src, open(os.path.join(dest, base), "wb") as dst:
                dst.write(src.read())
    return dest


def walk_song_folders(root):
    if find_file_ci(root, "info.dat"):
        yield root
        return
    for dirpath, dirnames, _ in os.walk(root):
        dirnames.sort()
        if dirpath != root and find_file_ci(dirpath, "info.dat"):
            dirnames[:] = []
            yield dirpath


def main(argv=None):
    ap = argparse.ArgumentParser(description="Converte mapas da comunidade (.dat) para o formato de referencia .wbs")
    ap.add_argument("inputs", nargs="+", help="pasta de musicas, pasta de uma musica ou .zip do BeatSaver")
    ap.add_argument("--out", help="diretorio de saida (padrao: ao lado dos .dat originais)")
    ap.add_argument("--force", action="store_true", help="reconverte mesmo se o .wbs estiver atualizado")
    ap.add_argument("--extract-zips", action="store_true",
                    help="extrai .zip encontrados para --out (ou para a pasta do zip)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args(argv)

    total_ok = 0
    total_fail = 0
    songs = 0
    for inp in args.inputs:
        inp = os.path.abspath(inp)
        targets = []
        if os.path.isfile(inp) and inp.lower().endswith(".zip"):
            targets.append(extract_zip(inp, args.out or os.path.dirname(inp)))
        elif os.path.isdir(inp):
            if args.extract_zips:
                for f in sorted(os.listdir(inp)):
                    if f.lower().endswith(".zip"):
                        extract_zip(os.path.join(inp, f), args.out or inp)
                if args.out:
                    targets.extend(walk_song_folders(args.out))
            targets.extend(walk_song_folders(inp))
        else:
            print("Entrada ignorada: %s" % inp)
            continue
        seen = set()
        for folder in targets:
            if folder in seen:
                continue
            seen.add(folder)
            out_folder = None
            if args.out and not os.path.abspath(folder).startswith(os.path.abspath(args.out)):
                rel = os.path.relpath(folder, inp if os.path.isdir(inp) else os.path.dirname(folder))
                out_folder = os.path.join(args.out, rel if rel != "." else os.path.basename(folder))
            ok, fail = convert_song_folder(folder, out_folder, args.force, args.verbose)
            songs += 1
            total_ok += ok
            total_fail += fail

    print("\n%d musica(s), %d dificuldade(s) convertida(s), %d falha(s)." % (songs, total_ok, total_fail))
    return 0 if total_fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
