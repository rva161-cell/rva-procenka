#!/usr/bin/env python3
"""Почтовый конвейер «Мысль дня»: письмо от директора → лента сайта.

Поток (по договорённости с директором):
  1. Он шлёт с любого адреса письмо с темой «мысль дня» и вложением-карточкой.
  2. Скрипт: сохраняет картинку в public/lenta/, добавляет запись в news.json
     (свежая — вверху), пишет историю возникновения (GLM-4.6V) и отвечает
     черновиком истории.
  3. Директор отвечает «выкладывай» (или присылает исправленный текст +
     «выкладывай») — история публикуется под карточкой.

Логика ленты — общее ядро core/lenta.py (то же, что у ботов).
Запуск: ../bot/venv/bin/python lenta_bot.py
"""
import email
import email.policy
import imaplib
import re
import smtplib
import sys
import time
from datetime import datetime
from email.utils import formatdate, make_msgid, parseaddr
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / "bot"))
from core import lenta as lenta_core  # noqa: E402
from core.lenta import load_state, news_add, news_set_text, ru_today, save_state, save_card, story_draft  # noqa: E402

import json  # noqa: E402


def read_env(path: Path) -> dict:
    env = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$", line)
            if m:
                env[m.group(1)] = m.group(2).strip().strip("\"'")
    except FileNotFoundError:
        pass
    return env


ENV = read_env(ROOT / ".env")
BOT_ENV = read_env(ROOT.parent / "bot" / ".env")
IMAP_HOST = ENV.get("IMAP_HOST") or "imap.yandex.ru"
IMAP_POLL = int(ENV.get("IMAP_POLL") or 90)
SMTP_USER = ENV.get("SMTP_USER") or ""
SMTP_PASS = ENV.get("SMTP_PASS") or ""
FROM = "your-email@gmail.com"  # от кого ожидаем карточки (но ловим любого — см. lenta_bot логи)
VISION_KEY = (ENV.get("VISION_API_KEY") or BOT_ENV.get("VISION_API_KEY") or "").strip()
VISION_MODEL = BOT_ENV.get("VISION_MODEL") or "glm-4.6v"
VISION_BASE = (BOT_ENV.get("VISION_BASEURL") or "https://vision-ai.example/api/paas/v4").rstrip("/")
STATE_FILE = lenta_core.STATE_FILE

log = lambda *a: print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


# ---------- отправка ответа ----------
def reply(to: str, subject: str, in_reply_to: str | None, text: str):
    msg = email.message.EmailMessage()
    msg["From"] = SMTP_USER
    msg["To"] = to
    msg["Subject"] = subject
    msg["Date"] = formatdate()
    msg["Message-ID"] = make_msgid(domain="vredkin.ru")
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    msg.set_content(text)
    with smtplib.SMTP_SSL(ENV.get("SMTP_HOST") or "smtp.yandex.ru", 465) as s:
        s.login(SMTP_USER, SMTP_PASS)
        s.send_message(msg)
    log("ответ отправлен →", to, "«", subject, "»")


# ---------- разбор письма ----------
def walk_parts(msg):
    text, files = "", []
    for part in msg.walk():
        cd = str(part.get("Content-Disposition") or "")
        ctype = part.get_content_type()
        if ctype.startswith("text/plain") and "attachment" not in cd:
            text += part.get_content() or ""
        elif part.get_filename() and ctype.startswith(("image/", "application/octet-stream")):
            files.append((part.get_filename(), part.get_payload(decode=True) or b""))
    return text, files


def clean_story(text: str) -> str:
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith(">")]
    body = "\n".join(lines)
    body = re.sub(r"выкладывай", "", body, flags=re.IGNORECASE)
    return re.sub(r"\n{3,}", "\n\n", body).strip()


