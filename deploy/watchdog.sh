#!/bin/bash
# Сторож RVA: раз в минуту проверяет службы RVA; упавшую перезапускает и
# рапортует директору в MAX. Сообщение — только при СМЕНЕ состояния (анти-спам).
# Запускается от root через rva-watchdog.service + rva-watchdog.timer.
set -u
SERVICES="rva-procenka rva-max-bot rva-mail-api rva-mail-bot rva-stt"
MAX_USER="28098592"                      # директор
STATE_DIR="/var/lib/rva-watchdog"
LOG="/var/log/rva-watchdog.log"
mkdir -p "$STATE_DIR"; touch "$LOG"
TOKEN=$(grep -m1 '^MAX_TOKEN=' /opt/rva/bot/.env | cut -d= -f2- | tr -d '"' )

say() {  # сообщение директору в MAX (тот же вызов, что у server.js)
  local text; text=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1")
  if [ -n "$TOKEN" ]; then
    curl -s --max-time 15 -X POST "https://platform-api2.max.ru/messages?user_id=$MAX_USER" \
      -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
      -d "{\"text\": $text, \"notify\": true}" > /dev/null 2>&1
  fi
  echo "$(date '+%d.%m %H:%M') ОТПРАВЛЕНО: $1" >> "$LOG"
}

for s in $SERVICES; do
  f="$STATE_DIR/$s"
  if [ "$(systemctl is-active "$s" 2>/dev/null)" != "active" ]; then
    echo "$(date '+%d.%m %H:%M') $s: $(systemctl is-active "$s" 2>/dev/null) — перезапускаю" >> "$LOG"
    systemctl restart "$s"
    sleep 6
    if [ "$(systemctl is-active "$s" 2>/dev/null)" = "active" ]; then
      if [ "$(cat "$f" 2>/dev/null)" = "down" ]; then
        say "✅ Сторож: $s снова работает (был недоступен)."
      else
        say "🔧 Сторож: $s был неактивен — перезапустил, сейчас работает."
      fi
      echo ok > "$f"
    else
      if [ "$(cat "$f" 2>/dev/null)" != "down" ]; then
        say "⚠️ Сторож: $s упал и НЕ поднялся после рестарта. Нужна проверка: кнопка «🖥 VPS» в боте или панель Timeweb."
        echo down > "$f"
      fi
      echo "$(date '+%d.%m %H:%M') $s: не поднялся" >> "$LOG"
    fi
  else
    if [ "$(cat "$f" 2>/dev/null)" = "down" ]; then
      say "✅ Сторож: $s снова работает."
      echo ok > "$f"
    fi
    [ "$(cat "$f" 2>/dev/null)" != "ok" ] && echo ok > "$f"
  fi
done
