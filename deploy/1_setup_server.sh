#!/bin/bash
# Шаг 1. Подготовка нового VPS (Ubuntu 24.04). Запускать ОДИН раз от root:
#   sudo bash /root/deploy/1_setup_server.sh
# Что делает: обновления, программы (Node.js 24, Python, nginx, Chrome, fail2ban…),
# пользователь rva с вашим SSH-ключом, папка /opt/rva, брандмауэр (открыты только SSH, 80, 443),
# fail2ban, автообновления безопасности, лимит журналов, файл подкачки.
# Вход по паролю и под root здесь ещё НЕ запрещается — это шаг 2, после проверки входа под rva.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите от root: sudo bash $0"; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
export DEBIAN_FRONTEND=noninteractive

echo "== 1/8 Обновления системы =="
apt-get update -q
apt-get -y -q upgrade

echo "== 2/8 Программы =="
apt-get -y -q install ca-certificates curl gnupg git rsync sqlite3 unzip \
  python3 python3-venv python3-pip build-essential \
  nginx certbot apache2-utils ufw fail2ban unattended-upgrades
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh && apt-get -y -q install nodejs
fi
if ! command -v google-chrome >/dev/null; then     # для поставщиков «Сайт без API» (браузер + ИИ)
  curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/chrome.deb
  apt-get -y -q install /tmp/chrome.deb || echo "!! Chrome не установился — нужен только для «Сайт без API»"
fi
timedatectl set-timezone Europe/Moscow

echo "== 2a/8 PostgreSQL (решение 25.10: заложить сразу; программа пока работает на SQLite) =="
apt-get -y -q install postgresql
systemctl enable --now postgresql
# роль rva и база rva; пароль сохраняется один раз в /root/rva-postgres-password.txt (600)
if ! su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='rva'\"" | grep -q 1; then
  PGPASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  su - postgres -c "psql -q -c \"CREATE ROLE rva LOGIN PASSWORD '$PGPASS'\""
  su - postgres -c "psql -q -c \"CREATE DATABASE rva OWNER rva\""
  umask 077
  printf 'PostgreSQL для RVA (понадобится при переводе программы с SQLite)\nБаза: rva\nПользователь: rva\nПароль: %s\n' "$PGPASS" > /root/rva-postgres-password.txt
  echo "   роль rva и база rva созданы, пароль — в /root/rva-postgres-password.txt (перепишите в менеджер паролей)"
else
  echo "   роль rva уже существует — пропускаю"
fi
echo "   node $(node -v), python $(python3 -V | cut -d' ' -f2), nginx $(nginx -v 2>&1 | cut -d/ -f2)"

echo "== 3/8 Пользователь rva =="
if ! id rva >/dev/null 2>&1; then
  adduser --disabled-password --gecos "RVA" rva
  usermod -aG sudo rva
fi
install -d -m 700 -o rva -g rva /home/rva/.ssh
if [ -s /root/.ssh/authorized_keys ] && [ ! -s /home/rva/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys /home/rva/.ssh/authorized_keys
fi
[ -f /home/rva/.ssh/authorized_keys ] && chown rva:rva /home/rva/.ssh/authorized_keys && chmod 600 /home/rva/.ssh/authorized_keys
if [ ! -s /home/rva/.ssh/authorized_keys ]; then
  echo "!! У root нет SSH-ключа (/root/.ssh/authorized_keys) — добавьте ключ в панели Timeweb и запустите скрипт снова"; exit 1
fi
if passwd -S rva | grep -q " L "; then
  echo "   Задайте пароль rva — он нужен только для sudo (вход на сервер будет по ключу):"
  passwd rva
fi
install -d -m 700 -o rva -g rva /opt/rva

echo "== 4/8 Брандмауэр: открыты только SSH, 80, 443 =="
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "== 5/8 fail2ban: блокировка подбора паролей =="
install -m 644 "$HERE/fail2ban/jail.local" /etc/fail2ban/jail.local
install -m 644 "$HERE/fail2ban/filter.d/rva-login.conf" /etc/fail2ban/filter.d/rva-login.conf
touch /var/log/nginx/rva.access.log /var/log/nginx/rva.error.log
systemctl enable --now fail2ban
systemctl restart fail2ban

echo "== 6/8 Автообновления безопасности (с перезагрузкой в 04:30 при необходимости) =="
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52rva-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
systemctl enable --now unattended-upgrades

echo "== 7/8 Журналы: не больше 500 МБ =="
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/rva.conf
systemctl restart systemd-journald

echo "== 8/8 Подкачка 2 ГБ (whisper и Chrome любят память) =="
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# SSH: до шага 2 — только мягкие настройки (вход по паролю пока не выключен)
cat > /etc/ssh/sshd_config.d/01-rva-soft.conf <<'EOF'
MaxAuthTries 4
LoginGraceTime 30
X11Forwarding no
EOF
mkdir -p /run/sshd && sshd -t && (systemctl reload ssh 2>/dev/null || systemctl restart ssh)

echo
echo "Готово. НЕ закрывая это окно, откройте НОВОЕ окно терминала на Mac и проверьте вход:"
echo "    ssh rva@$(hostname -I | awk '{print $1}')"
echo "Если вошли без пароля (по ключу) — выполните шаг 2: sudo bash /root/deploy/2_lock_ssh.sh"
