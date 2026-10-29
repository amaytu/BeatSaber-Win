#!/usr/bin/env python3
"""
make_demo_song.py - Gera musicas de demonstracao no formato ORIGINAL do Beat Saber.

Cria tres pastas (uma por versao de formato: v2, v3 e v4) com:
  * info.dat / Info.dat
  * audio WAV sintetizado (batida + baixo, sem direitos autorais)
  * dificuldades Easy/Expert com notas, bombas, paredes, chains e luzes
  * capa cover.png 256x256 (se o Pillow estiver instalado)

Serve para testar a leitura de mapas sem precisar
de mapas de terceiros.

Uso: python3 tools/make_demo_song.py <pasta_de_saida>
"""

import json
import math
import os
import random
import struct
import sys

BPM = 120.0
BEATS = 96            # 48 segundos a 120 BPM
SAMPLE_RATE = 44100


def write_wav(path, seconds):
    n = int(seconds * SAMPLE_RATE)
    spb = 60.0 / BPM
    bass_notes = [55.0, 55.0, 65.41, 49.0]
    frames = bytearray()
    for i in range(n):
        t = i / SAMPLE_RATE
        beat_pos = t / spb
        bt = (beat_pos - math.floor(beat_pos)) * spb  # tempo desde a ultima batida
        kick = math.sin(2 * math.pi * (50 + 120 * math.exp(-bt * 30)) * bt) * math.exp(-bt * 9)
        half = (beat_pos * 2) % 2.0
        ht = (half - math.floor(half)) * spb / 2
        hat = (random.random() * 2 - 1) * math.exp(-ht * 60) * 0.25 if int(beat_pos * 2) % 2 == 1 else 0.0
        bar = int(beat_pos / 4) % len(bass_notes)
        f = bass_notes[bar]
        bass = 0.25 * math.sin(2 * math.pi * f * t) * (0.6 + 0.4 * math.exp(-bt * 4))
        lead = 0.08 * math.sin(2 * math.pi * f * 4 * t) * (1.0 if int(beat_pos) % 8 < 4 else 0.5)
        v = 0.55 * kick + hat + bass + lead
        v = max(-1.0, min(1.0, v))
        s = int(v * 30000)
        frames += struct.pack("<hh", s, s)
    with open(path, "wb") as fp:
        fp.write(b"RIFF")
        fp.write(struct.pack("<I", 36 + len(frames)))
        fp.write(b"WAVEfmt ")
        fp.write(struct.pack("<IHHIIHH", 16, 1, 2, SAMPLE_RATE, SAMPLE_RATE * 4, 4, 16))
        fp.write(b"data")
        fp.write(struct.pack("<I", len(frames)))
        fp.write(frames)


def write_cover(path, hue_shift):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return False
    img = Image.new("RGB", (256, 256), (10, 10, 20))
    d = ImageDraw.Draw(img)
    for i in range(16):
        c = (int(200 * (i % 2)) + hue_shift % 55, 40, int(220 * ((i + 1) % 2)))
        d.rectangle([i * 16, 0, i * 16 + 15, 255], fill=c)
    d.rectangle([64, 64, 191, 191], fill=(240, 240, 240))
    d.polygon([(128, 80), (176, 160), (80, 160)], fill=(220, 30, 50))
    img.save(path)
    return True


def gen_pattern(dense):
    """Gera uma lista de (beat, x, y, color, dir) alternando maos como um mapa real."""
    rnd = random.Random(42 if dense else 7)
    notes = []
    step = 0.5 if dense else 1.0
    beat = 4.0
    down = True
    while beat < BEATS - 4:
        d_left = 1 if down else 0
        d_right = 1 if down else 0
        if dense and rnd.random() < 0.25:
            d_left = rnd.choice([6, 7, 4, 5])
            d_right = rnd.choice([6, 7, 4, 5])
        if rnd.random() < 0.15:
            d_left = d_right = 8
        y = 0 if down else 1
        notes.append((beat, rnd.choice([0, 1]), y, 0, d_left))
        notes.append((beat, rnd.choice([2, 3]), y, 1, d_right))
        down = not down
        beat += step * (2 if not dense else 1)
    return notes