def process(msg):
    msg_id = (msg.get("Message-ID") or "").strip()
    subj = str(msg.get("Subject") or "")
    frm = parseaddr(str(msg.get("From") or ""))[1].lower()
    refs = (msg.get("In-Reply-To") or msg.get("References") or "").strip()
    body, files = walk_parts(msg)
    st = load_state()

    # --- этап 2: ответ с «выкладывай» ---
    pending = st.get("pending")
    is_reply_to_card = bool(pending and pending.get("msg_id") and pending["msg_id"] in refs)
    if pending and (is_reply_to_card or subj.lower().startswith("re:")):
        if "выкладывай" not in body.lower():
            return  # ответ без «выкладывай» — директор ещё готовит правки
        story = clean_story(body) or pending.get("draft") or ""
        if news_set_text(pending["image"], story):
            reply(frm, "Re: " + subj, msg_id,
                  "✓ Готово! История выложена в ленту под карточкой.\nПосмотреть: http://127.0.0.1:8766/")
            log("история выложена в ленту:", pending["image"])
        else:
            reply(frm, "Re: " + subj, msg_id, "⚠️ Не нашёл карточку в ленте — пришлите карточку заново.")
        st["pending"] = None
        save_state(st)
        return

    # --- этап 1: новая карточка «мысль дня» ---
    if "мысль дня" not in subj.lower():
        return
    if not files:
        reply(frm, "Re: " + subj, msg_id,
              "В письме нет картинки. Пришлите карточку вложением (jpg/png) — размещу в ленте.")
        return

    fname, data = max(files, key=lambda f: len(f[1]))
    import hashlib
    card_hash = hashlib.sha1(data).hexdigest()
    if st.get("last_card_hash") == card_hash:
        reply(frm, "Re: " + subj, msg_id, "Эта карточка уже в ленте — дубль пропущен.")
        return
    image_web, image_file, sha = save_card(data)
    st["last_card_hash"] = sha
    save_state(st)
    news_add({"date": ru_today(), "title": "Мысль дня", "image": image_web})
    log("карточка в ленте:", image_web)

    draft = story_draft(image_file, VISION_KEY, VISION_MODEL, VISION_BASE)
    if draft:
        st["pending"] = {"msg_id": msg_id, "image": image_web, "draft": draft}
        save_state(st)
        reply(frm, "Re: " + subj, msg_id,
              "✓ Карточка размещена в ленте.\n\nЧерновик истории возникновения:\n\n" + draft +
              "\n\n— Если верно, ответьте на это письмо словом «выкладывай».\n"
              "— Если нужны правки, пришлите исправленный текст и слово «выкладывай».")
    else:
        st["pending"] = {"msg_id": msg_id, "image": image_web, "draft": ""}
        save_state(st)
        hint = ("\n\n⚠️ Автонаписание истории не работает: не задан VISION_API_KEY в bot/.env "
                "(ключ ИИ-провайдера, тот же, что для поиска по фото).") if not VISION_KEY else \
               ("\n\n⚠️ Не удалось написать историю автоматически — пришлите её текст "
                "в ответе со словом «выкладывай».")
        reply(frm, "Re: " + subj, msg_id,
              "✓ Карточка размещена в ленте." + hint +
              "\nВыложить историю можно ответом на это письмо: пришлите текст + слово «выкладывай».")


def main():
    if not SMTP_USER or not SMTP_PASS:
        sys.exit("Нет SMTP_USER/SMTP_PASS в .env")
    lenta_core.PUB.mkdir(parents=True, exist_ok=True)
    FOLDERS = ["INBOX", "&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-", "&BCEEPwQwBDw-"]
    # Яндекс сам переносит письма от ботов в «Рассылки»/«Спам» — смотрим все три папки
    log("старт: ящик", SMTP_USER, "| опрос каждые", IMAP_POLL, "с | история:",
        "GLM (" + VISION_MODEL + ")" if VISION_KEY else "нет ключа VISION_API_KEY")
    while True:
        try:
            st = load_state()
            done = set(st.get("done") or [])
            m = imaplib.IMAP4_SSL(IMAP_HOST, 993)
            m.login(SMTP_USER, SMTP_PASS)
            new_ids = []
            for folder in FOLDERS:
                m.select(folder)  # read-write: обработанные помечаем прочитанными
                typ, data = m.search(None, "ALL")
                for num in (data[0].split() if typ == "OK" else []):
                    typ, md = m.fetch(num, "(RFC822)")
                    if typ != "OK":
                        continue
                    raw = md[0][1]
                    try:
                        msg = email.message_from_bytes(raw, policy=email.policy.default)
                        msg_id = (msg.get("Message-ID") or "").strip()
                        if msg_id and msg_id in done:
                            continue  # уже обработано ранее
                        process(msg)
                        if msg_id:
                            done.add(msg_id)
                            new_ids.append(msg_id)
                    except Exception as e:
                        log("ошибка разбора письма:", type(e).__name__, str(e)[:150])
            if new_ids:
                st["done"] = list(done)[-300:]
                save_state(st)
            try:
                m.logout()
            except Exception:
                pass
        except Exception as e:
            log("почта недоступна:", type(e).__name__, str(e)[:150])
        time.sleep(IMAP_POLL)


if __name__ == "__main__":
    main()
