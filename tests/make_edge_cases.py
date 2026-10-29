#!/usr/bin/env python3
"""
Gera mapas de teste com casos extremos e fuzz aleatorio, para garantir que
tools/bs2wbs.py e o conversor C++ (wbsconv) produzem saidas byte-identicas.

Uso: python3 tests/make_edge_cases.py <pasta_de_saida> [seed]
"""
import json
import os
import random
import sys


def rnd_num(r, lo, hi, int_prob=0.5):
    if r.random() < int_prob:
        return r.randint(int(lo), int(hi))
    return round(r.uniform(lo, hi), r.choice([1, 2, 3, 6]))


def write(folder, name, obj):
    os.makedirs(folder, exist_ok=True)
    with open(os.path.join(folder, name), "w") as f:
        json.dump(obj, f)


def info_v2(name, bpm, diffs, chars=("Standard",)):
    sets = []
    for ch in chars:
        sets.append({"_beatmapCharacteristicName": ch, "_difficultyBeatmaps": [
            {"_difficulty": d, "_beatmapFilename": "%s%s.dat" % (d, ch),
             "_noteJumpMovementSpeed": njs, "_noteJumpStartBeatOffset": off}
            for d, njs, off in diffs]})
    return {"_version": "2.1.0", "_songName": name, "_songSubName": "", "_songAuthorName": "Teste",
            "_levelAuthorName": "fuzz", "_beatsPerMinute": bpm, "_songFilename": "song.ogg",
            "_coverImageFilename": "cover.jpg", "_previewStartTime": 1.5, "_difficultyBeatmapSets": sets}