def build_v2(dense):
    notes = []
    for (b, x, y, c, d) in gen_pattern(dense):
        notes.append({"_time": b, "_lineIndex": x, "_lineLayer": y, "_type": c, "_cutDirection": d})
    notes.append({"_time": 30.0, "_lineIndex": 1, "_lineLayer": 2, "_type": 3, "_cutDirection": 0})
    notes.append({"_time": 30.0, "_lineIndex": 2, "_lineLayer": 2, "_type": 3, "_cutDirection": 0})
    obstacles = [
        {"_time": 40.0, "_lineIndex": 0, "_type": 0, "_duration": 4.0, "_width": 1},
        {"_time": 56.0, "_lineIndex": 0, "_type": 1, "_duration": 2.0, "_width": 4},
    ]
    events = []
    for b in range(0, BEATS, 1):
        events.append({"_time": float(b), "_type": b % 5, "_value": 1 + (b % 3) * 2, "_floatValue": 1.0})
    # mudanca de BPM no meio (mesmo valor -> nao altera o ritmo, mas exercita o caminho)
    events.append({"_time": 48.0, "_type": 100, "_value": 0, "_floatValue": BPM})
    return {"_version": "2.6.0", "_notes": notes, "_obstacles": obstacles, "_events": events,
            "_sliders": [], "_waypoints": []}


def build_v3(dense):
    color = []
    for (b, x, y, c, d) in gen_pattern(dense):
        color.append({"b": b, "x": x, "y": y, "c": c, "d": d, "a": 0})
    color = [n for n in color if not (n["b"] == 64.0 and n["c"] == 0)]
    color.append({"b": 64.0, "x": 1, "y": 2, "c": 0, "d": 1, "a": 0})
    chains = [{"b": 64.0, "x": 1, "y": 2, "c": 0, "d": 1, "tb": 64.5, "tx": 1, "ty": 0, "sc": 5, "s": 1.0}]
    bombs = [{"b": 30.0, "x": 1, "y": 2}, {"b": 30.0, "x": 2, "y": 2}]
    obstacles = [{"b": 40.0, "x": 0, "y": 0, "d": 4.0, "w": 1, "h": 5},
                 {"b": 56.0, "x": 0, "y": 2, "d": 2.0, "w": 4, "h": 3}]
    events = [{"b": float(b), "et": b % 5, "i": 1 + (b % 3) * 2, "f": 1.0} for b in range(BEATS)]
    return {"version": "3.3.0", "bpmEvents": [{"b": 0.0, "m": BPM}], "rotationEvents": [],
            "colorNotes": color, "bombNotes": bombs, "obstacles": obstacles,
            "sliders": [], "burstSliders": chains, "waypoints": [],
            "basicBeatmapEvents": events, "colorBoostBeatmapEvents": [],
            "lightColorEventBoxGroups": [], "lightRotationEventBoxGroups": [],
            "lightTranslationEventBoxGroups": [], "basicEventTypesWithKeywords": {},
            "useNormalEventsAsCompatibleEvents": True}


