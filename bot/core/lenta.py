"""Лента «Мысль дня» — общее ядро для почтового конвейера и ботов.

news.json — записи ленты; public/lenta/ — картинки; lenta_state.json — состояние
(обработанные письма, хеш последней карточки). Новые записи добавляются ВВЕРХ.
"""
import base64
import hashlib
import json
import re
from datetime import datetime
from pathlib import Path

import httpx

BOT_DIR = Path(__file__).resolve().parent.parent    # папка бота
ROOT = BOT_DIR.parent / "procenka"                  # папка сервера проценки (данные ленты здесь)
PUB = ROOT / "public" / "lenta"
NEWS_FILE = ROOT / "news.json"
STATE_FILE = ROOT / "lenta_state.json"
PROMPT_FILE = ROOT.parent / "Lenta" / "промт.txt"
MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля",
          "августа", "сентября", "октября", "ноября", "декабря"]


def ru_today() -> str:
    n = datetime.now()
    return f"{n.day} {MONTHS[n.month - 1]}"


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(st: dict) -> None:
    STATE_FILE.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")


def news_add(entry: dict) -> None:
    """Новая запись — ВВЕРХ ленты (свежее сверху)."""
    items = json.loads(NEWS_FILE.read_text(encoding="utf-8")) if NEWS_FILE.exists() else []
    items.insert(0, entry)
    NEWS_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")


def news_set_text(image: str, text: str) -> bool:
    items = json.loads(NEWS_FILE.read_text(encoding="utf-8")) if NEWS_FILE.exists() else []
    for it in items:
        if it.get("image") == image:
            it["text"] = text
            NEWS_FILE.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
            return True
    return False


def save_card(data: bytes):
    """Картинка карточки → public/lenta/<дата>.jpg. → (web-путь, файл, sha1)."""
    sha = hashlib.sha1(data).hexdigest()
    day = datetime.now().strftime("%Y-%m-%d")
    fname, n = f"{day}.jpg", 2
    while (PUB / fname).exists():
        fname = f"{day}-{n}.jpg"
        n += 1
    PUB.mkdir(parents=True, exist_ok=True)
    (PUB / fname).write_bytes(data)
    return f"/lenta/{fname}", PUB / fname, sha


def last_card_hash() -> str:
    return load_state().get("last_card_hash") or ""


def set_last_card_hash(sha: str) -> None:
    st = load_state()
    st["last_card_hash"] = sha
    save_state(st)


def story_draft(image_path, key: str, model: str, base: str = "https://vision-ai.example/api/paas/v4"):
    """Черновик истории возникновения мысли по картинке (GLM-4.6V). None — не удалось."""
    if not key:
        return None
    b64 = base64.b64encode(Path(image_path).read_bytes()).decode()
    body = {
        "model": model,
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
            {"type": "text", "text":
                "На карточке «Мысль дня» есть фраза-мысль. Прочитай её и напиши историю "
                "возникновения этой мысли: почему она появилась, о чём напоминает. "
                "120–200 слов, живым русским языком, без заголовков, приветствий и подписи. "
                "Ответь только текстом истории."}
        ]}],
        "temperature": 0.7,
    }
    try:
        r = httpx.post(base.rstrip("/") + "/chat/completions", json=body,
                       headers={"Authorization": "Bearer " + key}, timeout=120.0)
        r.raise_for_status()
        return ((r.json()["choices"][0]["message"]["content"]) or "").strip() or None
    except Exception:
        return None


# ---------- обработка карточки в ИИ-редакторе (ProxyAPI → OpenAI images/edits) ----------
PROMPT_FILE = ROOT.parent / "Lenta" / "промт.txt"


def card_prompt() -> str:
    """Промт обработки — из Lenta/промт.txt (директор правит файл сам)."""
    try:
        return PROMPT_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return ("Отредактируй изображение: приветствие замени на «Всем добра!», "
                "удали строку «Задачи» с галочкой и цифрой; дату, аватар «РВ» и «Мысль дня» не меняй.")


def _openai_cfg() -> dict:
    cfg = {}
    try:
        for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$", line)
            if m and m.group(1).startswith("OPENAI"):
                cfg[m.group(1)] = m.group(2).strip()
    except Exception:
        pass
    return cfg


def edit_card(data: bytes, prompt: str):
    """Обработка карточки в ИИ-редакторе (ProxyAPI → OpenAI images/edits).
    → (байты результата | None, текст ошибки | None)."""
    env = _openai_cfg()
    key = env.get("OPENAI_API_KEY") or ""
    base = (env.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    model = env.get("OPENAI_IMAGE_MODEL") or "gpt-image-1"
    if not key:
        return None, "не задан OPENAI_API_KEY в procenka/.env"
    try:
        r = httpx.post(base + "/images/edits",
                       headers={"Authorization": "Bearer " + key},
                       files={"image": ("card.jpg", data, "image/jpeg")},
                       data={"prompt": prompt, "model": model, "size": "1024x1536", "n": "1"},
                       timeout=300.0)
        if r.status_code != 200:
            return None, f"редактор ответил {r.status_code}: {r.text[:100]}"
        b64 = ((r.json() or {}).get("data") or [{}])[0].get("b64_json")
        if not b64:
            return None, "пустой ответ редактора"
        return base64.b64decode(b64), None
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def set_review(r: dict) -> None:
    st = load_state(); st["review"] = r; save_state(st)


# ---------- лента в ботах: 10 последних дней + уборка прежних сообщений ленты ----------
def within_days(date_str: str, days: int, now: datetime | None = None) -> bool:
    """«19 октября» → попадает ли дата в последние `days` дней (год берём текущий,
    декабрь при январской проверке считаем прошлым годом)."""
    now = now or datetime.now()
    m = re.match(r"^(\d{1,2})\s+([а-яё]+)", str(date_str or "").strip().lower())
    if not m:
        return True  # неопознанная дата — не режем
    day, month = int(m.group(1)), m.group(2)
    try:
        month_num = MONTHS.index(month) + 1
    except ValueError:
        return True
    year = now.year - (1 if month_num > now.month else 0)
    try:
        d = datetime(year, month_num, day)
    except ValueError:
        return True
    return (now - d).days <= days


def get_feed_msgs(key: str) -> list:
    """id сообщений ленты, которые бот уже отправлял в этот чат (для удаления)."""
    return (load_state().get("feed_msgs") or {}).get(key) or []


def set_feed_msgs(key: str, mids: list) -> None:
    st = load_state()
    fm = st.get("feed_msgs") or {}
    if mids:
        fm[key] = mids
    else:
        fm.pop(key, None)
    st["feed_msgs"] = fm
    save_state(st)


def get_review() -> dict:
    return load_state().get("review") or {}


def clear_review() -> None:
    st = load_state(); st.pop("review", None); save_state(st)