def fuzz_v2(r, n):
    notes = []
    for _ in range(n):
        t = r.choice([0, 1, 3, 3, 0, 1, 2])
        x = r.choice([0, 1, 2, 3, 1500, -2500, 4000])
        y = r.choice([0, 1, 2, 1250])
        cd = r.choice([0, 1, 2, 3, 4, 5, 6, 7, 8, 1045, 1300, 9])
        notes.append({"_time": rnd_num(r, 0, 200), "_lineIndex": x, "_lineLayer": y,
                      "_type": t, "_cutDirection": cd})
    obstacles = []
    for _ in range(n // 10):
        obstacles.append({"_time": rnd_num(r, 0, 200), "_lineIndex": r.choice([0, 1, 2, 3, 2000]),
                          "_type": r.choice([0, 1, 2, 5]), "_duration": rnd_num(r, -2, 8),
                          "_width": r.choice([1, 2, 4, 0, 1500]), "_lineLayer": r.randint(0, 2),
                          "_height": r.randint(1, 5)})
    events = []
    for _ in range(n // 2):
        events.append({"_time": rnd_num(r, 0, 200), "_type": r.choice([0, 1, 2, 3, 4, 5, 8, 12, 100]),
                       "_value": r.randint(0, 7), "_floatValue": rnd_num(r, 0, 2)})
    doc = {"_version": "2.5.0", "_notes": notes, "_obstacles": obstacles, "_events": events}
    if r.random() < 0.5:
        doc["_customData"] = {"_BPMChanges": [{"_time": rnd_num(r, 0, 150), "_BPM": rnd_num(r, 60, 250)}
                                              for _ in range(r.randint(1, 4))]}
    return doc


def fuzz_v3(r, n):
    color = [{"b": rnd_num(r, 0, 200), "x": r.randint(0, 3), "y": r.randint(0, 2), "c": r.randint(0, 1),
              "d": r.randint(0, 8), "a": r.choice([0, 0, 15, -30, 45, 400])} for _ in range(n)]
    bombs = [{"b": rnd_num(r, 0, 200), "x": r.randint(0, 3), "y": r.randint(0, 2)} for _ in range(n // 5)]
    obstacles = [{"b": rnd_num(r, 0, 200), "x": r.randint(0, 3), "y": r.randint(0, 2), "d": rnd_num(r, -1, 6),
                  "w": r.randint(0, 4), "h": r.randint(0, 5)} for _ in range(n // 10)]
    chains = []
    for c in r.sample(color, min(len(color), n // 8)):
        chains.append({"b": c["b"], "x": c["x"], "y": c["y"], "c": c["c"], "d": c["d"],
                       "tb": c["b"] + rnd_num(r, 0.1, 1.0), "tx": r.randint(0, 3), "ty": r.randint(0, 2),
                       "sc": r.randint(1, 8), "s": rnd_num(r, 0.2, 1.0)})
    bpm = [{"b": rnd_num(r, 0, 150), "m": rnd_num(r, 70, 240)} for _ in range(r.randint(0, 5))]
    ev = [{"b": rnd_num(r, 0, 200), "et": r.randint(0, 6), "i": r.randint(0, 7), "f": rnd_num(r, 0, 1.5)}
          for _ in range(n // 2)]
    return {"version": "3.2.0", "bpmEvents": bpm, "colorNotes": color, "bombNotes": bombs,
            "obstacles": obstacles, "burstSliders": chains, "basicBeatmapEvents": ev}


def fuzz_v4(r, n):
    cdata = [{"x": r.randint(0, 3), "y": r.randint(0, 2), "c": r.randint(0, 1), "d": r.randint(0, 8),
              "a": r.choice([0, 10, -10])} for _ in range(max(1, n // 4))]
    notes = [{"b": rnd_num(r, 0, 200), "r": 0, "i": r.randint(-1, len(cdata))} for _ in range(n)]
    bdata = [{"x": r.randint(0, 3), "y": r.randint(0, 2)} for _ in range(3)]
    bombs = [{"b": rnd_num(r, 0, 200), "i": r.randint(0, 2)} for _ in range(n // 5)]
    odata = [{"d": rnd_num(r, 0.5, 4), "x": r.randint(0, 3), "y": 0, "w": 1, "h": 5} for _ in range(2)]
    obstacles = [{"b": rnd_num(r, 0, 200), "i": r.randint(0, 1)} for _ in range(n // 10)]
    chdata = [{"tx": r.randint(0, 3), "ty": r.randint(0, 2), "c": r.randint(2, 6), "s": 0.8}]
    chains = [{"hb": notes[k]["b"], "tb": notes[k]["b"] + 0.5, "hr": 0, "tr": 0, "i": notes[k]["i"], "ci": 0}
              for k in range(0, len(notes), 9)]
    return {"version": "4.0.0", "colorNotes": notes, "colorNotesData": cdata, "bombNotes": bombs,
            "bombNotesData": bdata, "obstacles": obstacles, "obstaclesData": odata,
            "chains": chains, "chainsData": chdata}


def main():
    out = sys.argv[1]
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else 1234
    r = random.Random(seed)
    for k in range(6):
        bpm = rnd_num(r, 70, 220, 0.3)
        diffs = [("Easy", 0, 0), ("Normal", rnd_num(r, 5, 25), rnd_num(r, -2, 2)),
                 ("Hard", 18, -1.5), ("Expert", 23.5, 0.25), ("ExpertPlus", 0, -5)]
        chars = ("Standard", "OneSaber") if k % 2 else ("Standard",)
        folder = os.path.join(out, "fuzz_%d" % k)
        fmt = k % 3
        for ch in chars:
            for d, _, _ in diffs:
                n = r.randint(0, 400)
                doc = [fuzz_v2, fuzz_v3, fuzz_v4][fmt](r, n)
                write(folder, "%s%s.dat" % (d, ch), doc)
        write(folder, "info.dat", info_v2("Fuzz %d" % k, bpm, diffs, chars))
        if k == 2:
            # BPMInfo.dat com regioes de tempo variavel (mapa v4 sem bpmEvents)
            write(folder, "BPMInfo.dat", {"_version": "2.0.0", "_songSampleCount": 9000000, "_songFrequency": 44100,
                                          "_regions": [
                                              {"_startSampleIndex": 0, "_endSampleIndex": 441000, "_startBeat": 0,
                                               "_endBeat": 20},
                                              {"_startSampleIndex": 441000, "_endSampleIndex": 1323000,
                                               "_startBeat": 20, "_endBeat": 50.5}]})
    print("Casos de teste gerados em %s" % out)


if __name__ == "__main__":
    main()
