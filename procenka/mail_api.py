#!/usr/bin/env python3
"""Почтовый сервис органайзера (вариант 2): чтение и разбор почты по IMAP.

orgанайзер (Node) пробрасывает сюда /api/organizer/mail/* — этот сервис общается
с ящиками напрямую (imaplib/smtplib) и отвечает JSON. Слушает только 127.0.0.1.
Ящики — procenka/mailboxes.json; пользователь видит только ящики со своим «владелец».

Запуск: ../bot/venv/bin/python mail_api.py   (порт MAIL_API_PORT, по умолчанию 8768)
"""
import email
import email.policy
import imaplib
import json
import re
import sqlite3
import sys
import time
import urllib.parse
from datetime import datetime
from email.header import decode_header, make_header
from email.utils import parseaddr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
MAILBOXES = ROOT / "mailboxes.json"
PORT = int(__import__("os").environ.get("MAIL_API_PORT") or 8768)

log = lambda *a: print(time.strftime("%H:%M:%S"), *a, flush=True)
SPAM_RAW = "&BCEEPwQwBDw-"      # «Спам» в Яндексе (modified UTF-7)
TRASH_RAW = "&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"   # «Корзина»


def boxes_for(actor: str) -> list:
    """Ящики, принадлежащие пользователю (владелец = его логин)."""
    try:
        boxes = json.loads(MAILBOXES.read_text(encoding="utf-8"))
    except Exception:
        return []
    return [(i, b) for i, b in enumerate(boxes) if b.get("владелец") == actor]


def connect(box: dict, readonly: bool = False):
    im = imaplib.IMAP4_SSL(box.get("imap_host") or "imap.yandex.ru", 993)
    im.login(box["imap_user"], box["imap_pass"])
    im.select("INBOX", readonly)
    return im


def subj(raw) -> str:
    try:
        return str(make_header(decode_header(raw or "")))
    except Exception:
        return str(raw or "")


def walk(msg):
    """(текст, [{n, name, size}]) — как в mail_bot, но без выгрузки содержимого."""
    text, atts, n = "", [], 0
    for part in msg.walk():
        cd = str(part.get("Content-Disposition") or "")
        fn = part.get_filename()
        if part.get_content_type().startswith("text/plain") and "attachment" not in cd and not fn:
            try:
                text += part.get_content() or ""
            except Exception:
                pass
        elif fn:
            n += 1
            payload = part.get_payload(decode=True) or b""
            atts.append({"n": n, "name": subj(fn), "size": len(payload)})
    return text.strip(), atts


def parse_from(raw) -> str:
    name, addr = parseaddr(subj(raw))
    return f"{name} <{addr}>" if name else addr


def fetch_letter(con, box, uid, full: bool):
    """Письмо по UID: заголовки (+текст и вложения, если full)."""
    what = "(BODY.PEEK[] FLAGS)" if full else "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)] FLAGS)"
    typ, data = con.uid("fetch", uid, what)
    if typ != "OK" or not data or not data[0]:
        return None
    seen = "\\Seen" in str(data)   # флаг может лежать в разных частях ответа IMAP
    msg = email.message_from_bytes(data[0][1], policy=email.policy.default)
    out = {
        "uid": uid.decode(),
        "from": parse_from(msg.get("From")),
        "to": parse_from(msg.get("To")),
        "subject": subj(msg.get("Subject") or "").strip() or "(без темы)",
        "date": str(msg.get("Date") or ""),
        "seen": seen,
    }
    if full:
        text, atts = walk(msg)
        out["text"], out["attachments"] = text, atts
        out["message_id"] = str(msg.get("Message-ID") or "")
        out["raw_text"] = text
    return out


