#!/usr/bin/env bash
# Ubuntu 24.04: sudo bash deploy/phpmyadmin/install-nginx.sh [panel-nginx-config]
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Jalankan dengan sudo" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
PANEL="${1:-/etc/nginx/sites-available/nifserver-panel}"
ENV_FILE=/etc/nifserver/nifserver.env
[ -f "$PANEL" ] || { echo "Konfigurasi panel tidak ditemukan: $PANEL. Berikan path sebagai argumen." >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Environment backend tidak ditemukan" >&2; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] || { echo "Installer ini untuk Ubuntu 24.04" >&2; exit 1; }
if [ ! -f /etc/nginx/conf.d/nifhost-phpmyadmin.conf ] && ss -H -ltn 'sport = :8091' | grep -q .; then
    echo "Port 8091 sedang dipakai; instalasi dibatalkan" >&2
    exit 1
fi
# Prevent Debian package from registering an Apache alias or creating an admin DB.
printf 'phpmyadmin phpmyadmin/reconfigure-webserver multiselect\nphpmyadmin phpmyadmin/dbconfig-install boolean false\n' | debconf-set-selections
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends phpmyadmin php8.3-fpm php8.3-mysql php8.3-mbstring php8.3-curl nginx openssl python3
nginx -V 2>&1 | grep -q -- '--with-http_auth_request_module' || { echo "Nginx memerlukan modul auth_request" >&2; exit 1; }
if [ -e /etc/apache2/conf-enabled/phpmyadmin.conf ]; then
    echo "Alias phpMyAdmin Apache aktif. Nonaktifkan dengan sudo a2disconf phpmyadmin dan reload Apache sebelum melanjutkan." >&2
    exit 1
fi
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/var/backups/nifserver-phpmyadmin/$STAMP"
install -d -m 700 "$BACKUP"
cp -a "$PANEL" "$BACKUP/panel.conf"
cp -a "$ENV_FILE" "$BACKUP/backend.env"
NGINX_CONF=/etc/nginx/conf.d/nifhost-phpmyadmin.conf
[ ! -f "$NGINX_CONF" ] || cp -a "$NGINX_CONF" "$BACKUP/loopback.conf"
rollback() {
    cp -a "$BACKUP/panel.conf" "$PANEL"
    cp -a "$BACKUP/backend.env" "$ENV_FILE"
    if [ -f "$BACKUP/loopback.conf" ]; then cp -a "$BACKUP/loopback.conf" "$NGINX_CONF"; else rm -f "$NGINX_CONF"; fi
    echo "Instalasi gagal. Konfigurasi panel/env dikembalikan; backup: $BACKUP" >&2
}
trap rollback ERR
install -d -o www-data -g www-data -m 700 /var/lib/phpmyadmin/nifhost-sessions
install -d -m 755 /usr/local/lib/nifhost /etc/nginx/snippets /etc/phpmyadmin/conf.d
if [ ! -f /etc/phpmyadmin/nifhost-bridge.key ]; then
    (umask 077; openssl rand -hex 32 > /etc/phpmyadmin/nifhost-bridge.key)
fi
chown root:www-data /etc/phpmyadmin/nifhost-bridge.key
chmod 640 /etc/phpmyadmin/nifhost-bridge.key
install -o root -g root -m 644 "$HERE/signon.php" /usr/local/lib/nifhost/phpmyadmin-signon.php
install -o root -g root -m 644 "$HERE/config.inc.php" /etc/phpmyadmin/conf.d/zz-nifhost.php
install -o root -g root -m 644 "$HERE/nginx-server.conf" "$NGINX_CONF"
install -o root -g root -m 644 "$HERE/nginx-panel.inc" /etc/nginx/snippets/nifhost-phpmyadmin.inc
# Existing panel uses nif_forwarded_proto (see deploy/nginx-nifserver.conf).
python3 - "$PANEL" "$ENV_FILE" <<'PY'
import pathlib, re, sys
panel = pathlib.Path(sys.argv[1])
text = panel.read_text()
if '$nif_forwarded_proto' not in text:
    raise SystemExit('Panel harus memakai map nif_forwarded_proto; lihat deploy/nginx-nifserver.conf')
include = 'include /etc/nginx/snippets/nifhost-phpmyadmin.inc;'
if include not in text:
    text, count = re.subn(r'(server\s*\{)', r'\1\n    ' + include, text, count=1)
    if count != 1: raise SystemExit('Blok server panel tidak ditemukan')
    panel.write_text(text)
key = pathlib.Path('/etc/phpmyadmin/nifhost-bridge.key').read_text().strip()
if not re.fullmatch('[a-f0-9]{64}', key): raise SystemExit('Bridge key tidak valid')
env = pathlib.Path(sys.argv[2])
text = re.sub(r'^(?:PHPMYADMIN_ENABLED|PHPMYADMIN_BRIDGE_KEY)=.*\n?', '', env.read_text(), flags=re.M)
env.write_text(text.rstrip() + '\nPHPMYADMIN_ENABLED=true\nPHPMYADMIN_BRIDGE_KEY=' + key + '\n')
PY
php8.3 -l /usr/local/lib/nifhost/phpmyadmin-signon.php
php8.3 -l /etc/phpmyadmin/conf.d/zz-nifhost.php
nginx -t
systemctl enable --now php8.3-fpm
systemctl restart nifserver-backend
systemctl reload nginx
trap - ERR
echo "Selesai. Login ulang dashboard, lalu Hosting > aplikasi > Database > Buka phpMyAdmin."
echo "Uji tanpa cookie harus 401: curl -I http://127.0.0.1:8091/phpmyadmin/"
echo "Backup: $BACKUP"
