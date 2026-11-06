#!/usr/bin/env python3
"""QR-коды ботов для главной страницы (public/qr_max.png, public/qr_tg.png).

Запуск (нужен venv бота с пакетом qrcode):
  ../bot/venv/bin/python make_qr.py

Ссылки берутся из переменных окружения или .env рядом со скриптом:
  MAX_BOT_URL  — по умолчанию https://max.ru/id616101960804_bot (наш бот MAX)
  TG_BOT_URL   — пока пусто (нет публичного имени Telegram-бота); впишете — запустите снова
"""
import os
import sys
from pathlib import Path

import qrcode

ROOT = Path(__file__).resolve().parent


def read_env() -> dict:
    out = {}
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip().strip("\"'")
    out.update(os.environ)  # переменные окружения главнее
    return out


def make(url: str, out: Path, label: str):
    img = qrcode.make(url, box_size=10, border=2)
    img.save(out)
    print(f"{label}: {url} → {out.name}")


def main():
    env = read_env()
    max_url = env.get("MAX_BOT_URL") or "https://max.ru/id616101960804_bot"
    tg_url = (env.get("TG_BOT_URL") or "").strip()

    make(max_url, ROOT / "public" / "qr_max.png", "MAX")
    if tg_url:
        make(tg_url, ROOT / "public" / "qr_tg.png", "Telegram")
    elif (ROOT / "public" / "qr_tg.png").exists():
        (ROOT / "public" / "qr_tg.png").unlink()
        print("Telegram: qr_tg.png удалён (TG_BOT_URL пуст)")
    else:
        print("Telegram: пропущено (TG_BOT_URL не задан — вписать в .env и запустить снова)")
    sys.exit(0)


if __name__ == "__main__":
    main()
