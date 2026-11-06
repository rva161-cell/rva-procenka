#!/usr/bin/env python3
"""Артикул-бот для MAX (мессенджер MAX, platform-api2.max.ru) — без VPN, основной бот.

Это только транспорт: приём обновлений (long polling), скачивание фото и голосовых,
проверка подписи контакта, кнопки в формате MAX. Вся логика диалога — в core/dialog.py
(общая с Telegram-ботом bot.py).

Запуск: venv/bin/python max_bot.py   (токен — .env → MAX_TOKEN, см. business.max.ru)
Документация Bot API: https://dev.max.ru
"""
import asyncio
import base64
import hashlib
import hmac
import re
import time

import httpx

from core import levels
from core.config import load_config
from core.dialog import Button, Dialog, Keyboard, log

cfg = load_config()

MAX_TEXT = 4000
DIRECTOR_IDS = {"28098592"}  # MAX user_id директора: «Мысль дня» и кнопка «Разместить» в ленте


def contact_is_own(payload: dict, token: str) -> bool:
    """Контакт прислан кнопкой request_contact и это номер самого отправителя.

    MAX подписывает такой контакт: hash = HMAC-SHA256(ключ — токен бота, сообщение — vcf_info).
    У пересланных и выбранных из записной книжки контактов hash нет — их не принимаем.
    """
    vcf, got = payload.get("vcf_info") or "", str(payload.get("hash") or "").strip()
    if not vcf or not got or not token:
        return False
    # документация: «\r\n» в vcf_info заменить настоящими переводами строк — пробуем оба вида
    for msg in {vcf, vcf.replace("\\r\\n", "\r\n")}:
        digest = hmac.new(token.encode(), msg.encode(), hashlib.sha256).digest()
        if hmac.compare_digest(digest.hex(), got.lower()) or \
                hmac.compare_digest(base64.b64encode(digest).decode(), got):
            return True
    return False


def phone_from_vcf(vcf: str) -> str:
    m = re.search(r"TEL[^:\r\n]*:\s*([+0-9][0-9 \-\(\)]{8,})", str(vcf or ""))
    return levels.norm_phone(m.group(1)) if m else ""


def max_button(b: Button) -> dict:
    if b.contact:
        return {"type": "request_contact", "text": b.text[:128]}
    if b.url:
        return {"type": "link", "text": b.text[:128], "url": b.url}
    return {"type": "callback", "text": b.text[:128], "payload": b.action}


def _mid(j) -> str:
    """id отправленного сообщения из ответа API (для последующего удаления)."""
    try:
        return ((((j or {}).get("message") or {}).get("body") or {}).get("mid")) or ""
    except Exception:
        return ""


class MaxChat:
    """Ответы в один чат MAX (Chat для core/dialog.py)."""

    def __init__(self, bot: "MaxBot", chat_id, user_id):
        self.bot, self.chat_id, self.user_id = bot, chat_id, user_id

    async def send(self, text: str, buttons: Keyboard, html: bool = False):
        j = await self.bot.post_message(self.chat_id, self.user_id, text, buttons, fmt="html" if html else None)
        return _mid(j)

    async def send_image(self, data: bytes, caption: str, buttons: Keyboard):
        token = await self.bot.upload_image(data)
        j = await self.bot.post_message(self.chat_id, self.user_id, caption, buttons,
                                        images=[{"type": "image", "payload": {"token": token}}])
        return _mid(j)

    async def delete_message(self, mid: str):
        """Удалить своё сообщение (лента убирает прежние выдачи, см. core/lenta.py)."""
        if not mid or self.chat_id is None:
            return
        try:
            await self.bot.http.delete(f"/messages", params={"chat_id": self.chat_id, "message_id": mid})
        except Exception:
            pass

    async def edit(self, mid: str, text: str, buttons: Keyboard) -> bool:
        """Отредактировать своё сообщение на месте (PUT /messages) — новое меню
        появляется прямо под нажатой кнопкой, без прокрутки чата. Картинки и
        прочие вложения сохраняем как были (заново берём их из GET /messages).
        Любая неудача → False, диалог тогда отправит меню отдельным сообщением."""
        if not mid or self.chat_id is None or not buttons:
            return False
        try:
            g = await self.bot.http.get("/messages", params={"chat_id": self.chat_id, "message_ids": mid})
            body = (((g.json() or {}).get("messages") or [{}])[0] or {}).get("body") or {}
            keep = [a for a in (body.get("attachments") or [])
                    if isinstance(a, dict) and a.get("type") != "inline_keyboard"]
            att = keep + [{"type": "inline_keyboard",
                           "payload": {"buttons": [[max_button(b) for b in row] for row in buttons]}}]
            r = await self.bot.http.put("/messages", params={"chat_id": self.chat_id, "message_id": mid},
                                        json={"text": (text or "…")[:MAX_TEXT], "attachments": att})
            return r.status_code == 200
        except Exception:
            return False

    async def typing(self):
        if self.chat_id is None:
            return
        try:
            await self.bot.http.post(f"/chats/{self.chat_id}/actions", json={"action": "typing_on"})
        except Exception:
            pass


