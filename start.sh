#!/bin/bash
# Запуск всех сервисов RVA одним пакетом — после перезагрузки Mac или просто так.
# Повторный запуск безопасен: старые процессы останавливаются, затем стартуют заново.
# Остановить всё: ./stop.sh
cd "$(dirname "$0")"
export NODE_EXTRA_CA_CERTS="$PWD/bot/venv/lib/python3.11/site-packages/certifi/cacert.pem"
LOGS="$PWD/logs"          # все журналы — в папке logs/ (в .gitignore уже закрыты *.log)
mkdir -p "$LOGS"

echo "== Останавливаю старые процессы =="
kill $(lsof -tiTCP:8766 -sTCP:LISTEN) 2>/dev/null
pkill -f "stt_server.py" 2>/dev/null
pkill -f "mail_bot.py" 2>/dev/null
pkill -f "mail_api.py" 2>/dev/null
pkill -f "max_bot.py" 2>/dev/null
pkill -f "bot/bot.py" 2>/dev/null
sleep 2

echo "== Запускаю =="
(cd procenka && nohup node server.js >> "$LOGS/server.log" 2>&1 &)            # сервер: сайт, проценка, органайзер
(cd procenka && nohup ../bot/venv/bin/python -u stt_server.py >> "$LOGS/stt.log" 2>&1 &)      # голос (whisper)
(cd procenka && nohup ../bot/venv/bin/python -u mail_bot.py >> "$LOGS/mail.log" 2>&1 &)       # письма → задачи
(cd procenka && nohup ../bot/venv/bin/python -u mail_api.py >> "$LOGS/mail_api.log" 2>&1 &)   # почта в органайзере
(cd bot && nohup venv/bin/python -u max_bot.py >> "$LOGS/max-run.log" 2>&1 &)    # бот MAX
(cd bot && nohup venv/bin/python -u bot.py >> "$LOGS/tg-run.log" 2>&1 &)         # бот Telegram

sleep 6
echo "== Проверка =="
lsof -tiTCP:8766 >/dev/null 2>&1 && echo "✓ сервер проценки (8766)" || echo "✗ сервер НЕ запустился — logs/server.log"
curl -s -m 3 http://127.0.0.1:8767/ping >/dev/null 2>&1 && echo "✓ голос-whisper (8767)" || echo "… whisper грузит модель (до минуты): logs/stt.log"
pgrep -f mail_bot.py >/dev/null && echo "✓ почтовый конвейер (письма → задачи)" || echo "✗ почтовый конвейер"
pgrep -f mail_api.py >/dev/null && echo "✓ почтовый API (8768)" || echo "✗ почтовый API"
pgrep -f max_bot.py >/dev/null && echo "✓ бот MAX" || echo "✗ бот MAX"
pgrep -f "bot/bot.py" >/dev/null && echo "✓ бот Telegram (если VPN включён)" || echo "… бот Telegram не запустился (без VPN — норма)"
echo "Готово. Журналы: logs/ (server, stt, mail, mail_api, max-run, tg-run)"
