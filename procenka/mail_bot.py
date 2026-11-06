#!/usr/bin/env python3
"""Почтовый конвейер органайзера (О-2): письма клиентов → задачи + контакты + вложения.

Ящики перечислены в procenka/mailboxes.json (в git не попадает):
[
  {"имя": "рабочий info@", "imap_host": "imap.yandex.ru",
   "imap_user": "info@vredkin.ru", "imap_pass": "пароль приложения",
   "владелец": "admin"}
]
Владелец — логин из organizer_people.json (5-й уровень); задачи от его имени в его инбокс.

Правила (раздел 1 ТЗ):
  • только INBOX; спам и корзину не трогаем;
  • письмо → задача: тема/первые строки — заголовок, текст письма — описание, автор — контакт
    (авто-создание и склейка по email/телефону — только для писем из этих ящиков);
  • вложения сохраняются в Organizer/files/ГГГГ-ММ/ и прикрепляются к задаче;
  • отметка «прочитано» — только после успешного создания задачи (сбой — письмо остаётся).
Запуск: ../bot/venv/bin/python mail_bot.py   (лог — stdout)
"""
import email
import email.policy
import imaplib
import json
import re
import sqlite3
import sys
import time
from datetime import datetime
from email.header import decode_header, make_header
from email.utils import parseaddr
from pathlib import Path

