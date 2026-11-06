"""Распознавание голосовых сообщений (STT) — локальный whisper.

ProxyAPI/OpenAI больше не используются (решение 21.10): POST /stt на локальный
сервис procenka/stt_server.py (faster-whisper, модель держит в памяти).
STT_URL из procenka/.env, по умолчанию http://127.0.0.1:8767.
"""
import re
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2] / "procenka"   # procenka/.env


def _stt_url() -> str:
    try:
        for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*STT_URL\s*=\s*(.*)\s*$", line)
            if m:
                return m.group(1).strip().strip("\"'")
    except Exception:
        pass
    return "http://127.0.0.1:8767"


def transcribe(data: bytes, filename: str = "voice.ogg"):
    """→ (текст | None, текст ошибки | None)."""
    try:
        r = httpx.post(_stt_url() + "/stt", content=data,
                       headers={"Content-Type": "audio/ogg" if filename.endswith("ogg") else "audio/webm"},
                       timeout=120.0)
        if r.status_code != 200:
            return None, f"STT ответил {r.status_code}: {(r.json() or {}).get('error', '')[:80]}"
        return ((r.json() or {}).get("text") or "").strip() or None, None
    except Exception as e:
        return None, (f"{type(e).__name__}: {e}" if "ECONNREFUSED" not in str(e) else
                      "локальный STT не запущен: cd procenka && ../bot/venv/bin/python stt_server.py")
