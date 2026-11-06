"""Диалог бота — общий для MAX и Telegram.

Здесь вся логика: меню, поиск артикула текстом и по фото, подтверждение кандидата,
мини-проценка с правилами уровней, лента «Мысль дня», приглашения, привязка аккаунта,
вопросы специалисту. Транспорты (max_bot.py, bot.py) только принимают сообщения,
скачивают файлы, проверяют, что контакт свой, и рисуют кнопки в формате мессенджера —
через объект Chat (send / send_image / typing).

Кнопки описываются как Button: callback (action), ссылка (url) или запрос контакта
(contact). Ряд «МЕНЮ» добавляется под каждым сообщением автоматически.
Сессии (состояние диалога) — в памяти процесса: после перезапуска бота начинаются заново.
"""
import asyncio
import datetime
import io
import re
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Protocol

import qrcode

from . import feedback, levels, lenta, news, photo_prep, speech, verify, vision, web_confirm
CLEAR_PHOTO_NOTE = ("💡 Если код читается плохо — сфотографируйте наклейку ещё раз: "
                    "чётче, крупнее, без бликов — распознаю заново.")
from .present import (
    ARTICLE_RE, CANCEL_BTN, CODE_BAD, CODE_BTN, CODE_PROMPT, FIND_HINT, HELP_TEXT,
    INVITE_BTN, INVITE_TEXT, LENTA_BTN, LINK_NOT_OWN, LINK_NO_ACCOUNT, LINK_OFFLINE, LINK_OK,
    LINK_PROMPT, MENU_BTN, MENU_GREETING, ORG_BTN, ORG_LOCKED_TEXT, PHOTO_LIMIT_TEXT,
    PHOTO_BTN, PHOTO_INSTRUCTION,
    APPROVE_BTN, APPROVAL_NEED_SEARCH, APPROVAL_SENT, PROCENKA_BTN,
    QUESTION_ACCEPTED, QUESTION_ERROR,
    REFERRAL_NOTE, REG_BTN, REG_LOCKED_BTN, REG_LOCKED_TEXT, START_JOIN_BTN, START_TEXT,
    THOUGHT_DENIED, THOUGHT_DUPLICATE, THOUGHT_PROMPT,
    attrs_line_of, card_text, level_status_text, offers_text,
)

# тексты старой нижней клавиатуры Telegram — у кого она осталась, кнопки продолжают работать
MENU_FIND = "🔍 Найти артикул"
MENU_PROCENKA = "💰 Проценка"
MENU_SITE = "🌐 Сайт"
MENU_ASK = "❓ Задать вопрос"
MENU_HELP = "ℹ️ Помощь"
MENU_LINK = "📱 Привязать аккаунт"
CONTACT_BTN = "📱 Отправить контакт"

ASK_PROMPT = ("❓ Напишите вопрос одним сообщением — передам специалисту, ответ придёт сюда.\n"
              "(«отмена» — вернуться в меню)")
NO_TEXT = ("Понял, это не она. Давайте уточним:\n"
           "📸 — пришлите фото крупнее: этикетка/маркировка должна быть читаема, без бликов "
           "(снимайте при рассеянном свете);\n"
           "⌨️ — или напишите артикул текстом — покажу предложения по нему.")
ERROR_TEXT = "⚠️ Что-то пошло не так — попробуйте ещё раз или нажмите «МЕНЮ»."


@dataclass
class Button:
    text: str
    action: str = ""      # callback: что делать по нажатию (handle_action)
    url: str = ""         # кнопка-ссылка
    contact: bool = False  # запрос номера телефона своего аккаунта


Keyboard = list[list[Button]]


class Chat(Protocol):
    """Куда отвечать: один чат одного пользователя в конкретном мессенджере."""
    async def send(self, text: str, buttons: Keyboard, html: bool = False) -> None: ...
    async def send_image(self, data: bytes, caption: str, buttons: Keyboard) -> None: ...
    async def edit(self, mid: str, text: str, buttons: Keyboard) -> bool: ...
    async def typing(self) -> None: ...


def log(*args):
    print(*args, flush=True)


def is_cancel(text: str) -> bool:
    t = text.lower()
    return "отмена" in t or t in ("cancel", "/cancel")


def _safe(handler):
    """Ошибка в обработчике → запись в лог и короткий ответ пользователю (а не тишина)."""
    async def wrapper(self, chat, uid, *args, **kwargs):
        try:
            return await handler(self, chat, uid, *args, **kwargs)
        except Exception as e:
            log(f"[{self.transport}] ошибка у user_id={uid} в {handler.__name__}: {type(e).__name__}: {e}")
            traceback.print_exc()
            try:
                await self.send(chat, ERROR_TEXT)
            except Exception:
                pass
    wrapper.__name__ = handler.__name__
    return wrapper


