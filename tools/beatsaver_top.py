#!/usr/bin/env python3
"""
beatsaver_top.py - Baixa os mapas mais populares do BeatSaver (beatsaver.com).

Usa a API publica (api.beatsaver.com) ordenando por avaliacao (Rating) e pula
mapas que precisam de mods: os que exigem Noodle Extensions ou Mapping
Extensions (mods de geometria) e os gerados automaticamente.
Os .zip sao salvos sem modificacao (no app: Musicas > + .zip, ou use a tela Baixar musicas):

    python3 tools/beatsaver_top.py 20 downloads/

Sem dependencias (Python 3 + urllib).
"""

import json
import os
import re
import sys
import time
import urllib.request

API = "https://api.beatsaver.com/search/text/{page}?sortOrder=Rating"
USER_AGENT = "WinSaber/1.0 (jogo de ritmo para PC)"


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def playable_without_mods(doc):
    """Recusa mapas cujas dificuldades exigem mods de geometria."""
    versions = doc.get("versions") or []
    if not versions:
        return False, "sem versao publicada"
    diffs = versions[0].get("diffs") or []
    if not diffs:
        return False, "sem dificuldades"
    if all(d.get("ne") or d.get("me") for d in diffs):
        return False, "exige Noodle/Mapping Extensions"
    if doc.get("automapper"):
        return False, "automapper"
    return True, ""


def safe_name(text):
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", text).strip(" .")
    return text[:80] or "mapa"


def main():
    # nomes de musicas em japones/coreano etc. nao cabem no cp1252 do console do Windows
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "beatsaver_downloads"
    os.makedirs(out_dir, exist_ok=True)

    chosen = []
    page = 0
    while len(chosen) < count and page < 10:
        data = json.loads(get(API.format(page=page)))
        docs = data.get("docs") or []
        if not docs:
            break
        for doc in docs:
            ok, why = playable_without_mods(doc)
            title = "%s - %s" % (doc.get("metadata", {}).get("songAuthorName", "?"),
                                 doc.get("metadata", {}).get("songName", doc.get("name", "?")))
            if not ok:
                print("  pulando %-6s %s (%s)" % (doc.get("id"), title, why))
                continue
            chosen.append((doc, title))
            if len(chosen) >= count:
                break
        page += 1
        time.sleep(0.5)  # gentileza com a API

    total = 0
    for i, (doc, title) in enumerate(chosen, 1):
        v = doc["versions"][0]
        key = doc.get("id", "x")
        mapper = doc.get("metadata", {}).get("levelAuthorName", "")
        path = os.path.join(out_dir, safe_name("%s (%s - %s)" % (key, title, mapper)) + ".zip")
        stats = doc.get("stats", {})
        if os.path.exists(path) and os.path.getsize(path) > 0:
            print("%2d. %s  [ja baixado]" % (i, title))
            continue
        data = get(v["downloadURL"], timeout=180)
        with open(path, "wb") as f:
            f.write(data)
        total += len(data)
        print("%2d. %s  (%s, %d votos +, %.1f MB)" % (i, title, key, stats.get("upvotes", 0), len(data) / 1e6))
        time.sleep(0.3)
    print("%d mapa(s) em %s (%.1f MB baixados agora)" % (len(chosen), out_dir, total / 1e6))


if __name__ == "__main__":
    main()