def build_v4(dense):
    color_notes = []
    color_data = []
    for (b, x, y, c, d) in gen_pattern(dense):
        color_data.append({"x": x, "y": y, "c": c, "d": d, "a": 0})
        color_notes.append({"b": b, "r": 0, "i": len(color_data) - 1})
    bomb_data = [{"x": 1, "y": 2}, {"x": 2, "y": 2}]
    bombs = [{"b": 30.0, "r": 0, "i": 0}, {"b": 30.0, "r": 0, "i": 1}]
    obs_data = [{"d": 4.0, "x": 0, "y": 0, "w": 1, "h": 5}, {"d": 2.0, "x": 0, "y": 2, "w": 4, "h": 3}]
    obstacles = [{"b": 40.0, "r": 0, "i": 0}, {"b": 56.0, "r": 0, "i": 1}]
    return {"version": "4.0.0", "colorNotes": color_notes, "colorNotesData": color_data,
            "bombNotes": bombs, "bombNotesData": bomb_data,
            "obstacles": obstacles, "obstaclesData": obs_data,
            "arcs": [], "arcsData": [], "chains": [], "chainsData": [],
            "spawnRotations": [], "spawnRotationsData": []}


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    seconds = BEATS * 60.0 / BPM + 1.0

    for ver in (2, 3, 4):
        folder = os.path.join(out, "Win Saber Demo v%d" % ver)
        os.makedirs(folder, exist_ok=True)
        write_wav(os.path.join(folder, "song.wav"), seconds)
        has_cover = write_cover(os.path.join(folder, "cover.png"), ver * 40)
        builder = {2: build_v2, 3: build_v3, 4: build_v4}[ver]
        for name, dense in (("Easy", False), ("Expert", True)):
            with open(os.path.join(folder, "%sStandard.dat" % name), "w") as f:
                json.dump(builder(dense), f)
        if ver == 4:
            info = {
                "version": "4.0.0",
                "song": {"title": "Win Saber Demo v4", "subTitle": "formato 4.x", "author": "Win Saber"},
                "audio": {"songFilename": "song.wav", "songDuration": seconds,
                          "audioDataFilename": "AudioData.dat", "bpm": BPM, "lufs": 0.0,
                          "previewStartTime": 8.0, "previewDuration": 10.0},
                "songPreviewFilename": "song.wav",
                "coverImageFilename": "cover.png" if has_cover else "",
                "environmentNames": ["DefaultEnvironment"], "colorSchemes": [],
                "difficultyBeatmaps": [
                    {"characteristic": "Standard", "difficulty": d, "beatmapAuthors": {"mappers": ["make_demo_song.py"], "lighters": []},
                     "environmentNameIdx": 0, "beatmapColorSchemeIdx": 0,
                     "noteJumpMovementSpeed": njs, "noteJumpStartBeatOffset": 0.0,
                     "lightshowDataFilename": "", "beatmapDataFilename": "%sStandard.dat" % d}
                    for d, njs in (("Easy", 10.0), ("Expert", 16.0))
                ],
            }
            audio = {"version": "4.0.0", "songChecksum": "", "songSampleCount": int(seconds * SAMPLE_RATE),
                     "songFrequency": SAMPLE_RATE,
                     "bpmData": [{"si": 0, "ei": int(seconds * SAMPLE_RATE), "sb": 0.0,
                                  "eb": seconds * BPM / 60.0}], "lufsData": []}
            with open(os.path.join(folder, "AudioData.dat"), "w") as f:
                json.dump(audio, f)
            info_name = "Info.dat"
        else:
            info = {
                "_version": "2.1.0",
                "_songName": "Win Saber Demo v%d" % ver,
                "_songSubName": "formato %d.x" % ver,
                "_songAuthorName": "Win Saber",
                "_levelAuthorName": "make_demo_song.py",
                "_beatsPerMinute": BPM,
                "_songTimeOffset": 0,
                "_shuffle": 0, "_shufflePeriod": 0.5,
                "_previewStartTime": 8.0, "_previewDuration": 10.0,
                "_songFilename": "song.wav",
                "_coverImageFilename": "cover.png" if has_cover else "",
                "_environmentName": "DefaultEnvironment",
                "_difficultyBeatmapSets": [{
                    "_beatmapCharacteristicName": "Standard",
                    "_difficultyBeatmaps": [
                        {"_difficulty": d, "_difficultyRank": r, "_beatmapFilename": "%sStandard.dat" % d,
                         "_noteJumpMovementSpeed": njs, "_noteJumpStartBeatOffset": 0}
                        for d, r, njs in (("Easy", 1, 10), ("Expert", 7, 16))
                    ]}],
            }
            info_name = "info.dat" if ver == 2 else "Info.dat"
        with open(os.path.join(folder, info_name), "w") as f:
            json.dump(info, f, indent=1)
        print("Criado: %s" % folder)
    return 0


if __name__ == "__main__":
    sys.exit(main())
