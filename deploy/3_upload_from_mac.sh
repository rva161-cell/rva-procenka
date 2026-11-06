#!/bin/bash
# Шаг 3 (на Mac). Перенос программы на сервер по зашифрованному каналу SSH (rsync).
#
#   bash deploy/3_upload_from_mac.sh rva@IP --first   — ПЕРВЫЙ перенос: код + настройки с паролями
#                                                       (.env, suppliers.json, mailboxes.json…) +
#                                                       база data.db + лента + файлы органайзера
#   bash deploy/3_upload_from_mac.sh rva@IP           — ОБНОВЛЕНИЕ кода после правок на Mac:
#                                                       данные и настройки на сервере НЕ трогаются
#
# Не копируется никогда: окружения (venv, node_modules — создаются на сервере), скриншоты,
# корзина, архив, логи, профили браузера. Секреты идут только этим путём — не пересылайте их
# почтой, в мессенджерах и через облако.
set -euo pipefail
TARGET="${1:-}"; MODE="${2:-update}"
[ -n "$TARGET" ] || { echo "Укажите сервер: bash $0 rva@IP [--first]"; exit 1; }
cd "$(dirname "$0")/.."

ALWAYS=(--exclude '.DS_Store' --exclude '__pycache__/' --exclude '*.pyc'
        --exclude 'bot/venv/' --exclude 'procenka/node_modules/'
        --exclude 'Scrin/' --exclude 'корзина/' --exclude 'артикул_бот_old/' --exclude '_archive/'
        --exclude '*.log' --exclude 'procenka/browser_profiles/' --exclude 'procenka/backups/'
        --exclude 'procenka/*.json.migrated')
# рабочие данные и секреты, которые на сервере живут своей жизнью — при обновлении не трогаем
DATA=(--exclude 'procenka/.env' --exclude 'bot/.env' --exclude 'bot/config.json'
      --exclude 'procenka/suppliers.json' --exclude 'procenka/suppliers_users/' --exclude 'procenka/mailboxes.json'
      --exclude 'procenka/organizer_people.json' --exclude 'procenka/close_people.json'
      --exclude 'procenka/data.db' --exclude 'procenka/data.db-*' --exclude 'bot/data.db'
      --exclude 'procenka/news.json' --exclude 'procenka/lenta_state.json' --exclude 'bot/lenta_state.json'
      --exclude 'procenka/email_outbox.json' --exclude 'procenka/prices/' --exclude 'procenka/public/lenta/'
      --exclude 'Organizer/files/')

if [ "$MODE" = "--first" ]; then
  if lsof -tiTCP:8766 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "!! На Mac работает сервер проценки. Чтобы база скопировалась целой, сначала: ./stop.sh"; exit 1
  fi
  echo "== ПЕРВЫЙ перенос: код + настройки + данные → $TARGET:/opt/rva =="
  rsync -az --human-readable --stats "${ALWAYS[@]}" ./ "$TARGET:/opt/rva/"
  echo
  echo "Готово. Дальше на сервере (ssh $TARGET):  bash /opt/rva/deploy/4_install_app.sh ВАШ-ДОМЕН.ru"
else
  echo "== ОБНОВЛЕНИЕ кода → $TARGET:/opt/rva (данные и настройки на сервере не трогаются) =="
  rsync -az --human-readable --stats "${ALWAYS[@]}" "${DATA[@]}" ./ "$TARGET:/opt/rva/"
  echo
  echo "Готово. Перезапустить службы на сервере:  ssh $TARGET 'sudo systemctl restart rva-procenka rva-max-bot rva-tg-bot'"
  echo "(если менялись requirements.txt или package.json — снова bash /opt/rva/deploy/4_install_app.sh ВАШ-ДОМЕН.ru)"
fi
