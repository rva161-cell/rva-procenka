#!/bin/bash
# Шаг 4 (на сервере, под rva). Установить программу в /opt/rva и запустить службы:
#   bash /opt/rva/deploy/4_install_app.sh ВАШ-ДОМЕН.ru
# Повторный запуск безопасен (после обновления кода, requirements.txt, package.json).
set -euo pipefail
DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "Укажите домен: bash $0 rva161.ru"; exit 1; }
[ "$(id -un)" = rva ] || { echo "Запускайте под пользователем rva (ssh rva@IP)"; exit 1; }
APP=/opt/rva
[ -f "$APP/procenka/server.js" ] || { echo "Нет $APP/procenka — сначала шаг 3 (перенос с Mac)"; exit 1; }
cd "$APP"

echo "== 1/6 Python-окружение для ботов, голоса, почты, парсинга =="
[ -x bot/venv/bin/python ] || python3 -m venv bot/venv
bot/venv/bin/pip install -q --upgrade pip
bot/venv/bin/pip install -q -r bot/requirements.txt

echo "== 2/6 Node-пакеты сервера =="
(cd procenka && npm ci --omit=dev --no-audit --no-fund)

echo "== 3/6 Настройки под домен https://$DOMAIN =="
python3 - "$DOMAIN" <<'PY'
import re, secrets, sys
from pathlib import Path
dom = sys.argv[1]
first = not Path("/opt/rva/.installed").exists()
def set_env(path, key, val=None, drop=False):
    p = Path(path)
    lines = p.read_text(encoding="utf-8").splitlines() if p.exists() else []
    out, done = [], False
    for l in lines:
        if re.match(rf"^\s*{key}\s*=", l):
            if drop or done: continue
            out.append(f"{key}={val}"); done = True
        else:
            out.append(l)
    if not done and not drop: out.append(f"{key}={val}")
    p.write_text("\n".join(out) + "\n", encoding="utf-8")
pe, be = "/opt/rva/procenka/.env", "/opt/rva/bot/.env"
set_env(pe, "BASE_URL", f"https://{dom}")          # ссылки в письмах + Secure у cookie входа
set_env(pe, "TRUST_PROXY", "1")                     # реальный адрес клиента — от nginx (лимиты, fail2ban)
set_env(pe, "NODE_EXTRA_CA_CERTS", drop=True)       # путь с Mac; на сервере задаётся в службе systemd
set_env(pe, "HOST", drop=True)                      # только 127.0.0.1 (по умолчанию) — наружу через nginx
set_env(be, "SITE_URL", f"https://{dom}/")
set_env(be, "PROCENKA_PUBLIC_URL", f"https://{dom}/poisk")
if first:                                           # новый ключ бот-API на сервере (старый был на Mac)
    k = secrets.token_hex(24)
    set_env(pe, "BOT_API_KEY", k); set_env(be, "BOT_API_KEY", k)
    print("   новый BOT_API_KEY записан в procenka/.env и bot/.env")
Path("/opt/rva/.installed").write_text("ok\n")
print("   BASE_URL, TRUST_PROXY, SITE_URL, PROCENKA_PUBLIC_URL — готово")
PY

echo "== 4/6 Права: всё — только владельцу rva, секреты — 600 =="
chmod 700 "$APP"
chmod -R go-rwx "$APP"
for f in procenka/.env bot/.env bot/config.json procenka/suppliers.json procenka/mailboxes.json \
         procenka/organizer_people.json procenka/close_people.json procenka/data.db bot/data.db; do
  [ -e "$f" ] && chmod 600 "$f"
done
chmod +x deploy/*.sh

echo "== 5/6 Службы systemd =="
sudo install -m 644 deploy/systemd/rva-*.service deploy/systemd/rva-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
SERVICES="rva-procenka rva-stt rva-mail-bot rva-mail-api rva-max-bot rva-tg-bot"
sudo systemctl enable $SERVICES >/dev/null
sudo systemctl restart $SERVICES

echo "== 6/6 Проверка =="
sleep 6
for s in $SERVICES; do
  printf "   %-14s %s\n" "$s" "$(systemctl is-active $s)"
done
curl -s -o /dev/null -w "   сервер проценки на 127.0.0.1:8766 — HTTP %{http_code}\n" http://127.0.0.1:8766/poisk || true
echo
echo "Если служба не active — журнал: sudo journalctl -u ИМЯ -n 50 --no-pager"
echo "Дальше — шаг 5 (nginx + HTTPS + второй пароль):  sudo bash $APP/deploy/5_setup_nginx.sh $DOMAIN ваша@почта.ru"
