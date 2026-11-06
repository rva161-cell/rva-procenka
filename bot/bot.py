#!/usr/bin/env python3
"""Артикул-бот для Telegram (aiogram 3).

Это только транспорт: приём сообщений, скачивание фото и голосовых, проверка, что контакт
свой, кнопки в формате Telegram. Вся логика диалога — в core/dialog.py (общая с MAX-ботом
max_bot.py, основным).

Запуск: venv/bin/python bot.py  (или активировать venv и python bot.py)
Токен — .env → TELEGRAM_TOKEN; vision-ключ — .env → VISION_API_KEY.
Если api.telegram.org недоступен — VPN или TELEGRAM_PROXY_URL в .env (см. README.md).
"""
import asyncio
import io

from aiogram import Bot, Dispatcher, F, Router
from aiogram.client.default import DefaultBotProperties
from aiogram.filters import Command, CommandObject
from aiogram.types import (
    BotCommand, BufferedInputFile, CallbackQuery, InlineKeyboardButton, InlineKeyboardMarkup,
    KeyboardButton, Message, ReplyKeyboardMarkup,
)

from core.config import load_config
from core.dialog import Dialog, Keyboard, log

cfg = load_config()
TG_TEXT = 4096
TG_CAPTION = 1024
DIRECTOR_IDS: set[int] = set()  # Telegram-id директора; админ сайта (привязанный аккаунт) проходит и так

TG_USERNAME = ""  # имя бота для ссылок-приглашений, заполняется в main()
dialog = Dialog("telegram", cfg, messenger="Telegram", director_ids=DIRECTOR_IDS,
                invite_link=lambda uid: f"https://t.me/{TG_USERNAME}?start=i{uid}" if TG_USERNAME else "")
router = Router()


def tg_markup(buttons: Keyboard):
    """Кнопки диалога → разметка Telegram.

    Запрос контакта в Telegram возможен только на нижней клавиатуре (reply keyboard), поэтому
    сообщение с такой кнопкой получает её, а остальные кнопки становятся текстовыми —
    их нажатие приходит текстом («✖️ Отмена» диалог понимает).
    """
    if any(b.contact for row in buttons for b in row):
        return ReplyKeyboardMarkup(keyboard=[[KeyboardButton(text=b.text, request_contact=b.contact)
                                              for row in buttons for b in row if b.contact or b.action != "menu"]],
                                   resize_keyboard=True, one_time_keyboard=True)
    if not buttons:
        return None
    return InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=b.text, url=b.url) if b.url else
         InlineKeyboardButton(text=b.text, callback_data=b.action[:64]) for b in row]
        for row in buttons])


class TgChat:
    """Ответы в один чат Telegram (Chat для core/dialog.py)."""

    def __init__(self, bot: Bot, chat_id: int):
        self.bot, self.chat_id = bot, chat_id

    async def send(self, text: str, buttons: Keyboard, html: bool = False):
        m = await self.bot.send_message(self.chat_id, (text or "…")[:TG_TEXT], reply_markup=tg_markup(buttons),
                                        parse_mode="HTML" if html else None)
        return str(m.message_id) if m else ""

    async def send_image(self, data: bytes, caption: str, buttons: Keyboard):
        photo = BufferedInputFile(data, filename="image.png")
        if len(caption) <= TG_CAPTION:
            m = await self.bot.send_photo(self.chat_id, photo, caption=caption, reply_markup=tg_markup(buttons))
        else:  # длинная подпись — картинка и текст отдельными сообщениями
            m = await self.bot.send_photo(self.chat_id, photo)
            await self.send(caption, buttons)
        return str(m.message_id) if m else ""

    async def delete_message(self, mid: str):
        """Удалить своё сообщение (лента убирает прежние выдачи)."""
        if not mid:
            return
        try:
            await self.bot.delete_message(self.chat_id, int(mid))
        except Exception:
            pass

    async def edit(self, mid: str, text: str, buttons: Keyboard) -> bool:
        """Отредактировать своё сообщение на месте — новое меню появляется прямо
        под нажатой кнопкой, без прокрутки чата. Не вышло → False, диалог пошлёт меню отдельным сообщением."""
        if not mid or not buttons:
            return False
        try:
            await self.bot.edit_message_text((text or "…")[:TG_TEXT], chat_id=self.chat_id,
                                             message_id=int(mid), reply_markup=tg_markup(buttons))
            return True
        except Exception:
            pass
        try:  # карточка с картинкой (лента) правится как подпись к фото
            await self.bot.edit_message_caption((text or "…")[:TG_CAPTION], chat_id=self.chat_id,
                                                message_id=int(mid), reply_markup=tg_markup(buttons))
            return True
        except Exception:
            return False

    async def typing(self):
        try:
            await self.bot.send_chat_action(self.chat_id, "typing")
        except Exception:
            pass


