#!/bin/bash
# Шаг 5 (на сервере). nginx + HTTPS (Let's Encrypt) + второй пароль на служебные разделы:
#   sudo bash /opt/rva/deploy/5_setup_nginx.sh ВАШ-ДОМЕН.ru ваша@почта.ru
# Перед запуском: в DNS домена запись A (и для www) указывает на IP сервера.
# Почта нужна Let's Encrypt для писем об окончании сертификата (продлевается автоматически).
set -euo pipefail
DOMAIN="${1:-}"; EMAIL="${2:-}"
[ -n "$DOMAIN" ] && [ -n "$EMAIL" ] || { echo "Использование: sudo bash $0 домен.ru почта@домен.ru"; exit 1; }
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== 1/5 Проверка DNS =="
IP="$(curl -s -4 https://ifconfig.me || hostname -I | awk '{print $1}')"
DNS="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}')"
echo "   IP сервера: $IP, $DOMAIN указывает на: ${DNS:-нет записи}"
[ "$DNS" = "$IP" ] || { echo "!! Запись A для $DOMAIN ещё не указывает на этот сервер. Исправьте DNS и подождите (до часа)"; exit 1; }
WWW=""; [ "$(getent ahostsv4 "www.$DOMAIN" | awk 'NR==1{print $1}')" = "$IP" ] && WWW="-d www.$DOMAIN"

echo "== 2/5 Временный конфиг и сертификат Let's Encrypt =="
install -d /var/www/certbot
rm -f /etc/nginx/sites-enabled/default
install -d /etc/nginx/snippets
install -m 644 "$HERE/nginx/rva-proxy.conf" "$HERE/nginx/rva-headers.conf" "$HERE/nginx/rva-admin-auth.conf" /etc/nginx/snippets/
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  sed "s/__DOMAIN__/$DOMAIN/g" "$HERE/nginx/rva-bootstrap.conf.template" > /etc/nginx/sites-available/rva.conf
  ln -sf /etc/nginx/sites-available/rva.conf /etc/nginx/sites-enabled/rva.conf
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" $WWW \
    --email "$EMAIL" --agree-tos --no-eff-email --non-interactive \
    --deploy-hook "systemctl reload nginx"
fi

echo "== 3/5 Второй пароль на служебные разделы (органайзер, админка, изменение поставщиков) =="
if [ ! -s /etc/nginx/rva.htpasswd ]; then
  read -r -p "   Имя для второго пароля (например, director): " U
  htpasswd -c -B /etc/nginx/rva.htpasswd "$U"
fi
chown root:www-data /etc/nginx/rva.htpasswd
chmod 640 /etc/nginx/rva.htpasswd

echo "== 4/5 Рабочий конфиг nginx =="
sed "s/__DOMAIN__/$DOMAIN/g" "$HERE/nginx/rva.conf.template" > /etc/nginx/sites-available/rva.conf
ln -sf /etc/nginx/sites-available/rva.conf /etc/nginx/sites-enabled/rva.conf
sed -i 's/^\s*#\?\s*server_tokens .*/\tserver_tokens off;/' /etc/nginx/nginx.conf || true
nginx -t
systemctl reload nginx
touch /var/log/nginx/rva.access.log /var/log/nginx/rva.error.log
systemctl restart fail2ban

echo "== 5/5 Проверка =="
curl -s -o /dev/null -w "   https://$DOMAIN/poisk — HTTP %{http_code}\n" "https://$DOMAIN/poisk" || true
curl -s -o /dev/null -w "   https://$DOMAIN/organizer без второго пароля — HTTP %{http_code} (должно быть 401)\n" "https://$DOMAIN/organizer" || true
curl -s -o /dev/null -w "   https://$DOMAIN/api/bot/user снаружи — HTTP %{http_code} (должно быть 404)\n" -X POST "https://$DOMAIN/api/bot/user" || true
systemctl list-timers certbot.timer --no-pager | sed -n 2p | sed 's/^/   продление сертификата: /'
echo
echo "Готово. Добавить второй пароль ещё одному человеку: sudo htpasswd -B /etc/nginx/rva.htpasswd имя"
echo "Дальше — шаг 6 (резервные копии):  bash /opt/rva/deploy/6_setup_backup.sh"
