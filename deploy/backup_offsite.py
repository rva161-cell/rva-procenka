#!/usr/bin/env python3
"""Зашифрованная резервная копия RVA на Яндекс.Диск — запускается каждую ночь (rva-backup.timer).

Что в копии: снимок базы procenka/data.db (согласованный, без остановки программы), настройки
с паролями (.env, suppliers.json, mailboxes.json, списки доступа), лента, прайс-листы, файлы
органайзера. Архив шифруется паролем (gpg, AES-256) ДО отправки — на Яндекс.Диске лежит только
зашифрованный файл. Пароль — /opt/rva/.backup_pass (создаёт 6_setup_backup.sh); его же
храните у себя в менеджере паролей: без него копию не расшифровать.

Куда: папка BACKUP_YADISK_DIR (по умолчанию /RVA-backups) на Диске с токеном YADISK_TOKEN из
procenka/.env (тот же, что у органайзера). Хранятся последние BACKUP_KEEP копий (по умолчанию 30).
Проверка вручную:  sudo systemctl start rva-backup && journalctl -u rva-backup -n 30 --no-pager
"""
import datetime
import json
import os
import re
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

APP = Path(os.environ.get("RVA_APP") or "/opt/rva")   # для проверки на другом компьютере — RVA_APP=папка
PASS_FILE = Path(os.environ.get("RVA_BACKUP_PASS") or APP / ".backup_pass")
INCLUDE = [  # что копируем (если есть)
    "procenka/.env", "bot/.env", "bot/config.json", "procenka/suppliers.json", "procenka/mailboxes.json",
    "procenka/organizer_people.json", "procenka/close_people.json", "procenka/news.json",
    "procenka/lenta_state.json", "bot/lenta_state.json", "bot/data.db",
    "procenka/public/lenta", "procenka/prices", "Organizer/files",
]
API = "https://cloud-api.yandex.net/v1/disk"


def env(path: Path) -> dict:
    out = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
            if m and not line.lstrip().startswith("#"):
                out[m.group(1)] = m.group(2).strip("\"'")
    return out


def ya(method: str, url: str, token: str, data: bytes | None = None, ok=(200, 201, 202, 204)):
    req = urllib.request.Request(url, data=data, method=method, headers={"Authorization": "OAuth " + token})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            body = r.read()
            return r.status, (json.loads(body) if body and body[:1] in b"{[" else None)
    except urllib.error.HTTPError as e:
        if e.code in ok:
            return e.code, None
        raise RuntimeError(f"Яндекс.Диск: {method} {url.split('?')[0]} → HTTP {e.code} {e.read()[:200]!r}")


def main():
    cfg = env(APP / "procenka/.env")
    token = cfg.get("YADISK_TOKEN", "")
    folder = "disk:" + (cfg.get("BACKUP_YADISK_DIR") or "/RVA-backups").rstrip("/")
    keep = int(cfg.get("BACKUP_KEEP") or 30)
    if not token:
        sys.exit("нет YADISK_TOKEN в procenka/.env — копию на Диск отправить некуда")
    if not PASS_FILE.exists():
        sys.exit("нет пароля шифрования /opt/rva/.backup_pass — запустите deploy/6_setup_backup.sh")
    stamp = datetime.datetime.now().strftime("%Y-%m-%d_%H%M")
    name = f"rva-{stamp}.tar.gz.gpg"

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        snap = tmp / "data.db"                                   # согласованный снимок базы
        src = sqlite3.connect(APP / "procenka/data.db")
        dst = sqlite3.connect(snap)
        src.backup(dst); dst.close(); src.close()
        tar_path = tmp / "rva.tar.gz"
        with tarfile.open(tar_path, "w:gz") as t:
            t.add(snap, arcname="procenka/data.db")
            for rel in INCLUDE:
                p = APP / rel
                if p.exists():
                    t.add(p, arcname=rel)
        enc = tmp / name
        subprocess.run(["gpg", "--batch", "--yes", "--quiet", "--pinentry-mode", "loopback",
                        "--passphrase-file", str(PASS_FILE), "--symmetric", "--cipher-algo", "AES256",
                        "-o", str(enc), str(tar_path)], check=True)
        size = enc.stat().st_size

        ya("PUT", f"{API}/resources?path={urllib.parse.quote(folder)}", token, ok=(201, 409))   # папка (409 — уже есть)
        _, up = ya("GET", f"{API}/resources/upload?path={urllib.parse.quote(folder + '/' + name)}&overwrite=true", token)
        req = urllib.request.Request(up["href"], data=enc.read_bytes(), method="PUT")
        with urllib.request.urlopen(req, timeout=1800) as r:
            if r.status not in (201, 202):
                raise RuntimeError(f"загрузка на Диск: HTTP {r.status}")
    print(f"копия {name} ({size / 1048576:.1f} МБ) отправлена в {folder}")

    # хранить последние keep копий
    _, lst = ya("GET", f"{API}/resources?path={urllib.parse.quote(folder)}&limit=1000&sort=-created", token)
    items = [i for i in ((lst or {}).get("_embedded") or {}).get("items", []) if i["name"].startswith("rva-")]
    for old in items[keep:]:
        ya("DELETE", f"{API}/resources?path={urllib.parse.quote(old['path'])}&permanently=true", token)
        print("удалена старая копия", old["name"])


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ОШИБКА резервной копии:", e, file=sys.stderr)
        sys.exit(1)
