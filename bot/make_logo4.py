#!/usr/bin/env python3
"""Логотип RVA/161: шестигранник-монограмма + иконки в углах (шестерёнка, бирка, лупа, капля).

Несколько цветовых вариантов, 500×500 PNG. Запуск: venv/bin/python make_logo4.py
"""
import math
import shutil

from PIL import Image, ImageDraw, ImageFont

from make_logos import (DIR, FONT_BLACK, S, NAVY, ORANGE, WHITE, drop_points,
                        gear_points, save)

GRAPHITE = (28, 30, 38, 255)
LIGHT = (240, 244, 252, 255)

CX = CY = S / 2
HEX_R = 800          # шестигранник
ICON = 330           # центры угловых иконок (координата)
ICON_2 = S - ICON


def hexagon(cx, cy, r):
    return [(cx + r * math.cos(math.radians(90 + 60 * i)),
             cy + r * math.sin(math.radians(90 + 60 * i))) for i in range(6)]


# ---------- угловые иконки (один цвет + «дырки» цветом фона) ----------
def icon_gear(d, cx, cy, color, hole):
    d.polygon(gear_points(cx, cy, 105, 150, teeth=8, tooth_width=0.45), fill=color)
    d.ellipse([cx - 46, cy - 46, cx + 46, cy + 46], fill=hole)


def icon_tag(img, cx, cy, color, hole):
    layer = Image.new("RGBA", (400, 300), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    ld.rounded_rectangle([25, 25, 375, 275], radius=55, fill=color)
    ld.ellipse([70, 70, 150, 150], fill=hole)                 # дырочка бирки
    x = 190
    for w in (22, 40, 22, 60, 22, 34):                        # «штрихкод»
        ld.rectangle([x, 80, x + w, 220], fill=hole)
        x += w + 18
    layer = layer.rotate(-20, expand=True, resample=Image.BICUBIC)
    img.alpha_composite(layer, (int(cx - layer.width / 2), int(cy - layer.height / 2)))


def icon_lens(d, cx, cy, color):
    r = 118
    d.line([(cx + r * 0.72, cy + r * 0.72), (cx + r * 0.72 + 120, cy + r * 0.72 + 120)],
           fill=color, width=44)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=30)


def icon_drop(d, cx, cy, color):
    d.polygon(drop_points(cx, cy + 30, 100, apex=1.7), fill=color)


def draw_variant(name, bg, hex_fill, hex_outline, rva_color, sub_color, icon_color, icon_hole):
    img = Image.new("RGBA", (S, S), bg)
    d = ImageDraw.Draw(img)

    # шестигранник
    pts = hexagon(CX, CY, HEX_R)
    if hex_fill:
        d.polygon(pts, fill=hex_fill)
    if hex_outline:
        d.polygon(pts, outline=hex_outline, width=26)

    # RVA + 161 (блок по центру)
    f1 = ImageFont.truetype(FONT_BLACK, 400)
    f2 = ImageFont.truetype(FONT_BLACK, 200)
    b1 = d.textbbox((0, 0), "RVA", font=f1)
    b2 = d.textbbox((0, 0), "161", font=f2)
    gap = 40
    total = (b1[3] - b1[1]) + gap + (b2[3] - b2[1])
    y = CY - total / 2
    d.text((CX - (b1[2] - b1[0]) / 2 - b1[0], y - b1[1]), "RVA", font=f1, fill=rva_color)
    d.text((CX - (b2[2] - b2[0]) / 2 - b2[0], y + (b1[3] - b1[1]) + gap - b2[1]),
           "161", font=f2, fill=sub_color)

    # углы: шестерёнка, бирка, лупа, капля
    icon_gear(d, ICON, ICON, icon_color, icon_hole)
    icon_tag(img, ICON_2, ICON, icon_color, icon_hole)
    icon_lens(d, ICON, ICON_2, icon_color)
    icon_drop(d, ICON_2, ICON_2, icon_color)

    save(img, name)


def preview():
    from PIL import ImageFont
    names = [("logo4_rva_orange.png", "Оранжевый (фирменный)"),
             ("logo4_rva_navy.png", "Тёмно-синий"),
             ("logo4_rva_light.png", "Светлый"),
             ("logo4_rva_graphite.png", "Графит")]
    out = 500
    gap = 40
    sheet = Image.new("RGB", (out * 2 + gap * 3, out * 2 + gap * 3 + 120), (245, 246, 250))
    d = ImageDraw.Draw(sheet)
    f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 32)
    for i, (fname, label) in enumerate(names):
        x = gap + (i % 2) * (out + gap)
        y = gap + (i // 2) * (out + gap + 60)
        sheet.paste(Image.open(DIR / fname), (x, y))
        d.text((x, y + out + 14), f"{i + 1}. {label}", font=f, fill=(60, 70, 90))
    sheet.save(DIR / "preview4.png", "PNG")
    print(f"{DIR/'preview4.png'}")


if __name__ == "__main__":
    # 1) оранжевый: фирменный
    draw_variant("logo4_rva_orange.png", ORANGE, WHITE, None, NAVY, ORANGE, WHITE, ORANGE)
    # 2) тёмно-синий
    draw_variant("logo4_rva_navy.png", NAVY, WHITE, None, ORANGE, NAVY, WHITE, NAVY)
    # 3) светлый: белый фон, контурный шестигранник
    draw_variant("logo4_rva_light.png", WHITE, LIGHT, NAVY, NAVY, ORANGE, NAVY, WHITE)
    # 4) графит
    draw_variant("logo4_rva_graphite.png", GRAPHITE, WHITE, None, ORANGE, GRAPHITE, WHITE, GRAPHITE)
    preview()
    # выложить в корень рабочей папки
    for f in ("logo4_rva_orange.png", "logo4_rva_navy.png", "logo4_rva_light.png",
              "logo4_rva_graphite.png", "preview4.png"):
        shutil.copy(DIR / f, DIR.parent / f)
    print("Скопировано в рабочую папку.")
