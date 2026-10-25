#!/usr/bin/env bash
# Update NIFSERVER Dashboard from GitHub (branch main) with backup, tests,
# health check, and automatic rollback. Read it before running.
#
#   sudo bash /opt/nifserver/deploy/update-nifserver.sh            # defaults below
#   sudo APP_DIR=/opt/nifserver RUN_USER=hanifsr bash deploy/update-nifserver.sh
#
# How it stays safe:
#   1. builds and tests the new commit in a STAGING copy — the running install is untouched;
#   2. only if build + tests pass: stop services, swap directories, start, health-check;
#   3. if the health check fails: swap back, restart the previous version.
# Only nifserver-backend / nifserver-frontend are restarted. Nothing else
# (SSH, firewall, Apache/WebDAV, Samba, Netdata, cloudflared, hosted apps) is touched.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/nifserver}"
BRANCH="${BRANCH:-main}"
RUN_USER="${RUN_USER:-$(stat -c %U "$APP_DIR")}"
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/nifserver}"
ENV_FILE="${ENV_FILE:-/etc/nifserver/nifserver.env}"
SERVICES=(nifserver-backend nifserver-frontend)
API_HEALTH="http://127.0.0.1:3001/api/v1/health"
WEB_HEALTH="http://127.0.0.1:3000/login"

STAMP="$(date +%F-%H%M%S)"
STAGING="${APP_DIR}.staging"
PREVIOUS="${APP_DIR}.prev"
BACKUP="$BACKUP_ROOT/$STAMP"

log() { printf '\n==> %s\n' "$*"; }
die() { echo "update: $*" >&2; exit 1; }
as_user() { sudo -u "$RUN_USER" -H -- "$@"; }

[ "$(id -u)" -eq 0 ] || die "jalankan dengan sudo (perlu restart service)"
[ "$RUN_USER" != "root" ] || die "RUN_USER tidak boleh root; build tidak dijalankan sebagai root"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR bukan clone git (lihat docs/DEPLOYMENT-GITHUB.md untuk clone pertama)"
[ -z "$(as_user git -C "$APP_DIR" status --porcelain --untracked-files=no)" ] || die "ada perubahan lokal di $APP_DIR; commit/stash dulu"

log "fetch origin/$BRANCH"
as_user git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
CURRENT="$(as_user git -C "$APP_DIR" rev-parse HEAD)"
TARGET="$(as_user git -C "$APP_DIR" rev-parse "origin/$BRANCH")"
if [ "$CURRENT" = "$TARGET" ]; then echo "Sudah versi terbaru ($CURRENT)."; exit 0; fi
echo "update ${CURRENT:0:10} -> ${TARGET:0:10}"
as_user git -C "$APP_DIR" log --oneline "$CURRENT..$TARGET" | head -20

log "backup -> $BACKUP"
install -d -m 700 "$BACKUP"
echo "$CURRENT" > "$BACKUP/commit"
[ -f "$ENV_FILE" ] && cp -a "$ENV_FILE" "$BACKUP/"
[ -d "$APP_DIR/config" ] && cp -a "$APP_DIR/config" "$BACKUP/config"
[ -f /srv/nifhost/registry.json ] && cp -a /srv/nifhost/registry.json "$BACKUP/hosting-registry.json"
for unit in "${SERVICES[@]}"; do systemctl cat "$unit" > "$BACKUP/$unit.unit.txt" 2>/dev/null || true; done

log "staging build (versi berjalan tidak disentuh)"
trap 'echo "update: GAGAL di baris $LINENO sebelum swap — versi berjalan tidak berubah. Staging: $STAGING" >&2' ERR
rm -rf "$STAGING"
install -d -o "$RUN_USER" -g "$(id -gn "$RUN_USER")" "$STAGING"
as_user git clone --quiet --no-hardlinks "$APP_DIR" "$STAGING"
as_user git -C "$STAGING" checkout --quiet -B "$BRANCH" "$TARGET"
as_user git -C "$STAGING" remote set-url origin "$(as_user git -C "$APP_DIR" remote get-url origin)"
# Local, git-ignored configuration travels with the install.
[ -f "$APP_DIR/config/applications.json" ] && as_user cp -a "$APP_DIR/config/applications.json" "$STAGING/config/"

cd "$STAGING/backend"
as_user npm ci --no-audit --no-fund
as_user npm run typecheck
as_user npm test
as_user npm run build
as_user npm prune --omit=dev --no-audit --no-fund
cd "$STAGING/frontend"
as_user npm ci --no-audit --no-fund
as_user npm run lint
as_user npm run build
cd /

if [ -d /usr/local/lib/nifhost ] && ! diff -rq "$STAGING/backend/runtime" /usr/local/lib/nifhost >/dev/null 2>&1; then
  echo "CATATAN: skrip runtime hosting berubah. Setelah update berhasil jalankan:"
  echo "  sudo bash $APP_DIR/deploy/hosting/install.sh $RUN_USER"
fi

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$API_HEALTH" | grep -q '"status":"ok"' && curl -fsS -o /dev/null --max-time 5 "$WEB_HEALTH"; then
      return 0
    fi
    sleep 2
  done
  return 1
}

log "swap & restart"
trap - ERR
systemctl stop "${SERVICES[@]}"
rm -rf "$PREVIOUS"
mv "$APP_DIR" "$PREVIOUS"
mv "$STAGING" "$APP_DIR"
systemctl start "${SERVICES[@]}"

if healthy; then
  log "OK: $(as_user git -C "$APP_DIR" log -1 --format='%h %s')"
  echo "Versi sebelumnya tersimpan di $PREVIOUS, backup di $BACKUP"
  exit 0
fi

log "HEALTH CHECK GAGAL — rollback ke ${CURRENT:0:10}"
journalctl -u nifserver-backend -n 30 --no-pager || true
systemctl stop "${SERVICES[@]}"
mv "$APP_DIR" "${APP_DIR}.failed-$STAMP"
mv "$PREVIOUS" "$APP_DIR"
systemctl start "${SERVICES[@]}"
if healthy; then
  echo "Rollback berhasil. Build gagal disimpan di ${APP_DIR}.failed-$STAMP untuk diperiksa."
else
  echo "Rollback juga tidak sehat — periksa journalctl -u nifserver-backend -u nifserver-frontend" >&2
fi
exit 1