def smtp_of(box: dict):
    """SMTP-параметры ящика: imap.хост → smtp.хост:465 (SSL), те же учётные данные."""
    host = (box.get("imap_host") or "imap.yandex.ru").replace("imap.", "smtp.", 1)
    return host, 465, box["imap_user"], box["imap_pass"]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}") if length else {}

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        actor = q.get("actor", "")
        try:
            if u.path == "/ping":
                return self._json(200, {"ok": True})
            own = boxes_for(actor)
            if u.path == "/boxes":
                return self._json(200, {"boxes": [{"index": i, "name": b.get("имя") or b.get("imap_user"),
                                                   "user": b.get("imap_user")} for i, b in own]})
            bi = next((i for i, b in own if str(i) == str(q.get("box"))), None)
            if bi is None:
                return self._json(404, {"error": "Ящик не найден или не ваш"})
            box = own[bi][1]
            con = connect(box, readonly=True)
            try:
                if u.path == "/list":
                    limit = min(int(q.get("limit") or 50), 100)
                    typ, data = con.uid("search", None, "ALL")
                    all_uids = (data[0] or b"").split()[::-1][:200]
                    only_unread = q.get("unread") == "1"
                    typ, udata = con.uid("search", None, "UNSEEN")   # сервер сам знает непрочитанные
                    unseen = {u for u in (udata[0] or b"").split()}
                    uids = [u for u in all_uids if (not only_unread or u in unseen)][:limit]
                    out = []
                    if uids:
                        typ, hdata = con.uid("fetch", b",".join(uids),
                                             "(BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])")
                        for part in hdata:
                            if not isinstance(part, tuple) or not part[1]:
                                continue
                            mu = re.search(rb"UID (\d+)", part[0])
                            if not mu:
                                continue
                            msg = email.message_from_bytes(part[1], policy=email.policy.default)
                            out.append({
                                "uid": mu.group(1).decode(),
                                "from": parse_from(msg.get("From")),
                                "to": parse_from(msg.get("To")),
                                "subject": subj(msg.get("Subject") or "").strip() or "(без темы)",
                                "date": str(msg.get("Date") or ""),
                                "seen": mu.group(1) not in unseen,
                            })
                    return self._json(200, {"letters": out})
                if u.path == "/letter":
                    letter = fetch_letter(con, box, q.get("uid", "").encode(), full=True)
                    if not letter:
                        return self._json(404, {"error": "Письмо не найдено"})
                    return self._json(200, {"letter": letter})
                if u.path == "/att":  # скачать вложение по номеру
                    typ, data = con.uid("fetch", q.get("uid", "").encode(), "(BODY.PEEK[])")
                    if typ != "OK" or not data or not data[0]:
                        return self._json(404, {"error": "Письмо не найдено"})
                    msg = email.message_from_bytes(data[0][1], policy=email.policy.default)
                    n = 0
                    for part in msg.walk():
                        fn = part.get_filename()
                        if not fn:
                            continue
                        n += 1
                        if n == int(q.get("n") or 0):
                            payload = part.get_payload(decode=True) or b""
                            fname = subj(fn)
                            self.send_response(200)
                            self.send_header("Content-Type", "application/octet-stream")
                            self.send_header("Content-Disposition",
                                             f"attachment; filename*=UTF-8''{urllib.parse.quote(fname)}")
                            self.send_header("Content-Length", str(len(payload)))
                            self.end_headers()
                            self.wfile.write(payload)
                            return
                    return self._json(404, {"error": "Вложение не найдено"})
            finally:
                try:
                    con.logout()
                except Exception:
                    pass
            return self._json(404, {"error": "Нет такого запроса"})
        except imaplib.IMAP4.error as e:
            return self._json(502, {"error": f"Яндекс не принял вход: {e}"})
        except Exception as e:
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})

    def _is_unread(self, con, uid) -> bool:
        typ, data = con.uid("fetch", uid, "(FLAGS)")
        return "\\Seen" not in str(data)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        b = self._body()
        q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
        actor = b.get("actor") or q.get("actor", "")   # Node передаёт актёра в query
        try:
            if u.path == "/addbox":  # добавить свой ящик (с проверкой входа)
                for f in ("imap_host", "imap_user", "imap_pass"):
                    if not b.get(f):
                        return self._json(400, {"error": f"Заполните {f}"})
                try:
                    im = imaplib.IMAP4_SSL(b["imap_host"], 993)
                    im.login(b["imap_user"], b["imap_pass"])
                    im.logout()
                except Exception as e:
                    return self._json(400, {"error": f"Ящик не открылся: {e}"})
                boxes = json.loads(MAILBOXES.read_text(encoding="utf-8")) if MAILBOXES.exists() else []
                if any(x.get("imap_user") == b["imap_user"] for x in boxes):
                    return self._json(409, {"error": "Такой ящик уже добавлен"})
                boxes.append({"имя": b.get("имя") or b["imap_user"], "imap_host": b["imap_host"],
                              "imap_user": b["imap_user"], "imap_pass": b["imap_pass"],
                              "владелец": actor})
                MAILBOXES.write_text(json.dumps(boxes, ensure_ascii=False, indent=2), encoding="utf-8")
                return self._json(200, {"ok": True})
            own = boxes_for(actor)
            bi = next((i for i, bx in own if str(i) == str(b.get("box"))), None)
            if bi is None:
                return self._json(404, {"error": "Ящик не найден или не ваш"})
            box = own[bi][1]
            uid = str(b.get("uid", "")).encode()

            if u.path == "/action":
                act = b.get("action")
                con = connect(box)
                try:
                    if act == "seen":
                        con.uid("store", uid, "+FLAGS", "(\\Seen)")
                    elif act == "unseen":
                        con.uid("store", uid, "-FLAGS", "(\\Seen)")
                    elif act == "delete":
                        con.uid("copy", uid, TRASH_RAW)
                        con.uid("store", uid, "+FLAGS", "(\\Deleted)")
                        con.expunge()
                    elif act == "spam":
                        con.uid("copy", uid, SPAM_RAW)
                        con.uid("store", uid, "+FLAGS", "(\\Deleted)")
                        con.expunge()
                    else:
                        return self._json(400, {"error": "Неизвестное действие"})
                    return self._json(200, {"ok": True})
                finally:
                    try:
                        con.logout()
                    except Exception:
                        pass

            if u.path == "/reply":
                con = connect(box, readonly=True)
                try:
                    letter = fetch_letter(con, box, uid, full=True)
                finally:
                    try:
                        con.logout()
                    except Exception:
                        pass
                if not letter:
                    return self._json(404, {"error": "Письмо не найдено"})
                addr = parseaddr(letter["from"])[1]
                if not addr:
                    return self._json(400, {"error": "У письма нет адреса для ответа"})
                host, port, user, pwd = smtp_of(box)
                import smtplib
                from email.message import EmailMessage
                m = EmailMessage()
                m["From"] = user
                m["To"] = addr
                m["Subject"] = "Re: " + letter["subject"].replace("Re: ", "")
                if letter.get("message_id"):
                    m["In-Reply-To"] = letter["message_id"]
                quoted = "\n".join("> " + line for line in (letter.get("text") or "").splitlines()[:15])
                m.set_content((b.get("text") or "").strip() + "\n\n" + quoted + "\n")
                s = smtplib.SMTP_SSL(host, port, timeout=20)
                s.login(user, pwd)
                s.send_message(m)
                s.quit()
                return self._json(200, {"ok": True, "to": addr})

            if u.path == "/totask":  # письмо → задача органайзера (логика mail_bot)
                con = connect(box, readonly=True)
                try:
                    typ, data = con.uid("fetch", uid, "(BODY.PEEK[])")
                finally:
                    try:
                        con.logout()
                    except Exception:
                        pass
                if typ != "OK" or not data or not data[0]:
                    return self._json(404, {"error": "Письмо не найдено"})
                msg = email.message_from_bytes(data[0][1], policy=email.policy.default)
                spec = importlib_spec("mail_bot")
                con2 = spec.db_connect()
                try:
                    info = spec.handle_letter(con2, box, msg)
                finally:
                    con2.close()
                return self._json(200, {"ok": True, "info": info})
            return self._json(404, {"error": "Нет такого запроса"})
        except imaplib.IMAP4.error as e:
            return self._json(502, {"error": f"Яндекс не принял: {e}"})
        except Exception as e:
            return self._json(500, {"error": f"{type(e).__name__}: {e}"})


def importlib_spec(name):
    import importlib.util
    spec = importlib.util.spec_from_file_location(name, str(ROOT / f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


if __name__ == "__main__":
    log(f"почтовый API: http://127.0.0.1:{PORT} (ящики из mailboxes.json)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
