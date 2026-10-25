#!/usr/bin/env bash
# One-time (and re-runnable) setup for the NIFSERVER Hosting Manager.
# Read it before running. Usage, from the repository root:
#
#   sudo bash deploy/hosting/install.sh <dashboard-user>      # e.g. hanifsr
#
# What it does (nothing else):
#   - creates group `nifhost`, system users `nifbuild` (builds) and `nifgw` (gateway)
#   - adds <dashboard-user> to `nifhost` (shared release files; NOT sudo)
#   - creates /srv/nifhost (owned by <dashboard-user>, group nifhost, setgid)
#   - installs runtime scripts root-owned to /usr/local/lib/nifhost
#   - installs nifapp@ / nifbuild@ / nifhost-gateway units (backs up existing copies)
#   - installs a drop-in for nifserver-backend (ReadWritePaths=/srv/nifhost)
#   - installs a polkit rule allowing <dashboard-user> to start/stop/restart only
#     nifapp@*.service and start nifbuild@*.service
#   - enables and starts nifhost-gateway
# It does NOT touch SSH, firewall, Apache/WebDAV, Samba, Netdata, cloudflared, or Nginx.
set -euo pipefail

die() { echo "install.sh: $*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || die "jalankan dengan sudo"
DASH_USER="${1:-}"
[[ "$DASH_USER" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "usage: sudo bash deploy/hosting/install.sh <dashboard-user>"
[ "$DASH_USER" != "root" ] || die "dashboard user tidak boleh root"
id "$DASH_USER" >/dev/null 2>&1 || die "user $DASH_USER tidak ada"
command -v systemctl >/dev/null || die "systemd diperlukan"
[ -x /usr/bin/node ] || die "/usr/bin/node tidak ada — pasang Node.js LTS sistem dulu"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
ROOT=/srv/nifhost
LIB=/usr/local/lib/nifhost
STAMP="$(date +%F-%H%M%S)"

echo "==> users & group"
getent group nifhost >/dev/null || groupadd --system nifhost
id nifbuild >/dev/null 2>&1 || useradd --system --gid nifhost --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin nifbuild
id nifgw >/dev/null 2>&1 || useradd --system --user-group --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin nifgw
usermod -aG nifhost "$DASH_USER"

echo "==> $ROOT"
install -d -o "$DASH_USER" -g nifhost -m 2775 "$ROOT" "$ROOT/apps"

echo "==> runtime scripts -> $LIB (root-owned, read-only for everyone else)"
install -d -o root -g root -m 755 "$LIB"
install -o root -g root -m 644 "$REPO/backend/runtime/builder.mjs" "$REPO/backend/runtime/gateway.mjs" "$REPO/backend/runtime/router.php" "$LIB/"
install -o root -g root -m 755 "$REPO/backend/runtime/nifapp-run" "$LIB/"

echo "==> systemd units"
for unit in nifapp@.service nifbuild@.service nifhost-gateway.service; do
  if [ -f "/etc/systemd/system/$unit" ] && ! cmp -s "$HERE/$unit" "/etc/systemd/system/$unit"; then
    cp -a "/etc/systemd/system/$unit" "/etc/systemd/system/$unit.bak-$STAMP"
  fi
  install -o root -g root -m 644 "$HERE/$unit" "/etc/systemd/system/$unit"
done
install -d -o root -g root -m 755 /etc/systemd/system/nifserver-backend.service.d
install -o root -g root -m 644 "$HERE/nifserver-backend-hosting.conf" /etc/systemd/system/nifserver-backend.service.d/hosting.conf

echo "==> polkit rule"
install -d -m 755 /etc/polkit-1/rules.d
sed "s/@DASHBOARD_USER@/$DASH_USER/g" "$HERE/50-nifhost.rules" > "/etc/polkit-1/rules.d/50-nifhost.rules.tmp"
chmod 644 /etc/polkit-1/rules.d/50-nifhost.rules.tmp
mv /etc/polkit-1/rules.d/50-nifhost.rules.tmp /etc/polkit-1/rules.d/50-nifhost.rules

echo "==> reload"
systemctl daemon-reload
if ss -ltn 'sport = :8090' | grep -q LISTEN && ! systemctl is-active --quiet nifhost-gateway; then
  echo "PERINGATAN: port 8090 sudah dipakai; ubah NIFHOST_GATEWAY_PORT (unit) dan HOSTING_GATEWAY_PORT (.env), lalu jalankan ulang." >&2
else
  systemctl enable --now nifhost-gateway.service
fi

cat <<EOF

Selesai. Langkah berikutnya:
  sudo systemctl restart nifserver-backend     # agar grup nifhost & drop-in berlaku
  curl -s http://127.0.0.1:8090/__nifhost/healthz   # -> ok
Buka Dashboard -> Hosting -> Prasyarat untuk memeriksa sisanya.
EOF
