"""Уровни доступа пользователей — единые для всех транспортов бота (MAX, Telegram).

  1 — гость: бот публичный; топ-10 предложений, цена × guest_markup, без поставщиков;
      поиск по фото недоступен.
  2 — зарегистрирован на сайте (появится вместе с сайтом на VPS, этап 4).
  3 — «свой поставщик»: одобренная заявка на странице проценки; свои поставщики и цены
      в проценке + поиск по фото.
  4 — «близкий»: список procenka/close_people.json (телефон / max_id / telegram_id);
      все функции, включая будущие.

База пользователей одна — procenka/data.db (SQLite) на сервере проценки. Бот спрашивает
уровень по HTTP (POST /api/bot/user) и кэширует ответ на 5 минут. Если сервер
недоступен, пользователь считается гостем: безопаснее показать меньше, чем
раскрыть закупочные цены. Правила гостя применяются в боте перед показом строк —
какой бы источник ни был (проценка или фолбэк Поставщик), наружу уходит только
наценённая и обрезанная выдача.
"""
import re
import time

import httpx

LEVEL_GUEST = 1
LEVEL_REG = 2
LEVEL_SUPPLIER = 3
LEVEL_CLOSE = 4

LEVEL_NAMES = {
    LEVEL_GUEST: "1 — гость",
    LEVEL_REG: "2 — зарегистрирован",
    LEVEL_SUPPLIER: "3 — свои поставщики",
    LEVEL_CLOSE: "4 — близкий",
}

DEFAULT_MARKUP = 1.2   # наценка для гостя (config.json → levels.guest_markup)
DEFAULT_ROWS = 10      # сколько строк видит гость (config.json → levels.guest_rows)

_cache: dict[str, tuple[float, dict]] = {}  # "transport:tid" -> (ts, {level, login, found, offline})
CACHE_TTL = 300


def norm_phone(s) -> str:
    """+7 905 123-45-67 / 89051234567 / 9051234567 → 79051234567 (пусто, если не похоже)."""
    d = re.sub(r"\D", "", str(s or ""))
    if len(d) == 11 and d[0] == "8":
        d = "7" + d[1:]
    if len(d) == 10:
        d = "7" + d
    return d if len(d) == 11 and d[0] == "7" else ""


def guest_params(cfg: dict) -> tuple[float, int]:
    lv = cfg.get("levels") or {}
    try:
        markup = float(lv.get("guest_markup") or DEFAULT_MARKUP)
    except (TypeError, ValueError):
        markup = DEFAULT_MARKUP
    try:
        rows = max(1, int(lv.get("guest_rows") or DEFAULT_ROWS))
    except (TypeError, ValueError):
        rows = DEFAULT_ROWS
    return markup, rows


def api_headers(cfg: dict) -> dict:
    """Заголовки запросов к серверу проценки: бот-ключ открывает бот-API и сырую выдачу."""
    key = (cfg.get("procenka") or {}).get("botKey") or ""
    return {"Content-Type": "application/json", **({"X-Bot-Key": key} if key else {})}


def _base(cfg: dict) -> str:
    return (cfg.get("procenka") or {}).get("url") or "http://127.0.0.1:8766"


async def resolve_user(transport: str, tid, cfg: dict) -> dict:
    """Уровень пользователя по его id в мессенджере → {level, login, found, offline}."""
    key = f"{transport}:{tid}"
    cached = _cache.get(key)
    if cached and time.time() - cached[0] < CACHE_TTL:
        return cached[1]
    info = {"level": LEVEL_GUEST, "login": "", "found": False, "offline": False,
            "discount": 0, "role": "", "org": False}
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(f"{_base(cfg)}/api/bot/user", headers=api_headers(cfg),
                                  json={"transport": transport, "tid": str(tid)}, timeout=8.0)
            r.raise_for_status()
            d = r.json() or {}
            info = {"level": int(d.get("level") or LEVEL_GUEST), "login": d.get("login") or "",
                    "found": bool(d.get("found")), "offline": False,
                    "discount": int(d.get("discount") or 0), "role": d.get("role") or "",
                    "org": bool(d.get("org")),
                    # наценка гостя задаётся админом на странице проценки — та же, что на сайте
                    "guest_markup": float(d["guest_markup"]) if d.get("guest_markup") else None}
    except Exception:
        info["offline"] = True
    _cache[key] = (time.time(), info)
    return info


