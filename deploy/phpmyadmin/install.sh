#!/usr/bin/env bash
# Ubuntu 24.04 Apache setup. Run from any directory, as root.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Jalankan dengan sudo" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE=/etc/nifserver/nifserver.env
CONF=/etc/apache2/conf-available/nifserver-panel.conf
ENABLED=/etc/apache2/conf-enabled/nifserver-panel.conf
[ "$#" -eq 0 ] || { echo "Usage: sudo bash deploy/phpmyadmin/install.sh (tanpa argumen)" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Environment backend tidak ditemukan" >&2; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || { echo "Installer ini untuk Ubuntu 24.04" >&2; exit 1; }
if [ ! -e "$ENABLED" ] && ss -H -ltn 'sport = :8088' | grep -q .; then
    echo "Port 8088 sudah dipakai. Tidak mengubah konfigurasi layanan lain." >&2
    exit 1
fi
if [ -e /etc/apache2/conf-enabled/phpmyadmin.conf ]; then
    echo "Alias phpMyAdmin global aktif. Jalankan sudo a2disconf phpmyadmin lalu sudo systemctl reload apache2 sebelum instalasi ini." >&2
    exit 1
fi
# Suppress package Apache auto-registration and database setup.
printf 'phpmyadmin phpmyadmin/reconfigure-webserver multiselect\nphpmyadmin phpmyadmin/dbconfig-install boolean false\n' | debconf-set-selections
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends apache2 phpmyadmin php8.3-fpm php8.3-mysql php8.3-mbstring php8.3-curl openssl python3 curl
# Guard again after package setup.
[ ! -e /etc/apache2/conf-enabled/phpmyadmin.conf ] || { echo "Alias phpMyAdmin global harus dinonaktifkan dahulu" >&2; exit 1; }
BACKUP="/var/backups/nifserver-phpmyadmin/$(date +%Y%m%d-%H%M%S)-apache"
install -d -m 700 "$BACKUP"
TARGETS=("$ENV_FILE" "$CONF" "$ENABLED" /usr/local/lib/nifhost/apache-session-check.py /usr/local/lib/nifhost/phpmyadmin-signon.php /etc/phpmyadmin/conf.d/zz-nifhost.php /etc/phpmyadmin/nifhost-bridge.key)
for target in "${TARGETS[@]}"; do
    if [ -e "$target" ] || [ -L "$target" ]; then cp --parents -a "$target" "$BACKUP/"; fi
done
SERVICES_TOUCHED=false
rollback() {
    trap - ERR
    set +e
    for target in "${TARGETS[@]}"; do
        rm -f -- "$target"
        if [ -e "$BACKUP$target" ] || [ -L "$BACKUP$target" ]; then cp -a "$BACKUP$target" "$target"; fi
    done
    if [ "$SERVICES_TOUCHED" = true ]; then
        apache2ctl configtest && systemctl reload apache2
        systemctl restart nifserver-backend
    fi
    echo "Instalasi gagal; file konfigurasi dikembalikan. Backup: $BACKUP" >&2
    exit 1
}
trap rollback ERR
install -d -m 755 /usr/local/lib/nifhost /etc/phpmyadmin/conf.d
install -d -o www-data -g www-data -m 700 /var/lib/phpmyadmin/nifhost-sessions
if [ ! -f /etc/phpmyadmin/nifhost-bridge.key ]; then
    (umask 077; openssl rand -hex 32 > /etc/phpmyadmin/nifhost-bridge.key)
fi
chown root:www-data /etc/phpmyadmin/nifhost-bridge.key
chmod 640 /etc/phpmyadmin/nifhost-bridge.key
install -o root -g root -m 755 "$HERE/apache-session-check.py" /usr/local/lib/nifhost/apache-session-check.py
install -o root -g root -m 644 "$HERE/signon.php" /usr/local/lib/nifhost/phpmyadmin-signon.php
install -o root -g root -m 644 "$HERE/config.inc.php" /etc/phpmyadmin/conf.d/zz-nifhost.php
install -o root -g root -m 644 "$HERE/apache-panel.conf" "$CONF"
python3 - "$ENV_FILE" <<'PY'
import pathlib, re, sys
key = pathlib.Path('/etc/phpmyadmin/nifhost-bridge.key').read_text().strip()
if not re.fullmatch('[a-f0-9]{64}', key): raise SystemExit('Bridge key tidak valid')
env = pathlib.Path(sys.argv[1])
text = re.sub(r'^(?:PHPMYADMIN_ENABLED|PHPMYADMIN_BRIDGE_KEY)=.*\n?', '', env.read_text(), flags=re.M)
env.write_text(text.rstrip() + '\nPHPMYADMIN_ENABLED=true\nPHPMYADMIN_BRIDGE_KEY=' + key + '\n')
PY
# Only modules, never a global PHP handler or changes to WebDAV/default sites.
a2enmod proxy proxy_http proxy_fcgi rewrite headers setenvif alias dir env
ln -sfn "$CONF" "$ENABLED"
php8.3 -l /usr/local/lib/nifhost/phpmyadmin-signon.php
php8.3 -l /etc/phpmyadmin/conf.d/zz-nifhost.php
apache2ctl configtest
SERVICES_TOUCHED=true
systemctl enable --now php8.3-fpm
systemctl restart nifserver-backend
systemctl reload apache2
# Fail closed: unauthenticated PHP, signon and static asset requests must be denied.
for path in /phpmyadmin/ /phpmyadmin/index.php /phpmyadmin/nifhost-signon.php /phpmyadmin/themes/pmahomme/img/logo_right.png; do
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:8088$path")"
    [ "$status" = 401 ] || { echo "Pemeriksaan akses gagal ($status) pada $path" >&2; false; }
done
curl -fsS --max-time 10 http://127.0.0.1:8088/api/v1/health > /dev/null
curl -fsS --max-time 10 http://127.0.0.1:8088/login > /dev/null
trap - ERR
echo "Selesai. Apache panel aktif di http://127.0.0.1:8088; backup: $BACKUP"
echo "Sekarang ubah Cloudflare Tunnel Service URL dari port 3000 ke http://127.0.0.1:8088."
echo "Login ulang dashboard > Hosting > aplikasi > Database > Buka phpMyAdmin."