class Dialog:
    def __init__(self, transport: str, cfg: dict, *, messenger: str,
                 director_ids=(), invite_link: Callable[[int], str] = lambda uid: ""):
        self.transport = transport              # "max" | "telegram" — для сервера проценки
        self.cfg = cfg
        self.messenger = messenger              # название для текстов: «MAX», «Telegram»
        self.director_ids = {str(x) for x in director_ids}  # доступ к «Мысли дня» без роли admin
        self.invite_link = invite_link
        self.sessions: dict[int, dict] = {}     # user_id → {state, verified, chosen, menu, …}

    def sess(self, uid) -> dict:
        return self.sessions.setdefault(uid, {})

    # ---------- отправка ----------
    async def send(self, chat: Chat, text: str, buttons: Keyboard | None = None, html: bool = False):
        await chat.send(text or "…", self._with_menu(buttons), html)

    async def send_image(self, chat: Chat, data: bytes, caption: str, buttons: Keyboard | None = None):
        await chat.send_image(data, caption, self._with_menu(buttons))

    @staticmethod
    def _with_menu(buttons: Keyboard | None) -> Keyboard:
        """«МЕНЮ» — в последнем ряду каждого сообщения (если его там ещё нет)."""
        rows = [list(r) for r in (buttons or [])]
        if not any(b.action == "menu" for r in rows for b in r):
            rows.append([Button(MENU_BTN, "menu")])
        return rows

    async def _in_place(self, chat: Chat, mid: str | None, text: str,
                        buttons: Keyboard | None = None) -> bool:
        """Ответ НА МЕСТЕ нажатой кнопки: карточка сама становится инструкцией —
        пользователь видит её сразу, без прокрутки чата (важно из середины ленты).
        Не вышло (не MAX/TG или сбой) → False, шлём отдельным сообщением."""
        if not mid:
            return False
        try:
            return await chat.edit(mid, text, self._with_menu(buttons))
        except Exception:
            return False

    async def main_menu(self, uid) -> Keyboard:
        # Меню по уровням (схема директора 26.10):
        # 1 — просто зарегистрировались в боте: «Проценка» + «Зарегистрироваться»;
        # 2 — зарегистрировались на сайте: «Оценка» (заявка на согласование — кнопкой
        #     под результатом оценки);
        # 4 — полный доступ к проценке (открывает директор днями доступа): та же «Оценка»;
        # 5 — органайзер.
        info = await self.user(uid)
        site_url = ((self.cfg.get("site") or {}).get("url") or "").rstrip("/")  # без «/» — MAX API отвергает ссылку с «//»
        if not info.get("found"):
            # 1 уровень — две кнопки: оценка по артикулу (гостевая выдача) и регистрация
            menu = [[Button(CODE_BTN, "input_code")]]
            menu.append([Button(REG_BTN, url=site_url)] if site_url else [Button(REG_LOCKED_BTN, "reg_locked")])
            return menu
        menu = [[Button(CODE_BTN, "input_code")]]
        if str(uid) in self.director_ids or info.get("role") == "admin":
            menu.append([Button(PHOTO_BTN, "photo_help")])   # фото-поиск — личный инструмент директора
        menu.append([Button(INVITE_BTN, "invite")])
        menu.append([Button(LENTA_BTN, "join")])
        # «Органайзер» — только 5-й уровень (organizer_people.json), админ и директор
        if info.get("org") or info.get("role") == "admin" or str(uid) in self.director_ids:
            menu.append([Button(ORG_BTN, url=f"{site_url}/organizer")] if site_url
                        else [Button(ORG_BTN, "org_locked")])
        # «🖥 VPS» — только директору и админу: статус, ошибки, рестарты
        if info.get("role") == "admin" or str(uid) in self.director_ids:
            menu.append([Button("🖥 VPS", "vps")])
        return menu

    @staticmethod
    def options_kb(options: list[dict]) -> Keyboard:
        # по одной кнопке в ряду — название целиком, без обрезки
        return [[Button(o["label"], o["action"])] for o in options]

    # ---------- 🖥 VPS: статус сервера, ошибки, рестарты (только директор/админ) ----------
    VPS_SERVICES = [("rva-procenka", "🌐 сайт+проценка"), ("rva-max-bot", "🤖 бот MAX"),
                    ("rva-mail-api", "📬 почта (API)"), ("rva-mail-bot", "📨 почта (конвейер)"),
                    ("rva-stt", "🎙 голос (whisper)")]

    async def _vps_allowed(self, uid) -> bool:
        """Кнопка «VPS» — только директору и админу."""
        info = await self.user(uid)
        return info.get("role") == "admin" or str(uid) in self.director_ids

    async def _sh(self, *args: str, timeout: float = 15) -> str:
        p = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                 stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(p.communicate(), timeout)
        return (out or b"").decode("utf-8", "replace").strip()

    async def _vps_status(self) -> str:
        lines = ["🖥 Состояние сервера · " + datetime.now().strftime("%d.%m %H:%M")]
        for name, label in self.VPS_SERVICES:
            st = await self._sh("systemctl", "is-active", name)
            mark = "✅" if st == "active" else "⛔ " + (st or "?")
            when = ""
            if st == "active":
                since = await self._sh("systemctl", "show", name, "-p", "ActiveEnterTimestamp", "--value")
                parts = since.split()
                when = f" (с {parts[2]})" if len(parts) >= 3 else ""   # «… 22:05:04 MSK»
            lines.append(f"• {label}: {mark}{when}")
        site = await self._sh("curl", "-so", "/dev/null", "-w", "%{http_code}", "--max-time", "8",
                              "https://rva161.ru/")
        lines.append(f"• Сайт снаружи: HTTP {site or 'нет ответа'}")
        try:
            df = (await self._sh("df", "-h", "/")).split("\n")[1].split()
            mem = [l.split() for l in (await self._sh("free", "-m")).split("\n") if l.startswith("Mem:")][0]
            load = (await self._sh("cat", "/proc/loadavg")).split()[0]
            lines.append(f"• Память: {mem[2]} из {mem[1]} МБ · Диск: {df[4]} · Нагрузка: {load}")
        except Exception:
            pass
        backup = (await self._sh("ls", "-t", "/opt/rva/procenka/backups")).split("\n")[0]
        lines.append(f"• Последний бэкап: {backup or 'нет'}")
        return "\n".join(lines)

    async def _vps_errors(self) -> str:
        out = await self._sh("journalctl", "-u", "rva-max-bot", "-u", "rva-procenka",
                             "-p", "warning", "--since", "-3 hours", "--no-pager", "-n", "40",
                             timeout=20)
        lines = [l for l in out.split("\n") if l.strip() and "цикл" not in l]
        if not lines:
            return "⚠️ За последние 3 часа ошибок нет."
        return "⚠️ Ошибки за 3 часа:\n" + "\n".join(lines[-20:])

    async def _vps_restart(self, chat: Chat, action: str):
        groups = {"vps_rb_max_ok": ["rva-max-bot.service"],
                  "vps_rb_site_ok": ["rva-procenka.service"],
                  "vps_rb_all_ok": ["rva-mail-api.service", "rva-mail-bot.service", "rva-stt.service",
                                    "rva-procenka.service", "rva-max-bot.service"]}
        svcs = groups[action]
        restart_self = "rva-max-bot.service" in svcs
        if restart_self:
            await self.send(chat, "♻️ Перезапускаю… бот вернётся через несколько секунд.")
        for sv in svcs:
            try:
                p = await asyncio.create_subprocess_exec("sudo", "-n", "systemctl", "restart", sv,
                                                         stdout=asyncio.subprocess.DEVNULL,
                                                         stderr=asyncio.subprocess.PIPE)
                _, err = await asyncio.wait_for(p.communicate(), 25)
                if p.returncode != 0:
                    raise RuntimeError((err or b"").decode("utf-8", "replace").strip()[:150] or "sudo отказал")
            except Exception as e:
                return await self.send(chat, f"⚠️ {sv}: не перезапустился — {e}\n"
                                             "Если «sudo отказал» — не установлено правило sudoers (deploy/vps_sudoers).")
        if restart_self and len(svcs) == 1:
            return   # свой процесс уже перезапущен — дальше не живём
        await asyncio.sleep(4)
        await self.send(chat, "✅ Готово, службы подняты:\n" + await self._vps_status())
        if restart_self:   # «рестарт всего»: свой бот — последним
            await self.send(chat, "♻️ Осталось перезапустить самого бота — вернусь через несколько секунд.")
            await asyncio.create_subprocess_exec("sudo", "-n", "systemctl", "restart", "rva-max-bot.service")


    async def send_options(self, chat: Chat, text: str, options: list[dict]):
        await self.send(chat, text, self.options_kb(options))

    async def user(self, uid) -> dict:
        return await levels.resolve_user(self.transport, uid, self.cfg)

    async def help_text(self, uid) -> str:
        return HELP_TEXT + "\n\n" + level_status_text(await self.user(uid))

    # ---------- входящие ----------
    @_safe
    async def handle_start(self, chat: Chat, uid, payload: str = ""):
        """Стартовый экран: текст Prodobrey + «ПРИСОЕДИНИТЬСЯ». payload i<id> — по приглашению."""
        self.sess(uid).clear()
        greeting = ""
        if payload.startswith("i") and payload[1:].isdigit():
            if await feedback.post_referral(self.cfg, self.transport, uid, payload[1:]):
                greeting = REFERRAL_NOTE + "\n\n"
        await self.send(chat, greeting + START_TEXT, [[Button(START_JOIN_BTN, "join")]], html=True)

    @_safe
    async def handle_contact(self, chat: Chat, uid, phone: str, own: bool):
        """Контакт из кнопки «Отправить контакт». own — транспорт проверил, что номер свой."""
        s = self.sess(uid)
        if not own:
            s["state"] = "phone"
            return await self.send(chat, LINK_NOT_OWN, self._link_kb())
        s.pop("state", None)
        phone = levels.norm_phone(phone)
        if not phone:
            s["state"] = "phone"
            return await self.send(chat, LINK_PROMPT, self._link_kb())
        r = await levels.link_by_phone(self.transport, uid, phone, self.cfg)
        if r.get("offline"):
            text = LINK_OFFLINE
        elif not r.get("found"):
            text = LINK_NO_ACCOUNT.format(phone=phone)
        else:
            text = LINK_OK.format(login=r.get("login") or "аккаунт", status=level_status_text(r))
        await self.send(chat, text)

    @staticmethod
    def _link_kb() -> Keyboard:
        return [[Button(CANCEL_BTN, "cancel_link"), Button(CONTACT_BTN, contact=True)]]

    @_safe
    async def handle_voice(self, chat: Chat, uid, load: Callable[[], Awaitable[bytes]] | None = None,
                           transcription: str | None = None):
        """Голосовое → текст (готовая расшифровка мессенджера или STT) → как обычное сообщение."""
        text = (transcription or "").strip()
        if not text:
            if load is None:
                return await self.send(chat, "Не удалось получить голосовое сообщение.")
            data = await load()
            text, err = await asyncio.to_thread(speech.transcribe, data)
            if err or not text:
                log(f"[{self.transport}] STT: {err or 'пустой текст'}")
                return await self.send(chat, "⚠️ Не удалось распознать голосовое — напишите текстом.")
        log(f"[{self.transport}] голос → текст: {text[:80]}")
        await self.handle_text(chat, uid, text)

    @_safe
    async def handle_photo(self, chat: Chat, uid, load: Callable[[], Awaitable[bytes]], caption: str = ""):
        if self.sess(uid).get("state") == "lenta_card":   # директор прислал карточку «Мысль дня»
            return await self._thought_card(chat, uid, await load())
        if str(uid) not in self.director_ids and (await self.user(uid)).get("role") != "admin":
            return await self.send(chat, "📸 Поиск по фото сейчас работает только у владельца. "
                                         "Пришлите артикул текстом — найду.")
        # 3 уровень — распознавание по фото: для зарегистрированных по квоте «Фото» из кабинета
        # (по умолчанию 1); директору, админу и «близким» — без лимита
        info = await self.user(uid)
        # квота «Фото» на день: 2 — просто подключившиеся в боте, 4 — зарегистрированные,
        # 6 — с доступом к проценке; админ/директор/близкие — без лимита
        unlimited = (str(uid) in self.director_ids or info.get("role") == "admin"
                     or (info.get("level") or 0) >= 4)
        left = None
        if not unlimited:
            left = int(info.get("photos") or 0) - int(info.get("photo_used") or 0)
            if left <= 0:
                return await self.send(chat, PHOTO_LIMIT_TEXT)
        photo = await load()
        # «сканер после снимка»: резкость и наклейка — до списания квоты,
        # смазанный кадр не расходует дневной лимит
        try:
            prep = await asyncio.to_thread(photo_prep.prepare, photo)
        except photo_prep.BlurryPhoto:
            return await self.send(chat, "📷 Кадр смазан — наклейку не разобрать.\n\n"
                                         "Снимите ещё раз: держите телефон в 15–20 см от наклейки "
                                         "и дождитесь фокуса. Фото списано не было.")
        except Exception as e:   # предобработка не удалась — шлём фото как есть
            print(f"[фото] предобработка не удалась, распознаю исходное: {e}")
            prep = None
        if left is not None:   # любое присланное фото расходует дневной лимит
            try:
                await levels.photo_used(self.cfg, self.transport, uid, info)
            except Exception as e:
                print(f"[фото] не удалось списать квоту: {e}")
        await chat.typing()
        # очередь: если кто-то распознаёт прямо сейчас — предупредим об ожидании заранее
        pos, eta = vision.queue_eta()
        if pos:
            await self.send(chat, f"⏳ Вы {pos}-й в очереди распознавания — примерно "
                                  f"{eta // 60 or 1} мин. Скоро начну…")
        # чёткий кадр → сначала маленькая быстрая модель; не уверена — основная
        try:
            v = await vision.recognize_photo(prep.data if prep else photo, caption or None, self.cfg,
                                             prefer_fast=bool(prep and prep.blur_var >= 60))
        except vision.DemoModeError as e:
            return await self.send(chat, f"🔬 {e}\n\nРаспознавание фото работает через LM Studio — "
                                         "модель на нашем компьютере (в .env: LMSTUDIO_URL, LMSTUDIO_MODEL). "
                                         "Запасной облачный канал — GLM-4.6V, ключ VISION_API_KEY с api.vision-ai.example. "
                                         "После правки .env перезапустите бота.")
        except Exception as e:
            return await self.send(chat, f"⚠️ Ошибка распознавания: {e}\n"
                                         "Попробуйте ещё раз или пришлите фото другого размера.")

        if not v["is_auto_part"]:
            self.sess(uid).clear()
            if left is not None and left - 1 <= 0:   # последнее фото потрачено впустую
                return await self.send(chat, PHOTO_LIMIT_TEXT)
            return await self.send(chat, f"На фото не похоже на автозапчасть: "
                                         f"{v['what_is_it'] or 'не удалось определить'}.\n"
                                         f"Осталось фото на сегодня: {left - 1}.")
        await chat.typing()
        try:
            ver = await verify.verify_candidates(v, self.cfg)
        except Exception as e:
            ver = {"verified": [], "checked_codes": [], "source": f"недоступно: {e}",
                   "unverified": [{"code": c["code"], "brand": v["brand"], "name": v["product_name"] or "",
                                   "verified": False, "confidence": c["confidence"]} for c in v["candidates"]]}

        # артикул прочитан уверенно (чёткая этикетка) И подтверждён базой поставщиков —
        # сразу в проценку, без «верно/не то». Неподтверждённые коды (модель может
        # «вспомнить» несуществующий артикул) — через веб-подтверждение или человека.
        top_conf = (v.get("candidates") or [{}])[0].get("confidence") or 0
        if top_conf >= 0.85 and ver["verified"]:
            top = ver["verified"][0]
            chosen = {**top, "attrs_line": attrs_line_of(v)}
            await self.send(chat, f"✅ Артикул считан: {top.get('brand') or ''} {top['code']} "
                                  f"— сразу считаю проценку…")
            return await self._run_offers(chat, uid, chosen)

        # сомнения в артикуле (уверенность < 0.85 или код не подтверждён) → парсинг
        # по наименованию: интернет предлагает коды, базы поставщиков отбирают настоящее
        if not (top_conf >= 0.85 and ver["verified"]):
            # запрос по правилу директора: полное наименование + литраж + слово «артикул»
            attrs = v.get("attributes") or {}
            vol = str(attrs.get("объём в литрах") or attrs.get("объём") or "").strip()
            sae = str(attrs.get("SAE-вязкость") or "").strip()
            maybe = " ".join(x for x in (v.get("brand"), v.get("product_name"), sae,
                                         (vol + "L") if vol else "") if x) \
                or v.get("what_is_it") or ""
            if len(maybe.strip()) >= 4:
                maybe = maybe.strip() + " артикул"
                await self.send(chat, "🔎 Артикул под вопросом — проверяю по интернету…")
                try:
                    web = await web_confirm.confirm(maybe, self.cfg)
                except Exception as e:
                    web = []
                    print(f"[фото] веб-подтверждение не удалось: {e}")
                if web:
                    v2 = {"candidates": [{"code": c["code"], "confidence": 0.6, "source": "интернет"}
                                         for c in web],
                          "brand": v.get("brand"), "product_name": v.get("product_name")}
                    try:
                        ver2 = await verify.verify_candidates(v2, self.cfg)
                    except Exception:
                        ver2 = {"verified": [], "unverified": [
                            {"code": c["code"], "brand": c["brand"], "name": c["name"],
                             "verified": False, "confidence": 0.6} for c in web]}
                    if ver2["verified"]:
                        top = ver2["verified"][0]
                        chosen = {**top, "attrs_line": attrs_line_of(v)}
                        await self.send(chat, f"✅ Подтверждено по интернету: "
                                              f"{top.get('brand') or ''} {top['code']} — считаю проценку…")
                        return await self._run_offers(chat, uid, chosen)
                    if ver2["unverified"]:
                        return await self._show_candidates(chat, uid, [], ver2["unverified"],
                                                           attrs_line_of(v), note=CLEAR_PHOTO_NOTE)

        if not ver["verified"] and not ver["unverified"]:
            self.sess(uid).clear()
            bits = ["Не смог определить артикул по этому фото.", f"Видно: {v['what_is_it']}."]
            maybe = " ".join(x for x in (v["brand"], v["product_name"]) if x)
            if maybe:
                bits.append(f"Похоже на: {maybe}.")
            if v["category"]:
                bits.append(f"Категория: {v['category']}.")
            if v["not_sure_because"]:
                bits.append(f"Мешает: {v['not_sure_because']}.")
            if v["advice"]:
                bits.append(f"💡 {v['advice']}")
            bits += ["", "Сфотографируйте наклейку на обратной стороне канистры крупнее — "
                         "чтобы коды на ней были читаемы."]
            return await self.send(chat, "\n".join(bits))

        await self._show_candidates(chat, uid, ver["verified"], ver["unverified"], attrs_line_of(v),
                                    note=CLEAR_PHOTO_NOTE)

    @_safe
    async def handle_text(self, chat: Chat, uid, text: str):
        text = (text or "").strip()
        s = self.sess(uid)
        state = s.get("state")

        if state == "lenta_card":  # ждём картинку карточки
            if is_cancel(text):
                return await self._action(chat, uid, "menu")
            return await self.send(chat, "Пришлите карточку картинкой (или «отмена»).",
                                   [[Button(CANCEL_BTN, "cancel_thought")]])
        if state == "lenta_review":  # карточка обработана — текстом приходит история
            if is_cancel(text):
                lenta.clear_review()
                return await self._action(chat, uid, "menu")
            review = lenta.get_review()
            if not review.get("image"):
                s.clear()
                return await self.send(chat, "Нет карточки для публикации — пришлите через «📰 Мысль дня».")
            review["story"] = text
            lenta.set_review(review)
            return await self.send(chat, "✍️ История возникновения:\n\n" + text,
                                   [[Button("✓ Разместить", "publish_lenta")]])
        if state == "article":  # ждём артикул после кнопки «Оценка»
            if is_cancel(text):
                return await self._action(chat, uid, "menu")
            maybe = text.replace(" ", "")
            if ARTICLE_RE.fullmatch(maybe):
                s.clear()
                return await self._search_by_code(chat, uid, maybe)
            return await self.send(chat, CODE_BAD, [[Button(CANCEL_BTN, "cancel_code")]])
        if state == "ask":  # вопрос специалисту
            s.clear()
            if is_cancel(text):
                return await self._action(chat, uid, "menu")
            ok = await feedback.post_question(self.cfg, self.transport, uid, text)
            return await self.send(chat, QUESTION_ACCEPTED if ok else QUESTION_ERROR)
        if state == "phone":  # ждём контакт кнопкой — номер текстом не принимаем
            s.pop("state", None)
            if is_cancel(text):
                return await self.send(chat, "Отменено.", await self.main_menu(uid))
            if levels.norm_phone(text):
                s["state"] = "phone"
                return await self.send(chat, LINK_PROMPT, self._link_kb())

        low = text.lower()
        if is_cancel(text):  # «отмена» вне шага (например, кнопка с нижней клавиатуры Telegram)
            return await self._action(chat, uid, "menu")
        if low in ("/start", "start", "старт"):  # кнопка «Начать» и текст без слэша
            return await self.handle_start(chat, uid)
        if low == "/help" or text == MENU_HELP:
            return await self._action(chat, uid, "help")
        if low == "/menu":
            return await self._action(chat, uid, "menu")
        if low in ("документы", "сканы", "файлы"):   # раздел 6.7: сканы — прямо из бота
            return await self._org_files(chat, uid)
        if text == MENU_FIND:
            return await self._action(chat, uid, "find")
        if text == MENU_LINK:
            return await self._action(chat, uid, "link")
        if text == MENU_ASK:
            return await self._action(chat, uid, "ask")
        if text in (MENU_PROCENKA, MENU_SITE):
            s.clear()
            procenka = text == MENU_PROCENKA
            url = (self.cfg.get("site") or {}).get("procenka_public_url" if procenka else "url")
            if url:
                return await self.send(
                    chat, "💰 Полная проценка по артикулу (все поставщики, аналоги, фильтры):" if procenka
                    else "🌐 Главная страница сайта:",
                    [[Button("Открыть проценку" if procenka else "Открыть сайт", url=url)]])
            return await self.send(
                chat, "💰 Страница проценки ещё не опубликована — работает мини-проценка прямо здесь: "
                      "напишите артикул текстом." if procenka
                else "🌐 Сайт сейчас в разработке — ссылка появится здесь чуть позже.")

        # выбор пункта цифрой в текущем меню
        if re.fullmatch(r"[1-9]", text) and s.get("menu"):
            idx = int(text) - 1
            if idx < len(s["menu"]):
                return await self._action(chat, uid, s["menu"][idx]["action"])

        maybe = text.replace(" ", "")
        if ARTICLE_RE.fullmatch(maybe):
            return await self._search_by_code(chat, uid, maybe)

        s.clear()
        await self.send(chat, "Не понял сообщение.\n\n" + await self.help_text(uid), await self.main_menu(uid))

    @_safe
    async def handle_action(self, chat: Chat, uid, action: str, mid: str | None = None):
        await self._action(chat, uid, action, mid)

    # ---------- кнопки ----------
    async def _action(self, chat: Chat, uid, action: str, mid: str | None = None):
        s = self.sess(uid)

        if action == "menu":
            s.clear()
            if await self._in_place(chat, mid, MENU_GREETING, await self.main_menu(uid)):
                return
            return await self.send(chat, MENU_GREETING, await self.main_menu(uid))
        if action == "join":
            s.clear()
            return await self._feed(chat, uid)
        if action == "help":
            s.clear()
            text = await self.help_text(uid)
            if await self._in_place(chat, mid, text, await self.main_menu(uid)):
                return
            return await self.send(chat, text, await self.main_menu(uid))
        if action in ("find", "new"):
            s.clear()
            text = FIND_HINT if action == "find" else "Жду фотографию запчасти 📸\n(или напишите артикул текстом)"
            if await self._in_place(chat, mid, text):
                return
            return await self.send(chat, text)
        if action == "input_code":
            s.clear()
            s["state"] = "article"
            if await self._in_place(chat, mid, CODE_PROMPT, [[Button(CANCEL_BTN, "cancel_code")]]):
                return
            return await self.send(chat, CODE_PROMPT, [[Button(CANCEL_BTN, "cancel_code")]])
        if action == "photo_help":
            s.clear()
            if await self._in_place(chat, mid, PHOTO_INSTRUCTION):
                return
            return await self.send(chat, PHOTO_INSTRUCTION)
        if action == "request_approval":
            # 2 уровень: результат оценки уходит директору на согласование (задача + сообщение)
            s = self.sess(uid)
            ap = s.get("approval")
            if s.get("state") != "approval_ready" or not ap:
                return await self.send(chat, APPROVAL_NEED_SEARCH)
            info = await self.user(uid)
            try:
                await levels.approval_submit(self.cfg, self.transport, uid, info, ap)
            except Exception as e:
                return await self.send(chat, f"⚠️ Не удалось отправить заявку: {e}")
            s.clear()
            return await self.send(chat, APPROVAL_SENT)
        if action == "ask":
            s.clear()
            s["state"] = "ask"
            return await self.send(chat, ASK_PROMPT, [[Button(CANCEL_BTN, "menu")]])
        if action == "link":
            s.clear()
            s["state"] = "phone"
            return await self.send(chat, LINK_PROMPT, self._link_kb())
        if action == "cancel_link":
            s.pop("state", None)
            return await self.send(chat, "Отменено.", await self.main_menu(uid))
        if action in ("cancel_code", "cancel_thought"):
            s.clear()
            return await self._action(chat, uid, "menu")
        if action == "reg_locked":
            return await self.send(chat, REG_LOCKED_TEXT)
        if action == "org_locked":   # кнопка «Органайзер», пока сайт не опубликован
            return await self.send(chat, ORG_LOCKED_TEXT)
        if action == "vps":
            s.clear()
            if not await self._vps_allowed(uid):
                return
            return await self.send(chat, "🖥 Управление сервером — выберите действие:",
                                   [[Button("📊 Статус", "vps_status")],
                                    [Button("⚠️ Последние ошибки", "vps_errors")],
                                    [Button("♻️ Рестарт бота MAX", "vps_rb_max")],
                                    [Button("🌐 Рестарт сайта", "vps_rb_site")],
                                    [Button("♻️ Рестарт всего", "vps_rb_all")],
                                    [Button(CANCEL_BTN, "vps_cancel")]])
        if action == "vps_cancel":
            s.clear()
            return await self.send(chat, "Отменено.", await self.main_menu(uid))
        if action in ("vps_status", "vps_errors", "vps_rb_max", "vps_rb_site", "vps_rb_all",
                      "vps_rb_max_ok", "vps_rb_site_ok", "vps_rb_all_ok"):
            if not await self._vps_allowed(chat, uid):
                return
            if action == "vps_status":
                return await self.send(chat, await self._vps_status(), [[Button(CANCEL_BTN, "vps_cancel")]])
            if action == "vps_errors":
                return await self.send(chat, await self._vps_errors(), [[Button(CANCEL_BTN, "vps_cancel")]])
            if action in ("vps_rb_max", "vps_rb_site", "vps_rb_all"):
                what = {"vps_rb_max": "бот MAX", "vps_rb_site": "сайт (проценку)",
                        "vps_rb_all": "ВСЕ службы (сайт, почта, голос, бот)"}[action]
                return await self.send(chat, f"Перезапустить {what}?",
                                       [[Button("✅ Да, перезапустить", action + "_ok")],
                                        [Button(CANCEL_BTN, "vps_cancel")]])
            return await self._vps_restart(chat, action)
        if action == "invite":
            s.clear()
            return await self._invite(chat, uid)
        if action == "thought":
            s.clear()
            info = await self.user(uid)
            if info.get("role") != "admin" and str(uid) not in self.director_ids:
                log(f"[{self.transport}] «Мысль дня»: доступ запрещён user_id={uid} "
                    f"(роль: {info.get('role') or 'нет'}, в базе: {info.get('found')})")
                return await self.send(chat, THOUGHT_DENIED)
            s["state"] = "lenta_card"
            return await self.send(chat, THOUGHT_PROMPT, [[Button(CANCEL_BTN, "cancel_thought")]])
        if action == "publish_lenta":
            review = lenta.get_review()
            if not review.get("image"):
                s.clear()
                return await self.send(chat, "Нет карточки для публикации — пришлите через «📰 Мысль дня».")
            lenta.news_add({"date": lenta.ru_today(), "title": "Мысль дня",
                            "image": review["image"], "text": review.get("story") or ""})
            lenta.clear_review()
            s.clear()
            return await self.send(chat, "✓ Опубликовано в ленте сайта.")

        if action == "ok":
            chosen = s.get("chosen")
            if not chosen:
                return await self.send(chat, "Сессия устарела — пришлите фото или артикул заново.",
                                       await self.main_menu(uid))
            return await self._run_offers(chat, uid, chosen)
        if action == "no":
            s.clear()
            return await self.send(chat, NO_TEXT)
        if action == "alt":
            return await self._alternatives(chat, uid)
        if action.startswith("pick:"):
            alt = s.get("alt_list") or []
            i = int(action[5:] or 0) if action[5:].isdigit() else len(alt)
            if i >= len(alt):
                return await self.send(chat, "Вариант устарел — пришлите фото заново.", await self.main_menu(uid))
            c = alt[i]
            options = [{"label": "✅ Верно — проценка", "action": "ok"},
                       {"label": "❌ Не то", "action": "no"},
                       {"label": "🔄 Другие варианты", "action": "alt"}]
            s.update(chosen=c, menu=options)
            return await self.send_options(chat, card_text(c, c.get("attrs_line")), options)
        if action.startswith("brand:"):
            bl = s.get("brand_list") or []
            i = int(action[6:] or 0) if action[6:].isdigit() else len(bl)
            if i >= len(bl):
                return await self.send(chat, "Список устарел — введите артикул заново.", await self.main_menu(uid))
            return await self._choose(chat, uid, bl[i])
        if action.startswith("ofile:"):   # прислать файл органайзера в чат (6.7)
            fid = int(action[6:]) if action[6:].isdigit() else 0
            got = await news.organizer_file(self.cfg, fid) if fid else None
            if not got:
                return await self.send(chat, "⚠️ Файл не получен — попробуйте ещё раз.")
            data, name, kind, yadisk = got
            cap = f"📄 {name}" + (f"\n🔗 {yadisk}" if yadisk else "")
            if kind == "image":
                return await self.send_image(chat, data, cap)
            return await self.send(chat, cap + "\n(это не картинка — откройте файл в органайзере на сайте)")

        log(f"[{self.transport}] неизвестная кнопка «{action}» от user_id={uid}")
        await self.send(chat, MENU_GREETING, await self.main_menu(uid))

    # ---------- лента и приглашения ----------
    async def _feed(self, chat: Chat, uid):
        """Лента: последние 10 ДНЕЙ, свежая карточка сверху. Прежние выдачи ленты бот
        удаляет — в чате остаётся только свежая лента. Кнопка «МЕНЮ» — под каждой
        карточкой: при прокрутке она всегда рядом (прибить кнопку внизу экрана
        мессенджеры не дают)."""
        items = await news.fetch_news(self.cfg)
        items = [n for n in items if lenta.within_days(n.get("date") or "", 10)]
        cards = [(n, lenta.PUB / Path(n.get("image") or "x").name) for n in items]
        cards = [(n, f) for n, f in cards if f.exists()]
        if not cards:
            return await self.send(chat, "📰 Лента новостей\n\nЗа последние 10 дней новостей нет", await self.main_menu(uid))
        # убрать прежнюю выдачу ленты — это сообщения самого бота, он их может удалить
        key = f"{self.transport}:{uid}"
        if hasattr(chat, "delete_message"):
            for mid in lenta.get_feed_msgs(key):
                try:
                    await chat.delete_message(mid)
                except Exception:
                    pass
        mids = []
        for n, f in cards[:10]:                      # порядок как на сайте: свежее сверху
            cap = "🗓 " + (n.get("date") or "")
            if n.get("text"):
                cap += "\n\n" + n["text"]
            try:
                mid = await chat.send_image(f.read_bytes(), cap, [[Button(MENU_BTN, "menu")]])
                if mid:
                    mids.append(mid)
            except Exception as e:
                log(f"[{self.transport}] лента: карточка {f.name} не отправилась: {e}")
            await asyncio.sleep(0.3)
        if hasattr(chat, "delete_message"):
            lenta.set_feed_msgs(key, mids)

    async def _org_files(self, chat: Chat, uid):
        """«документы»: последние файлы/сканы органайзера — можно получить прямо в чат (6.7)."""
        info = await self.user(uid)
        if info.get("role") != "admin" and str(uid) not in self.director_ids:
            return await self.send(chat, "Список файлов органайзера доступен только администратору.")
        files = await news.organizer_files(self.cfg)
        if not files:
            return await self.send(chat, "📄 В органайзере пока нет файлов — они появятся здесь после первого скана или письма с вложением.")
        rows = [[Button(("🖼 " if f["kind"] == "image" else "📄 ") + (f["name"] or "файл")[:40], f"ofile:{f['id']}")]
                for f in files]
        await self.send(chat, "📄 Последние файлы органайзера — нажмите, чтобы получить:", rows + [[Button(MENU_BTN, "menu")]])

    async def _invite(self, chat: Chat, uid):
        link = self.invite_link(uid)
        if not link:
            return await self.send(chat, "Приглашения пока недоступны — попробуйте позже.")
        text = INVITE_TEXT.format(link=link, messenger=self.messenger)
        buf = io.BytesIO()
        qrcode.make(link, box_size=10, border=2).save(buf, format="PNG")
        try:
            await self.send_image(chat, buf.getvalue(), text)
        except Exception as e:
            log(f"[{self.transport}] приглашение user_id={uid}: QR не отправлен — {type(e).__name__}: {e}")
            await self.send(chat, text + f"\n\n⚠️ Картинку отправить не удалось: {e}")

    async def _thought_card(self, chat: Chat, uid, data: bytes):
        """Карточка «Мысль дня»: обработка по промту → показ → история → «Разместить» → лента."""
        s = self.sess(uid)
        await self.send(chat, "⏳ Обрабатываю карточку по промту…")
        edited, err = await asyncio.to_thread(lenta.edit_card, data, lenta.card_prompt())
        if err:
            return await self.send(chat, f"⚠️ Обработка не удалась: {err}\nПришлите карточку ещё раз или «отмена».",
                                   [[Button(CANCEL_BTN, "cancel_thought")]])
        image_web, image_file, sha = lenta.save_card(edited)
        if lenta.last_card_hash() == sha:
            s.clear()
            return await self.send(chat, THOUGHT_DUPLICATE)
        lenta.set_last_card_hash(sha)

        v = self.cfg.get("vision") or {}
        story = await asyncio.to_thread(lenta.story_draft, image_file, v.get("apiKey") or "",
                                        v.get("model") or "glm-4.6v",
                                        v.get("baseUrl") or "https://vision-ai.example/api/paas/v4") or ""
        lenta.set_review({"image": image_web, "story": story})
        s.clear()
        s["state"] = "lenta_review"
        await self.send_image(chat, edited, "✓ Карточка обработана по промту. Проверьте.")
        await self.send(chat, ("✍️ История возникновения:\n\n" + story +
                               "\n\n(чтобы заменить — пришлите свой текст сообщением)") if story else
                        "✍️ Черновик истории не написан — пришлите текст истории сообщением.",
                        [[Button("✓ Разместить", "publish_lenta")]])

    # ---------- артикул → бренд → предложения ----------
    async def _show_candidates(self, chat: Chat, uid, verified: list, unverified: list,
                               aline: str | None, note: str | None = None):
        top = {**(verified or unverified)[0], "attrs_line": aline}
        options = [{"label": "✅ Верно — проценка", "action": "ok"},
                   {"label": "❌ Не то", "action": "no"}]
        if len(verified) + len(unverified) > 1:
            options.append({"label": "🔄 Другие варианты", "action": "alt"})
        s = self.sess(uid)
        s.clear()
        s.update(state="confirm", verified=verified, unverified=unverified, chosen=top, menu=options)
        text = card_text(top, aline) + (("\n\n" + note) if note else "")
        await self.send_options(chat, text, options)

    async def _alternatives(self, chat: Chat, uid):
        s = self.sess(uid)
        verified = s.get("verified") or []
        others = list(verified[1:])
        for u in (s.get("unverified") or []):
            if not any(verify.norm_code(v["code"]) == verify.norm_code(u["code"])
                       and verify.brand_matches(v.get("brand"), u.get("brand")) for v in verified):
                others.append(u)
        if not others:
            return await self.send(chat, "Других вариантов нет — распознавание уверено в единственном кандидате.")
        shown = others[:6]
        options = [{"label": f"{'✅' if c.get('verified') else '⚠️'} {c.get('brand') or '?'} {c['code']}"
                             f"{' — ' + str(c.get('name'))[:40] if c.get('name') else ''}",
                    "action": f"pick:{i}"} for i, c in enumerate(shown)]
        options.append({"label": "📸 Новое фото", "action": "new"})
        s.update(alt_list=shown, menu=options)
        await self.send_options(chat, "Другие варианты (✅ — подтверждён по базе, ⚠️ — предположение):", options)

    async def _search_by_code(self, chat: Chat, uid, code: str):
        await chat.typing()
        try:
            r = await verify.lookup_brands(code, self.cfg)
        except Exception as e:
            return await self.send(chat, f"⚠️ Не удалось связаться с базами поставщиков: {e}")
        brands = r.get("brands") or []
        s = self.sess(uid)
        if not brands:
            s.clear()
            return await self.send(chat, f"Артикул «{code}» не найден (источник: {r.get('source')}).\n"
                                         "Проверьте написание или пришлите фото детали 📸", await self.main_menu(uid))
        if len(brands) == 1:
            return await self._choose(chat, uid, {**brands[0], "code": brands[0]["code"] or code})
        shown = brands[:8]
        options = [{"label": f"{b['brand']} — {b['name'] or b['code']}"[:60], "action": f"brand:{i}"}
                   for i, b in enumerate(shown)]
        extra = (f"\n(и ещё {len(brands) - len(shown)} — уточните артикул или пришлите фото 📸)"
                 if len(brands) > len(shown) else "")
        s.clear()
        s.update(state="choose_brand", brand_list=shown, menu=options)
        await self.send_options(chat, f"По артикулу «{code}» найдено брендов: {len(brands)}. Какой нужен?{extra}",
                                options)

    async def _choose(self, chat: Chat, uid, b: dict):
        chosen = {"code": b["code"], "brand": b["brand"], "name": b.get("name") or "",
                  "pid": b.get("pid"), "suppliers": b.get("suppliers") or [], "verified": True}
        s = self.sess(uid)
        s.clear()
        s.update(state="confirm", verified=[chosen], unverified=[], chosen=chosen, menu=[])
        await self._run_offers(chat, uid, chosen)

    async def _run_offers(self, chat: Chat, uid, cand: dict):
        await chat.typing()
        try:
            r = await verify.search_offers(cand["code"], cand["brand"], cand.get("pid"),
                                           cand.get("name") or "", self.cfg)
        except Exception as e:
            return await self.send(chat, f"⚠️ Не удалось получить проценку: {e}\n"
                                         "Проверьте, что программа проценки запущена, и попробуйте ещё раз.")
        rows = [x for x in (r.get("rows") or []) if (x.get("price") or 0) > 0]
        info = await self.user(uid)
        # гость: ×наценка, топ-10, без поставщиков; поверх — скидка за приглашения
        rows, total = levels.apply_guest_rules(rows, info["level"], self.cfg, info.get("discount", 0),
                                               info.get("guest_markup"))
        self.sess(uid)["menu"] = []
        if not rows:
            return await self.send(chat, f"По артикулу {cand.get('brand') or ''} {cand['code']} "
                                         f"предложений не найдено (источник: {r.get('source')}).\n"
                                         "Возможно, артикул устарел — введите другой артикул или нажмите МЕНЮ.")
        txt = offers_text(rows, r.get("source"), cand, self.cfg, total)
        # 2 уровень (зарегистрирован на сайте): под результатом — заявка директору на согласование
        if info.get("level") == 2:
            self.sess(uid).update(state="approval_ready",
                                  approval={"code": cand["code"], "brand": cand.get("brand") or "", "text": txt[:3500]})
            return await self.send(chat, txt, [[Button(APPROVE_BTN, "request_approval")]])
        await self.send(chat, txt)
