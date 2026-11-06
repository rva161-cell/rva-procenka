#!/bin/bash
# Шаг 2. Запереть вход на сервер: только по SSH-ключу, только пользователь rva, root — нельзя.
# Запускать ПОСЛЕ того, как вход «ssh rva@IP» по ключу проверен в отдельном окне:
#   sudo bash /root/deploy/2_lock_ssh.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }
if [ ! -s /home/rva/.ssh/authorized_keys ]; then
  echo "!! У пользователя rva нет SSH-ключа — запирать вход нельзя, иначе потеряете доступ"; exit 1
fi
read -r -p "Вход «ssh rva@…» по ключу в отдельном окне РАБОТАЕТ? Введите да: " ok
[ "$ok" = "да" ] || { echo "Отменено. Сначала проверьте вход под rva."; exit 1; }

# файл с именем 00-… читается первым: в sshd побеждает первое значение (облачный 50-cloud-init.conf
# на Ubuntu включает вход по паролю — наш файл должен быть раньше него)
cat > /etc/ssh/sshd_config.d/00-rva.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers rva
MaxAuthTries 4
EOF
mkdir -p /run/sshd && sshd -t
systemctl reload ssh 2>/dev/null || systemctl restart ssh
echo "Проверка действующих настроек:"
sshd -T | grep -E '^(passwordauthentication|permitrootlogin|allowusers|pubkeyauthentication) '
echo
echo "Готово. Вход теперь только: ssh rva@IP (по ключу). Если ключ потеряется — вход через"
echo "консоль в панели Timeweb (VNC), там работает пароль rva."
