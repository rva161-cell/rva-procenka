#!/usr/bin/env python3
"""Генерация вариантов логотипа бота (500×500 PNG) для MAX/Telegram.

Рисуем в 4× (2000×2000) и уменьшаем до 500 — так линии гладкие.
Запуск: venv/bin/python make_logos.py  →  файлы в logos/
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

S = 2000          # рабочий размер (4×)
OUT = 500         # итог
DIR = Path(__file__).resolve().parent / "logos"
DIR.mkdir(exist_ok=True)

NAVY = (15, 35, 80, 255)        # тёмно-синий
NAVY2 = (27, 58, 122, 255)      # синий
ORANGE = (243, 146, 0, 255)     # фирменный оранжевый
WHITE = (255, 255, 255, 255)
LIGHT = (230, 235, 245, 255)
DARKTXT = (10, 20, 45, 255)

FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_BLACK = "/System/Library/Fonts/Supplemental/Arial Black.ttf"


def canvas(bg=NAVY):
    img = Image.new("RGBA", (S, S), bg)
    return img, ImageDraw.Draw(img)


def gradient_bg(img, c1, c2):
    d = ImageDraw.Draw(img)
    for y in range(S):
        t = y / S
        d.line([(0, y), (S, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(c1, c2)))


def gear_points(cx, cy, r_root, r_tip, teeth=8, tooth_width=0.42):
    pts, step = [], 2 * math.pi / teeth
    gap = (1 - tooth_width) * step
    for i in range(teeth):
        a = i * step
        pts.append((cx + r_root * math.cos(a), cy + r_root * math.sin(a)))
        pts.append((cx + r_tip * math.cos(a + gap / 2), cy + r_tip * math.sin(a + gap / 2)))
        pts.append((cx + r_tip * math.cos(a + step - gap / 2), cy + r_tip * math.sin(a + step - gap / 2)))
        pts.append((cx + r_root * math.cos(a + step), cy + r_root * math.sin(a + step)))
    return pts


def drop_points(cx, cy, r, apex=1.9):
    """Капля: круглое «брюшко» внизу, остриё вверх (координаты PIL: y растёт вниз)."""
    pts = []
    for a in range(160, 19, -6):  # дуга 160°→20° через 90° (низ)
        rad = math.radians(a)
        pts.append((cx + r * math.cos(rad), cy + r * math.sin(rad)))
    left, right = pts[0], pts[-1]
    tip = (cx, cy - r * apex)
    bulge = r * 0.10
    for t in (0.25, 0.5, 0.75):  # правая сторона вверх, выпуклость наружу
        x = right[0] + (tip[0] - right[0]) * t + math.sin(t * math.pi) * bulge
        y = right[1] + (tip[1] - right[1]) * t
        pts.append((x, y))
    pts.append(tip)
    for t in (0.75, 0.5, 0.25):  # левая сторона вниз
        x = left[0] + (tip[0] - left[0]) * t - math.sin(t * math.pi) * bulge
        y = left[1] + (tip[1] - left[1]) * t
        pts.append((x, y))
    return pts


def save(img, name):
    img = img.convert("RGB").resize((OUT, OUT), Image.LANCZOS)
    img.save(DIR / name, "PNG")
    print(f"{DIR/name}  {img.size}")


# ---------------- вариант 1: шестерёнка + капля масла ----------------
def logo1():
    img, d = canvas(NAVY)
    cx, cy = S / 2, S / 2
    d.polygon(gear_points(cx, cy, 640, 790, teeth=8), fill=WHITE)
    d.ellipse([cx - 640, cy - 640, cx + 640, cy + 640], fill=WHITE)
    d.ellipse([cx - 390, cy - 390, cx + 390, cy + 390], fill=NAVY)   # дырка
    # крупная капля по центру + блик
    d.polygon(drop_points(cx, cy + 70, 240, apex=1.8), fill=ORANGE)
    d.ellipse([cx - 150, cy + 90, cx + 10, cy + 270], fill=(255, 200, 110, 255))
    save(img, "logo1_gear_drop.png")


# ---------------- вариант 2: скан-рамка + бирка с артикулом ----------------
def logo2():
    img, d = canvas(NAVY)
    gradient_bg(img, NAVY2, NAVY)
    m, L, w = 250, 300, 54
    for x, y, dx, dy in [(m, m, 1, 1), (S - m, m, -1, 1), (m, S - m, 1, -1), (S - m, S - m, -1, -1)]:
        d.line([(x, y), (x + dx * L, y)], fill=ORANGE, width=w)
        d.line([(x, y), (x, y + dy * L)], fill=ORANGE, width=w)

    tag = Image.new("RGBA", (1120, 780), (0, 0, 0, 0))
    td = ImageDraw.Draw(tag)
    td.rounded_rectangle([20, 20, 1100, 760], radius=90, fill=WHITE)
    td.ellipse([80, 80, 210, 210], fill=NAVY)          # дырочка бирки
    # штрихкод: по центру бирки, с полями сверху/снизу
    bars = (18, 34, 18, 52, 18, 26, 44, 18, 30, 18, 56, 18, 26, 40, 18)
    total = sum(bars) + 22 * (len(bars) - 1)
    x = 300 + (780 - total) // 2
    for wd in bars:
        td.rectangle([x, 170, x + wd, 560], fill=DARKTXT)
        x += wd + 22
    td.rounded_rectangle([300, 610, 1060, 670], radius=30, fill=LIGHT)  # строка «артикул»
    tag = tag.rotate(8, expand=True, resample=Image.BICUBIC)
    img.alpha_composite(tag, (int(S/2 - tag.width/2), int(S/2 - tag.height/2)))
    save(img, "logo2_scan_tag.png")


# ---------------- вариант 3: капля под лупой (поиск) ----------------
def logo3():
    img, d = canvas(WHITE)
    lx, ly, r = S * 0.46, S * 0.44, 420                 # лупа левее-выше центра
    hx, hy = lx + r * 0.75, ly + r * 0.75               # ручка вправо-вниз
    d.line([(hx, hy), (hx + 330, hy + 330)], fill=NAVY, width=120)
    d.ellipse([lx - r, ly - r, lx + r, ly + r], fill=(234, 240, 252, 255), outline=NAVY, width=58)
    # капля внутри линзы
    d.polygon(drop_points(lx, ly + 90, 230, apex=1.9), fill=ORANGE)
    d.ellipse([lx - 140, ly + 130, lx + 5, ly + 300], fill=(255, 200, 110, 255))
    save(img, "logo3_drop_lens.png")


# ---------------- вариант 4: монограмма РВА в шестиграннике ----------------
def logo4():
    img, d = canvas(ORANGE)
    cx, cy = S / 2, S / 2
    R = 780
    hexpts = [(cx + R * math.cos(math.radians(90 + 60 * i)),
               cy + R * math.sin(math.radians(90 + 60 * i))) for i in range(6)]
    d.polygon(hexpts, fill=WHITE)
    f = ImageFont.truetype(FONT_BLACK, 400)
    tb = d.textbbox((0, 0), "РВА", font=f)
    d.text((cx - (tb[2] - tb[0]) / 2, cy - (tb[3] - tb[1]) / 2 - tb[1] + 60), "РВА", font=f, fill=NAVY)
    # капля-акцент над монограммой, крупнее
    d.polygon(drop_points(cx, cy - 330, 130, apex=1.7), fill=ORANGE)
    d.ellipse([cx - 80, cy - 210, cx + 5, cy - 95], fill=(255, 200, 110, 255))
    save(img, "logo4_monogram.png")


# ---------------- превью-лист 2×2 ----------------
def preview():
    names = ["logo1_gear_drop.png", "logo2_scan_tag.png", "logo3_drop_lens.png", "logo4_monogram.png"]
    gap = 40
    sheet = Image.new("RGB", (OUT * 2 + gap * 3, OUT * 2 + gap * 3 + 60), (245, 246, 250))
    d = ImageDraw.Draw(sheet)
    f = ImageFont.truetype(FONT_BOLD, 34)
    labels = ["1. Шестерёнка + масло", "2. Скан артикула", "3. Поиск (капля+лупа)", "4. Монограмма РВА"]
    for i, name in enumerate(names):
        x = gap + (i % 2) * (OUT + gap)
        y = gap + (i // 2) * (OUT + gap + 60)
        im = Image.open(DIR / name)
        sheet.paste(im, (x, y))
        d.text((x, y + OUT + 12), f"{labels[i]}  —  {name}", font=f, fill=(60, 70, 90))
    sheet.save(DIR / "preview.png", "PNG")
    print(f"{DIR/'preview.png'}  {sheet.size}")


if __name__ == "__main__":
    logo1(); logo2(); logo3(); logo4(); preview()
    print("Готово.")