class MaxBot:
    def __init__(self, token: str, cfg: dict):
        self.token = token                    # ключ проверки подписи контакта (contact_is_own)
        self.http = httpx.AsyncClient(
            base_url="https://platform-api2.max.ru",
            headers={"Authorization": token},
            timeout=httpx.Timeout(95.0, connect=15.0),  # long polling ждёт до 90 с
        )
        self.seen: dict[str, float] = {}      # дедупликация после перезапуска (marker не committed)
        self.bot_username = ""                # для диплинков-приглашений
        self.dialog = Dialog("max", cfg, messenger="MAX", director_ids=DIRECTOR_IDS,
                             invite_link=lambda uid: f"https://max.ru/{self.bot_username}?start=i{uid}"
                             if self.bot_username else "")

    # ---------- Bot API ----------
    async def get_updates(self, marker, timeout: int = 30) -> dict:
        params = {"types": "message_created,message_callback,bot_started",
                  "timeout": timeout, "limit": 100}
        if marker is not None:
            params["marker"] = marker
        r = await self.http.get("/updates", params=params)
        r.raise_for_status()
        return r.json() or {}

    async def post_message(self, chat_id, user_id, text: str, buttons: Keyboard,
                           fmt: str | None = None, images: list[dict] | None = None):
        params = {"chat_id": chat_id} if chat_id is not None else {"user_id": user_id}
        body = {"text": (text or "…")[:MAX_TEXT], "notify": True}
        if fmt:
            body["format"] = fmt
        attachments = list(images or [])
        if buttons:
            attachments.append({"type": "inline_keyboard",
                                "payload": {"buttons": [[max_button(b) for b in row] for row in buttons]}})
        if attachments:
            body["attachments"] = attachments
        r = await self.http.post("/messages", params=params, json=body)
        r.raise_for_status()
        return r.json()

    async def upload_image(self, data: bytes) -> str:
        """Загрузка картинки в MAX → токен для вложения (формат ответа: photos.0.token)."""
        r = await self.http.post("/uploads", params={"type": "image"})
        r.raise_for_status()
        upload_url = (r.json() or {}).get("url")
        if not upload_url:
            raise RuntimeError("MAX не выдал адрес загрузки")
        r2 = await self.http.post(upload_url, files={"data": ("image.png", data, "image/png")})
        r2.raise_for_status()
        d = r2.json() or {}
        token = d.get("token") or (d.get("photos") or {}).get("0", {}).get("token")
        if not token:
            raise RuntimeError("MAX не вернул токен загруженной картинки")
        return token

    async def answer_callback(self, callback_id: str):
        try:  # пустой ответ просто снимает «часики» на кнопке
            await self.http.post("/answers", params={"callback_id": callback_id}, json={})
        except Exception:
            pass

    @staticmethod
    def loader(url: str | None):
        """Скачивание вложения по ссылке MAX — вызывается диалогом, только когда файл нужен."""
        async def load() -> bytes:
            if not url:
                raise RuntimeError("MAX не прислал ссылку на файл")
            async with httpx.AsyncClient(timeout=60) as c:
                r = await c.get(url)
                r.raise_for_status()
                return r.content
        return load

    def is_duplicate(self, key: str | None) -> bool:
        if not key:
            return False
        if key in self.seen:
            return True
        self.seen[key] = time.time()
        if len(self.seen) > 2000:  # подчищаем старые ключи дедупликации
            cutoff = time.time() - 3600
            self.seen = {k: v for k, v in self.seen.items() if v > cutoff}
        return False

    # ---------- обновления ----------
    async def handle_update(self, up: dict):
        t = up.get("update_type")
        if t == "message_created":
            await self.on_message(up.get("message") or {})
        elif t == "message_callback":
            cb = up.get("callback") or {}
            uid = (cb.get("user") or {}).get("user_id")
            if not uid or self.is_duplicate(f"cb:{cb.get('callback_id')}" if cb.get("callback_id") else None):
                return
            await self.answer_callback(cb.get("callback_id") or "")
            chat_id = ((up.get("message") or {}).get("recipient") or {}).get("chat_id")
            mid = ((up.get("message") or {}).get("body") or {}).get("mid")   # карточка с нажатой кнопкой
            await self.dialog.handle_action(MaxChat(self, chat_id, uid), uid, cb.get("payload") or "", mid=mid)
        elif t == "bot_started":
            # кнопка «Начать» (в т.ч. по диплинку-приглашению); payload = код приглашения
            uid = (up.get("user") or {}).get("user_id")
            if uid:
                await self.dialog.handle_start(MaxChat(self, up.get("chat_id"), uid), uid,
                                               payload=up.get("payload") or "")

    async def on_message(self, msg: dict):
        sender = msg.get("sender") or {}
        uid = sender.get("user_id")
        if not uid or sender.get("is_bot"):
            return
        body = msg.get("body") or {}
        if self.is_duplicate(body.get("mid")):
            return
        atts = body.get("attachments") or []
        log(f"сообщение от user_id={uid}: текст={bool(body.get('text'))}, "
            f"вложения={[a.get('type') for a in atts] or 'нет'}")
        chat = MaxChat(self, (msg.get("recipient") or {}).get("chat_id"), uid)
        text = (body.get("text") or "").strip()

        for att in atts:
            atype, payload = att.get("type"), att.get("payload") or {}
            if atype == "contact":
                own = contact_is_own(payload, self.token)
                if not own:
                    log(f"[привязка] контакт без подписи или чужой: uid={uid}, поля={sorted(payload)}")
                return await self.dialog.handle_contact(chat, uid, phone_from_vcf(payload.get("vcf_info")), own)
            if atype in ("voice", "audio"):
                return await self.dialog.handle_voice(chat, uid, self.loader(payload.get("url")),
                                                      payload.get("transcription"))
            if atype == "image":
                return await self.dialog.handle_photo(chat, uid, self.loader(payload.get("url")), text)
        if text:
            await self.dialog.handle_text(chat, uid, text)

    # ---------- цикл ----------
    async def run(self):
        me = await self.http.get("/me")
        me.raise_for_status()
        me_info = (me.json() or {})
        self.bot_username = me_info.get("username") or ""
        log(f"MAX: бот @{self.bot_username or me_info.get('name') or '?'} на связи "
            f"(user_id {me_info.get('user_id')}).")
        try:  # подсказки-команды в интерфейсе MAX (необязательно)
            await self.http.put("/me/commands", json={"commands": [
                {"name": "start", "description": "Меню и ваш уровень"},
                {"name": "help", "description": "Как пользоваться ботом"},
            ]})
        except Exception:
            pass

        marker = None
        cycle = 0
        while True:
            try:
                cycle += 1
                if cycle % 6 == 1:
                    log(f"…опрос MAX, цикл {cycle}")
                data = await self.get_updates(marker)
                for up in data.get("updates") or []:
                    try:
                        await self.handle_update(up)
                    except Exception as e:
                        log(f"Ошибка обработки обновления: {type(e).__name__}: {e}")
                marker = data.get("marker")
            except httpx.HTTPStatusError as e:
                log(f"MAX API: HTTP {e.response.status_code}: {e.response.text[:200]}")
                if e.response.status_code == 401:
                    log("Токен отклонён — проверьте MAX_TOKEN в .env.")
                    return
                await asyncio.sleep(3)
            except Exception as e:
                log(f"MAX API: {e}; повтор через 3 с")
                await asyncio.sleep(3)


async def main():
    token = (cfg.get("max") or {}).get("token")
    if not token:
        log("MAX_TOKEN не задан (.env) — бот MAX не запущен.")
        log("Токен: business.max.ru → Чат-боты → создать бота → Настройки → «Получить токен».")
        return
    lm = cfg.get("lmstudio") or {}
    if not ((lm.get("url") and lm.get("model")) or (cfg.get("vision") or {}).get("apiKey")):
        log("ВНИМАНИЕ: LM Studio (LMSTUDIO_URL, LMSTUDIO_MODEL) и VISION_API_KEY не настроены "
            "— распознавание фото не работает.")
    await MaxBot(token, cfg).run()


if __name__ == "__main__":
    asyncio.run(main())