def loader(bot: Bot, file_id: str):
    """Скачивание файла Telegram — вызывается диалогом, только когда файл нужен."""
    async def load() -> bytes:
        f = await bot.get_file(file_id)
        buf = io.BytesIO()
        await bot.download_file(f.file_path, destination=buf)
        return buf.getvalue()
    return load


def chat_of(message: Message) -> TgChat:
    return TgChat(message.bot, message.chat.id)


# ---------- обработчики ----------
@router.message(Command("start"))
async def on_start(message: Message, command: CommandObject):
    await dialog.handle_start(chat_of(message), message.from_user.id, payload=command.args or "")


@router.message(F.contact)
async def on_contact(message: Message):
    # только свой контакт: пересланная карточка чужого номера дала бы доступ к чужому аккаунту
    own = message.contact.user_id == message.from_user.id
    await dialog.handle_contact(chat_of(message), message.from_user.id, message.contact.phone_number, own)


@router.message(F.photo)
async def on_photo(message: Message):
    await dialog.handle_photo(chat_of(message), message.from_user.id,
                              loader(message.bot, message.photo[-1].file_id), message.caption or "")


@router.message(F.document.mime_type.startswith("image"))
async def on_image_file(message: Message):
    await dialog.handle_photo(chat_of(message), message.from_user.id,
                              loader(message.bot, message.document.file_id), message.caption or "")


@router.message(F.voice | F.audio)
async def on_voice(message: Message):
    f = message.voice or message.audio
    await dialog.handle_voice(chat_of(message), message.from_user.id, loader(message.bot, f.file_id))


@router.message(F.text)
async def on_text(message: Message):
    await dialog.handle_text(chat_of(message), message.from_user.id, message.text)


@router.callback_query(F.data)
async def on_callback(cb: CallbackQuery):
    await cb.answer()
    # cb.message.from_user — сам бот; настоящий пользователь — cb.from_user
    mid = str(cb.message.message_id) if cb.message else ""
    await dialog.handle_action(TgChat(cb.bot, cb.message.chat.id), cb.from_user.id, cb.data or "", mid=mid)


# ---------- запуск ----------
async def main():
    global TG_USERNAME
    token = (cfg.get("telegram") or {}).get("token")
    if not token:
        log("TELEGRAM_TOKEN не задан (.env) — бот не запущен. См. README.md")
        return
    lm = cfg.get("lmstudio") or {}
    if not ((lm.get("url") and lm.get("model")) or (cfg.get("vision") or {}).get("apiKey")):
        log("ВНИМАНИЕ: LM Studio (LMSTUDIO_URL, LMSTUDIO_MODEL) и VISION_API_KEY не настроены "
            "— распознавание фото не работает.")

    tcfg = cfg.get("telegram") or {}
    bot_kwargs = {"default": DefaultBotProperties()}
    if tcfg.get("proxy"):
        # прокси нужен, если api.telegram.org недоступен у провайдера (таймауты)
        from aiogram.client.session.aiohttp import AiohttpSession
        bot_kwargs["session"] = AiohttpSession(proxy=tcfg["proxy"])
        log(f"Telegram: работа через прокси {tcfg['proxy']}")
    bot = Bot(token=token, **bot_kwargs)
    me = None
    for attempt in range(1, 11):  # ждём связь: VPN/прокси мог подняться не сразу
        try:
            me = await bot.get_me()
            TG_USERNAME = me.username or ""
            break
        except Exception as e:
            log(f"Попытка {attempt}/10: связи с Telegram нет ({type(e).__name__}). "
                "Проверьте VPN/прокси — продолжаю ждать...")
            await asyncio.sleep(5)
    if me is None:
        log("Связь с Telegram так и не появилась за 50 секунд — бот остановлен. "
            "Включите VPN (или прокси в .env) и запустите снова.")
        await bot.session.close()
        return
    dp = Dispatcher()
    dp.include_router(router)
    log(f"Telegram: бот @{me.username} на связи (aiogram).")
    try:  # подсказки-команды в интерфейсе Telegram — зеркально MAX (PUT /me/commands)
        await bot.set_my_commands([
            BotCommand(command="start", description="Меню и ваш уровень"),
            BotCommand(command="help", description="Как пользоваться ботом"),
        ])
    except Exception:
        pass
    try:
        await dp.start_polling(bot)
    finally:
        await bot.session.close()


if __name__ == "__main__":
    asyncio.run(main())
