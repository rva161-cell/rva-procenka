#!/usr/bin/env python3
"""Снимок главной страницы для просмотра на любом устройстве.

Собирает автономный HTML: site/variant-1.html + текущая лента + логотип и
QR-коды, встроенные прямо в файл (base64). Такой файл открывается где угодно —
сервер не нужен, но вход/регистрация на нём не работают (это просмотр).

Запуск: ../bot/venv/bin/python make_snapshot.py
Результат: /Users/rva/Documents/RVA_сайт/Главная_страница_RVA.html
"""
import base64
import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WS = ROOT.parent                       # рабочая папка RVA_сайт
PUB = ROOT / "public"
OUT = WS / "Главная_страница_RVA.html"


def data_uri(web_path: str) -> str:
    """Файл из public/ → data-URI (встроить в HTML)."""
    f = PUB / web_path.lstrip("/")
    mime = "image/png" if f.suffix.lower() == ".png" else "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(f.read_bytes()).decode()


def feed_html(items: list) -> str:
    out = []
    for n in items:
        parts = ['<div class="feed-item">']
        if n.get("date"):
            parts.append(f'<span>🗓 {html.escape(n["date"])}</span>')
        if n.get("image"):
            try:
                parts.append(f'<img class="feed-img" src="{data_uri(n["image"])}" alt="">')
            except FileNotFoundError:
                pass
        if n.get("title"):
            parts.append(f'<b>{html.escape(n["title"])}</b>')
        if n.get("text"):
            parts.append(f'<span>{html.escape(n["text"])}</span>')
        parts.append("</div>")
        out.append("".join(parts))
    return "".join(out) or '<span class="feed-empty">Новостей пока нет</span>'


def main():
    page = (WS / "site" / "variant-1.html").read_text(encoding="utf-8")
    news = json.loads((ROOT / "news.json").read_text(encoding="utf-8"))

    # лента — сразу с данными (без обращения к серверу)
    page = page.replace(
        '<div class="feed-scroll" id="feedList"><span class="feed-empty">Новостей пока нет</span></div>',
        f'<div class="feed-scroll" id="feedList">{feed_html(news)}</div>')

    # картинки сайта — встроить в файл
    for src in ("/logo.png", "/qr_max.png", "/qr_tg.png"):
        try:
            page = page.replace(f'src="{src}"', f'src="{data_uri(src)}"')
        except FileNotFoundError:
            pass

    # снимок не должен обращаться к серверу: убираем загрузку ленты и вход
    page = page.replace("loadFeed();", "/* лента вшита в снимок */")
    page = page.replace("loadMe();", "/* снимок: без входа */")

    OUT.write_text(page, encoding="utf-8")
    print(f"снимок: {OUT} ({OUT.stat().st_size // 1024} КБ)")


if __name__ == "__main__":
    main()