async def link_by_phone(transport: str, tid, phone: str, cfg: dict) -> dict:
    """Привязка мессенджера к учётке по номеру телефона (кнопка «поделиться контактом»).

    Номер должен прийти от самого мессенджера и принадлежать отправителю — транспорт
    проверяет это до вызова (Telegram: contact.user_id, MAX: подпись hash). Номер,
    набранный текстом, сюда передавать нельзя: так можно привязаться к чужому аккаунту.

    → {found, level, login, offline}; found=False — аккаунта с таким телефоном нет.
    """
    norm = norm_phone(phone)
    if not norm:
        return {"found": False, "level": LEVEL_GUEST, "login": "", "offline": False,
                "bad_phone": True}
    info = {"found": False, "level": LEVEL_GUEST, "login": "", "offline": False}
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(f"{_base(cfg)}/api/bot/link", headers=api_headers(cfg),
                                  json={"transport": transport, "tid": str(tid), "phone": norm},
                                  timeout=8.0)
            r.raise_for_status()
            d = r.json() or {}
            info = {"found": bool(d.get("found")), "level": int(d.get("level") or LEVEL_GUEST),
                    "login": d.get("login") or "", "offline": False}
    except Exception:
        info["offline"] = True
    _cache.pop(f"{transport}:{tid}", None)
    return info


def forget_user(transport: str, tid):
    _cache.pop(f"{transport}:{tid}", None)


async def approval_submit(cfg: dict, transport: str, tid, info: dict, ap: dict) -> dict:
    """Заявка на согласование (2 уровень): результат оценки уходит директору —
    на сервере создаётся задача в органайзер и админу уходит сообщение в мессенджер."""
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{_base(cfg)}/api/bot/approval", headers=api_headers(cfg),
                              json={"transport": transport, "tid": str(tid),
                                    "login": info.get("login") or "",
                                    "code": ap.get("code", ""), "brand": ap.get("brand", ""),
                                    "text": ap.get("text", "")},
                              timeout=15.0)
        r.raise_for_status()
        return r.json() or {}


async def photo_used(cfg: dict, transport: str, tid, info: dict) -> dict:
    """Списать одно фото с квоты пользователя (3 уровень, колонка «Фото» в кабинете)."""
    async with httpx.AsyncClient() as client:
        r = await client.post(f"{_base(cfg)}/api/bot/photo-used", headers=api_headers(cfg),
                              json={"transport": transport, "tid": str(tid),
                                    "login": info.get("login") or ""},
                              timeout=8.0)
        r.raise_for_status()
        return r.json() or {}


def apply_guest_rules(rows: list[dict], level: int, cfg: dict, discount: int = 0,
                      markup: float | None = None) -> tuple[list[dict], int]:
    """Правила показа предложений для уровня. → (строки для показа, всего доступно).

    Уровень 1–2: первые guest_rows строк, цена × guest_markup, поставщик скрыт
    (склад, срок и количество остаются). Уровень 3+: выдача без изменений.
    Поверх всего — скидка за приглашения (discount в %, максимум 10).
    """
    factor = 1.0 - (max(0, min(10, int(discount or 0))) / 100.0)
    if level >= LEVEL_SUPPLIER:
        if factor == 1.0:
            return rows, len(rows)
        out = [dict(r, price=round((r.get("price") or 0) * factor, 2)) for r in rows]
        return out, len(out)
    cfg_markup, limit = guest_params(cfg)
    markup = markup or cfg_markup  # с сервера (поле «Наценка» на странице проценки), иначе config.json
    out = []
    for r in rows[:limit]:
        p = (r.get("price") or 0) * markup * factor
        out.append({k: v for k, v in r.items() if k != "supplier"} |
                   {"price": round(p, 2)})
    return out, len(rows)