ROOT = Path(__file__).resolve().parent            # procenka/
DB_FILE = ROOT / "data.db"
ORG_FILES = ROOT.parent / "Organizer" / "files"
MAILBOXES = ROOT / "mailboxes.json"
POLL = 90                                          # секунды между опросами
log = lambda *a: print(datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def subj_text(raw) -> str:
    try:
        return str(make_header(decode_header(raw or "")))
    except Exception:
        return str(raw or "")


def walk_parts(msg):
    """(текст письма, [(имя файла, байты)]) — plain-text + любые вложения."""
    text, files = "", []
    for part in msg.walk():
        cd = str(part.get("Content-Disposition") or "")
        ctype = part.get_content_type()
        fn = part.get_filename()
        if ctype.startswith("text/plain") and "attachment" not in cd and not fn:
            try:
                text += part.get_content() or ""
            except Exception:
                pass
        elif fn:
            files.append((subj_text(fn), part.get_payload(decode=True) or b""))
    return text.strip(), files


def norm_phone(s):
    d = re.sub(r"\D", "", str(s or ""))
    if len(d) == 11 and d[0] == "8":
        d = "7" + d[1:]
    if len(d) == 10:
        d = "7" + d
    return d if len(d) == 11 and d[0] == "7" else (d or "")


def db_connect():
    con = sqlite3.connect(DB_FILE, timeout=10)
    con.execute("PRAGMA busy_timeout = 5000")
    return con


def save_file(rel_month, name, data):
    """Файл → Organizer/files/ГГГГ-ММ/…, возвращает относительный путь."""
    safe = re.sub(r'[\\/:*?"<>|\r\n]', "_", str(name or "файл")).strip()[:120] or "файл"
    d = ORG_FILES / rel_month
    d.mkdir(parents=True, exist_ok=True)
    stored = f"{rel_month}/{int(time.time()*1000)}_{int.from_bytes(__import__('os').urandom(3), 'big'):06x}_{safe}"
    (ORG_FILES / stored).write_bytes(data)
    return stored


def contact_upsert(con, name, email, phone):
    """Контакт по email/телефону (или новый) + склейка с пользователем сайта."""
    cur = con.execute(
        "SELECT id, name FROM o_contacts WHERE (email = ? AND email <> '') OR (phone = ? AND phone <> '') LIMIT 1",
        (email.lower(), phone))
    row = cur.fetchone()
    now = datetime.now().isoformat()
    if row:
        cid = row[0]
        if name and not row[1]:
            con.execute("UPDATE o_contacts SET name = ? WHERE id = ?", (name, cid))
        return cid
    login = ""
    u = con.execute("SELECT login, max_id, telegram_id, phone FROM users WHERE lower(email) = ? OR (phone <> '' AND phone = ?) LIMIT 1",
                    (email.lower(), phone)).fetchone() if (email or phone) else None
    if u:
        login, max_id, tg_id, uphone = u[0], u[1] or "", u[2] or "", u[3] or ""
    else:
        max_id = tg_id = uphone = ""
    cur = con.execute(
        "INSERT INTO o_contacts (name, email, phone, login, max_id, telegram_id, created_at) VALUES (?,?,?,?,?,?,?)",
        (name, email.lower(), phone, login, max_id, tg_id, now))
    return cur.lastrowid


def handle_letter(con, mbox, msg):
    """Письмо → задача + контакт + вложения. Возвращает краткое описание для лога."""
    sender_name, sender_addr = parseaddr(msg.get("From") or "")
    subject = subj_text(msg.get("Subject") or "").strip() or "(без темы)"
    body, files = walk_parts(msg)
    phone = ""  # телефон ищем в тексте письма (подпись «телефон: …»)
    m = re.search(r"(?:телефон|тел\.?|tel)[:\s]*([+]?\d[\d\s\-()]{9,})", body or "", re.I)
    if m:
        phone = norm_phone(m.group(1))
    now = datetime.now().isoformat()
    cid = contact_upsert(con, sender_name, sender_addr, phone)
    title = subject if len(subject) <= 80 else subject[:77] + "…"
    cur = con.execute(
        "INSERT INTO o_tasks (title, body, source, contact, contact_id, due_date, due_time, created_at)"
        " VALUES (?,?,?,?,?,? ,NULL,?)",
        (title, (body or "")[:20000], "mail:" + mbox["imap_user"], sender_addr or sender_name, cid, today(), now))
    task_id = cur.lastrowid
    rel_month = today()[:7]
    for fname, data in files[:10]:
        if not data:
            continue
        stored = save_file(rel_month, fname, data)
        ext = Path(stored).suffix.lower()
        kind = "image" if ext in (".jpg", ".jpeg", ".png", ".webp") else "pdf" if ext == ".pdf" else "txt" if ext == ".txt" else "doc"
        con.execute(
            "INSERT INTO o_files (owner, task_id, name, stored, kind, size, created_at) VALUES (?,?,?,?,?,?,?)",
            (mbox.get("владелец") or "", task_id, fname, stored, kind, len(data), now))
    con.commit()
    con.execute("INSERT INTO o_audit (ts, actor, action, task_id, details) VALUES (?,?,?,?,?)",
                (now, "почта " + mbox["imap_user"], "создана", task_id,
                 f"от {sender_addr or '?'}: {subject[:60]}"))
    con.commit()
    return f"{sender_addr or '?'} → задача #{task_id} «{subject[:40]}» (+{len(files)} влож.)"


def poll_box(con, mbox):
    """Один проход по INBOX ящика. Непрочитанные → задачи, потом \Seen."""
    host = mbox.get("imap_host") or "imap.yandex.ru"
    user, pwd = mbox.get("imap_user"), mbox.get("imap_pass")
    if not user or not pwd:
        return
    im = imaplib.IMAP4_SSL(host, 993)
    try:
        im.login(user, pwd)
        im.select("INBOX")
        typ, data = im.search(None, "UNSEEN")
        ids = (data[0] or b"").split() if typ == "OK" else []
        if ids:
            log(f"[{user}] новых писем: {len(ids)}")
        for num in ids:
            typ2, md = im.fetch(num, "(RFC822)")
            if typ2 != "OK":
                continue
            msg = email.message_from_bytes(md[0][1], policy=email.policy.default)
            try:
                info = handle_letter(con, mbox, msg)
                im.store(num, "+FLAGS", "\\Seen")
                log("письмо →", info)
            except Exception as e:
                log(f"ОШИБКА письма {num.decode()}: {type(e).__name__}: {e} — письмо остаётся непрочитанным")
    finally:
        try:
            im.logout()
        except Exception:
            pass


def main():
    log("почтовый конвейер органайзера запущен")
    while True:
        try:
            boxes = json.loads(MAILBOXES.read_text(encoding="utf-8")) if MAILBOXES.exists() else []
            if not boxes:
                log("нет ящиков — заполните procenka/mailboxes.json (см. mailboxes.json.example); ждём")
            con = db_connect()
            try:
                for mbox in boxes:
                    try:
                        poll_box(con, mbox)
                    except Exception as e:
                        log(f"[{mbox.get('imap_user')}] {type(e).__name__}: {e}")
            finally:
                con.close()
        except Exception as e:
            log(f"цикл: {type(e).__name__}: {e}")
        time.sleep(POLL)


if __name__ == "__main__":
    main()
