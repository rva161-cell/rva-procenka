#!/bin/bash
# Ежедневный отчёт RVA в 09:00 (rva-report.timer): пользователи, проценки за сутки,
# состояние и загруженность сервера — директору в MAX. Запускается от root.
set -u
MAX_USER="28098592"
TOKEN=$(grep -m1 '^MAX_TOKEN=' /opt/rva/bot/.env | cut -d= -f2- | tr -d '"')
LOG_TAG="rva-report"

psql_rva() { su - postgres -c "psql rva -tAc \"$1\"" 2>/dev/null | head -1; }

users_total=$(psql_rva "SELECT count(*) FROM users")
users_new=$(psql_rva "SELECT count(*) FROM users WHERE created >= (extract(epoch from now()) - 86400) * 1000")
proc_raw=$(psql_rva "SELECT value FROM settings WHERE key = 'procenka_days'")
read -r proc_yest proc_today proc_week < <(python3 - "$proc_raw" <<'EOF'
import json, sys, datetime
try:
    s = json.loads(sys.argv[1])
    d, c = s.get("d", []), s.get("c", [])
except Exception:
    d, c = [], []
y = (datetime.date.today() - datetime.timedelta(days=1)).isoformat()
t = datetime.date.today().isoformat()
cy = c[d.index(y)] if y in d else 0
ct = c[d.index(t)] if t in d else 0
week = sum(x for x in c[:7] if isinstance(x, (int, float)))
print(cy, ct, week)
EOF
)

load=$(cut -d' ' -f1 /proc/loadavg)
mem_used=$(free -m | awk '/^Mem:/{print $3}')
mem_total=$(free -m | awk '/^Mem:/{print $2}')
disk=$(df -h / | awk 'NR==2{print $5}')
serv_ok=""; serv_bad=""
for s in rva-procenka rva-max-bot rva-mail-api rva-mail-bot rva-stt; do
  if [ "$(systemctl is-active "$s" 2>/dev/null)" = "active" ]; then serv_ok="$serv_ok $s"; else serv_bad="$serv_bad $s"; fi
done
site=$(curl -so /dev/null -w '%{http_code}' --max-time 8 https://rva161.ru/)
backup=$(ls -t /opt/rva/procenka/backups 2>/dev/null | head -1)
backup_days=$(( ($(date +%s) - $(stat -c %Y "/opt/rva/procenka/backups/$backup" 2>/dev/null || date +%s)) / 86400 ))
wd_events=$(grep -c "$(date '+%d.%m')" /var/log/rva-watchdog.log 2>/dev/null || echo 0)
cert_exp=$(echo | openssl s_client -connect rva161.ru:443 -servername rva161.ru 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
cert_days=""
if [ -n "$cert_exp" ]; then
  cert_days=$(( ($(date -d "$cert_exp" +%s) - $(date +%s)) / 86400 ))
fi

text="🌅 Доброе утро! Отчёт RVA за сутки
👥 Пользователи: всего ${users_total:-?}, новых за сутки: ${users_new:-0}
🔍 Проценки: вчера ${proc_yest:-0}, сегодня уже ${proc_today:-0} (неделя: ${proc_week:-0})
🖥 Службы: всего 5, не в строю:${serv_bad:- none}
🌐 Сайт: HTTP ${site:-нет ответа}
💾 Память: ${mem_used:-?}/${mem_total:-?} МБ · диск: ${disk:-?} · нагрузка: ${load:-?}
🗄 Бэкап: ${backup:-нет} (${backup_days} дн. назад) · сторож: ${wd_events} записей за сутки
🔐 Сертификат HTTPS: осталось ${cert_days:-?} дней"

text_json=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$text")
if [ -n "$TOKEN" ]; then
  curl -s --max-time 15 -X POST "https://platform-api2.max.ru/messages?user_id=$MAX_USER" \
    -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
    -d "{\"text\": $text_json, \"notify\": true}" > /dev/null
fi
echo "$(date '+%d.%m %H:%M') отчёт отправлен: пользователи=$users_total, проценки вчера=$proc_yest" 
