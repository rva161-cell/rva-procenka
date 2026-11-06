#!/bin/bash
# Остановить все сервисы RVA (данные не теряются: база пишется сразу, письма помечаются на месте).
cd "$(dirname "$0")"
kill $(lsof -tiTCP:8766 -sTCP:LISTEN) 2>/dev/null
pkill -f "stt_server.py" 2>/dev/null
pkill -f "mail_bot.py" 2>/dev/null
pkill -f "mail_api.py" 2>/dev/null
pkill -f "max_bot.py" 2>/dev/null
pkill -f "bot/bot.py" 2>/dev/null
echo "Все сервисы остановлены. Запуск: ./start.sh"
