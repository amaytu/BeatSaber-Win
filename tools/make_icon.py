#!/usr/bin/env python3
"""Gera o icone do app (build/icon.png 512x512 e build/icon.ico): dois sabres neon cruzados."""
import os

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "build")
S = 512


def saber(draw_size, p0, p1, color):
    layer = Image.new("RGBA", (draw_size, draw_size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.line([p0, p1], fill=color + (255,), width=46)
    glow = layer.filter(ImageFilter.GaussianBlur(26))
    core = Image.new("RGBA", (draw_size, draw_size), (0, 0, 0, 0))
    dc = ImageDraw.Draw(core)
    dc.line([p0, p1], fill=color + (255,), width=30)
    dc.line([p0, p1], fill=(255, 255, 255, 255), width=12)
    return glow, core


def main():
    os.makedirs(OUT, exist_ok=True)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    # fundo: quadrado arredondado roxo-escuro com borda neon
    bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    db = ImageDraw.Draw(bg)
    db.rounded_rectangle([16, 16, S - 16, S - 16], radius=110, fill=(12, 8, 34, 255), outline=(150, 120, 255, 255), width=10)
    img.alpha_composite(bg)
    red, blue = (255, 40, 80), (40, 150, 255)
    g1, c1 = saber(S, (120, 400), (392, 112), red)
    g2, c2 = saber(S, (392, 400), (120, 112), blue)
    for layer in (g1, g2, g1, g2, c1, c2):
        img.alpha_composite(layer)
    # cabos
    d = ImageDraw.Draw(img)
    for x0, y0, x1, y1 in ((96, 424, 132, 388), (416, 424, 380, 388)):
        d.line([(x0, y0), (x1, y1)], fill=(150, 150, 170, 255), width=34)
    img.save(os.path.join(OUT, "icon.png"))
    img.save(os.path.join(OUT, "icon.ico"), sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
    print("icone gerado em", OUT)


if __name__ == "__main__":
    main()
