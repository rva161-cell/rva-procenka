#!/bin/bash
# Шаг 6 (на сервере, под rva). Ночные зашифрованные копии на Яндекс.Диск:
#   bash /opt/rva/deploy/6_setup_backup.sh
# Создаёт пароль шифрования (/opt/rva/.backup_pass), включает таймер (каждую ночь в 03:30)
# и сразу делает первую копию для проверки.
set -euo pipefail
[ "$(id -un)" = rva ] || { echo "Запускайте под пользователем rva"; exit 1; }
command -v gpg >/dev/null || sudo apt-get -y -q install gnupg
PASS=/opt/rva/.backup_pass
if [ ! -s "$PASS" ]; then
  umask 077
  python3 -c "import secrets; print(secrets.token_urlsafe(24))" > "$PASS"
  chmod 600 "$PASS"
  echo "=========================================================================="
  echo " ПАРОЛЬ ШИФРОВАНИЯ КОПИЙ (сохраните в менеджер паролей — без него копию"
  echo " не расшифровать, если сервер пропадёт):"
  echo
  echo "     $(cat "$PASS")"
  echo "=========================================================================="
  read -r -p "Сохранили пароль? Нажмите Enter… " _
fi
sudo install -m 644 /opt/rva/deploy/systemd/rva-backup.service /opt/rva/deploy/systemd/rva-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now rva-backup.timer
echo "== Первая копия (до пары минут) =="
sudo systemctl start rva-backup
journalctl -u rva-backup -n 5 --no-pager
systemctl list-timers rva-backup.timer --no-pager | sed -n 2p | sed 's/^/следующая копия: /'
