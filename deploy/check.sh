#!/bin/bash
# Проверка безопасности сервера RVA одной командой (после установки и раз в месяц):
#   sudo bash /opt/rva/deploy/check.sh ВАШ-ДОМЕН.ru
# ✓ — в порядке, ✗ — исправить (подсказка рядом).
DOMAIN="${1:-}"
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
ok()  { printf "  ✓ %s\n" "$1"; }
bad() { printf "  ✗ %s\n      → %s\n" "$1" "$2"; FAIL=1; }
FAIL=0

echo "== Вход на сервер (SSH) =="
T="$(sshd -T 2>/dev/null)"
grep -q '^passwordauthentication no' <<<"$T" && ok "вход по паролю выключен" || bad "вход по паролю включён" "sudo bash /opt/rva/deploy/2_lock_ssh.sh"
grep -q '^permitrootlogin no' <<<"$T" && ok "вход под root запрещён" || bad "вход под root разрешён" "sudo bash /opt/rva/deploy/2_lock_ssh.sh"

echo "== Сеть =="
ufw status | grep -q 'Status: active' && ok "брандмауэр включён" || bad "брандмауэр выключен" "sudo ufw enable"
OPEN="$(ss -ltnH | awk '{print $4}' | grep -vE '^(127\.[0-9.]+|\[::1\])(:|%)' | sed -E 's/.*:([0-9]+)$/\1/' | sort -un | tr '\n' ' ')"
EXTRA="$(tr ' ' '\n' <<<"$OPEN" | grep -vE '^(22|80|443|)$' | tr '\n' ' ')"
[ -z "${EXTRA// }" ] && ok "наружу слушают только порты: $OPEN" || bad "наружу открыты лишние порты: $EXTRA" "служба слушает 0.0.0.0 — в .env не должно быть HOST=0.0.0.0"
for p in 8766 8767 8768; do
  ss -ltnH "sport = :$p" | grep -q '127.0.0.1' && ok "порт $p — только внутри сервера" || { ss -ltnH "sport = :$p" | grep -q . && bad "порт $p слушает не только 127.0.0.1" "проверьте HOST в .env"; }
done

echo "== Защита от подбора и обновления =="
systemctl is-active --quiet fail2ban && ok "fail2ban работает (заблокировано сейчас: $(fail2ban-client banned 2>/dev/null | grep -o "'[0-9a-f.:]*'" | wc -l))" || bad "fail2ban не работает" "sudo systemctl enable --now fail2ban"
systemctl is-enabled --quiet unattended-upgrades && ok "автообновления безопасности включены" || bad "автообновления выключены" "sudo systemctl enable --now unattended-upgrades"
[ -f /var/run/reboot-required ] && bad "после обновлений нужна перезагрузка" "sudo reboot (или дождитесь 04:30)" || ok "перезагрузка не требуется"

echo "== Файлы программы =="
[ "$(stat -c %a /opt/rva)" = 700 ] && ok "папка /opt/rva — только для rva (700)" || bad "права /opt/rva: $(stat -c %a /opt/rva)" "sudo chmod 700 /opt/rva"
for f in procenka/.env bot/.env procenka/suppliers.json procenka/mailboxes.json procenka/data.db .backup_pass; do
  p="/opt/rva/$f"; [ -e "$p" ] || continue
  m="$(stat -c %a "$p")"; o="$(stat -c %U "$p")"
  [ "$m" = 600 ] && [ "$o" = rva ] && ok "$f — 600, владелец rva" || bad "$f — права $m, владелец $o" "sudo chown rva:rva $p && sudo chmod 600 $p"
done
grep -qE '^\s*HOST\s*=' /opt/rva/procenka/.env && bad "в procenka/.env задан HOST" "уберите строку HOST — программа должна слушать только 127.0.0.1" || ok "HOST в .env не задан (только 127.0.0.1)"

echo "== Службы =="
for s in rva-procenka rva-stt rva-mail-bot rva-mail-api rva-max-bot rva-tg-bot; do
  systemctl is-active --quiet $s && ok "$s работает" || bad "$s не работает" "sudo journalctl -u $s -n 50 --no-pager"
done

echo "== Резервные копии =="
systemctl is-active --quiet rva-backup.timer && ok "ночные копии включены" || bad "таймер копий выключен" "bash /opt/rva/deploy/6_setup_backup.sh"
LAST="$(journalctl -u rva-backup --since '-2 days' --no-pager -o cat 2>/dev/null | grep 'отправлена' | tail -1)"
[ -n "$LAST" ] && ok "последняя: $LAST" || bad "за 2 дня ни одной успешной копии" "sudo systemctl start rva-backup && journalctl -u rva-backup -n 30"
ls /opt/rva/procenka/backups/data-*.db >/dev/null 2>&1 && ok "местные ежедневные копии базы: $(ls /opt/rva/procenka/backups/data-*.db | wc -l) шт." || bad "местных копий базы нет" "они создаются программой раз в сутки — проверьте rva-procenka"

if [ -n "$DOMAIN" ]; then
  echo "== Сайт https://$DOMAIN =="
  code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
  [ "$(code "https://$DOMAIN/poisk")" = 200 ] && ok "страница проценки открывается по https" || bad "https://$DOMAIN/poisk не открывается" "sudo nginx -t && sudo systemctl status nginx"
  [ "$(code "http://$DOMAIN/poisk")" = 301 ] && ok "http перенаправляется на https" || bad "http не перенаправляется" "проверьте /etc/nginx/sites-available/rva.conf"
  [ "$(code "https://$DOMAIN/organizer")" = 401 ] && ok "органайзер под вторым паролем" || bad "органайзер открывается без второго пароля" "sudo bash /opt/rva/deploy/5_setup_nginx.sh $DOMAIN почта"
  [ "$(code -X POST "https://$DOMAIN/api/bot/user")" = 404 ] && ok "служебные адреса ботов снаружи закрыты" || bad "/api/bot/* доступен снаружи" "проверьте конфиг nginx"
  END="$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
  [ -n "$END" ] && ok "сертификат действует до: $END (продлевается сам)" || bad "не удалось прочитать сертификат" "sudo certbot certificates"
fi

echo
[ $FAIL = 0 ] && echo "Всё в порядке." || echo "Есть замечания — см. ✗ выше."
exit $FAIL
