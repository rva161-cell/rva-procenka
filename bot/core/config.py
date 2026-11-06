"""Конфигурация: config.json + .env + переменные окружения.

Приоритет: переменные окружения > .env > config.json.
Ключи .env: TELEGRAM_TOKEN, MAX_TOKEN, VISION_API_KEY, VISION_MODEL,
PROCENKA_URL (внутренний адрес программы проценки), SITE_URL (главная сайта),
PROCENKA_PUBLIC_URL (публичная ссылка на проценку для кнопки в боте).
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _parse_env_file(path: Path) -> dict:
    out = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            out[key.strip()] = val.strip().strip("\"'")
    except FileNotFoundError:
        pass
    return out


def load_config() -> dict:
    cfg_file = ROOT / "config.json"
    if not cfg_file.exists():
        raise SystemExit("Нет config.json — скопируйте из config.example.json")
    cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
    for section in ("telegram", "max", "vision", "procenka"):
        cfg.setdefault(section, {})

    raw = _parse_env_file(ROOT / ".env")

    def get(key: str):
        return os.environ.get(key) or raw.get(key) or ""

    def apply(key: str, section: str, field: str):
        v = get(key)
        if v:
            cfg[section][field] = v

    apply("TELEGRAM_TOKEN", "telegram", "token")
    apply("MAX_TOKEN", "max", "token")
    apply("VISION_API_KEY", "vision", "apiKey")
    apply("VISION_MODEL", "vision", "model")
    apply("PROCENKA_URL", "procenka", "url")
    apply("BOT_API_KEY", "procenka", "botKey")
    cfg.setdefault("lmstudio", {})   # локальная модель на своём ПК (LM Studio, OpenAI-совместимый сервер)
    cfg["lmstudio"]["url"] = get("LMSTUDIO_URL")
    cfg["lmstudio"]["key"] = get("LMSTUDIO_KEY")
    cfg["lmstudio"]["model"] = get("LMSTUDIO_MODEL")
    cfg["lmstudio"]["modelFast"] = get("LMSTUDIO_MODEL_FAST")   # маленькая модель для чётких фото
    if get("TELEGRAM_PROXY_URL"):
        cfg["telegram"]["proxy"] = get("TELEGRAM_PROXY_URL")

    cfg.setdefault("site", {})
    cfg["site"]["url"] = get("SITE_URL") or cfg["site"].get("url", "")
    cfg["site"]["procenka_public_url"] = get("PROCENKA_PUBLIC_URL") or cfg["site"].get("procenka_public_url", "")

    cfg.setdefault("levels", {})  # правила показа для гостей (см. core/levels.py)
    cfg["levels"].setdefault("guest_markup", 1.2)  # наценка гостя
    cfg["levels"].setdefault("guest_rows", 10)     # сколько строк видит гость
    return cfg
