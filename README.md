# NIFSERVER Dashboard

Panel web pribadi untuk memantau home server Ubuntu: CPU, RAM, swap, disk, suhu, jaringan, status service, storage, dan shortcut aplikasi. Monitoring bersifat **read-only**: tidak ada eksekusi shell, terminal web, atau aksi pada service sistem (SSH, Apache, Samba, Netdata, cloudflared, dashboard).

**Hosting Manager** (menu *Hosting*) men-deploy website/aplikasi dari ZIP atau GitHub ke unit terisolasi `nifapp@<id>` — aksi start/stop/restart hanya untuk unit aplikasi yang di-host, lewat polkit tanpa sudo. Lihat [deploy/hosting/README.md](deploy/hosting/README.md).

```
frontend/          Next.js 16 (App Router) + TypeScript + Tailwind v4 — UI, port 3000
backend/           Express 5 + TypeScript — API /api/v1, port 3001 (loopback)
backend/runtime/   builder, gateway, launcher hosting (dipasang root-owned ke /usr/local/lib/nifhost)
config/            services.json (allowlist service) · applications.example.json
deploy/            unit systemd, contoh Nginx, snippet cloudflared, update-nifserver.sh
deploy/hosting/    unit nifapp@/nifbuild@/gateway, rule polkit, install.sh
docs/              DEPLOYMENT-GITHUB.md
```

## Arsitektur singkat

```
Browser ─▶ (Cloudflare Access ─▶ cloudflared)  ─▶ Nginx :8088 ─┬─▶ /api/* ─▶ backend 127.0.0.1:3001 ─▶ /proc, /sys, systemctl show, Netdata :19999
                         LAN ──────────────────▶               └─▶ /*     ─▶ frontend 127.0.0.1:3000
```

- Backend membaca metrik dari `/proc`, `/sys/class/hwmon`, dan `fs.statfs` — tanpa shell. Status service memakai `systemctl show` (argumen tetap, nama dari allowlist).
- Grafik historis diambil dari Netdata API (timeout 3 dtk). Jika Netdata mati, hanya grafik yang menampilkan error; bagian lain tetap jalan.
- Nilai yang tidak tersedia dikirim sebagai `null` dan tampil `N/A`.
- Polling: ringkasan 5 dtk, service 10 dtk, grafik 10–120 dtk tergantung rentang. Polling berhenti saat tab tidak aktif.

## API (`/api/v1`)

Format respons: `{ "data": ..., "timestamp": "...", "error": null }`

| Endpoint | Auth | Isi |
|---|---|---|
| `GET /health` | publik | status backend, flag `mock` |
| `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` | — | sesi administrator |
| `GET /system/summary` | ✔ | uptime, CPU, load, RAM, swap, disk, suhu, jaringan |
| `GET /services` | ✔ | status service dari allowlist |
| `GET /storage` | ✔ | disk `/` dan `SHARED_PATH`, status apache2/smbd, shortcut storage |
| `GET /metrics/{cpu,memory,swap,network,disk}?range=5m\|15m\|1h\|6h` | ✔ | seri waktu dari Netdata |
| `GET /applications` | ✔ | aplikasi dari konfigurasi + health check opsional |
| `GET /events?limit=` | ✔ | event aplikasi yang sudah disaring (memori, maks. 200) |
| `GET /hosting/prerequisites` · `GET /hosting/runtimes` · `GET /hosting/audit` | ✔ | prasyarat server (read-only), runtime yang didukung, audit hosting |
| `GET·POST /hosting/apps` · `GET·PATCH·DELETE /hosting/apps/:id` | ✔ | daftar/buat/ubah/hapus aplikasi (hapus: `{confirm: id}`) |
| `POST /hosting/apps/:id/deploy/upload` (`application/zip`) · `.../deploy/github` | ✔ | deploy (202, berjalan di latar) |
| `POST /hosting/apps/:id/rollback` · `.../actions` (`start\|stop\|restart`) | ✔ | rollback rilis, aksi service (stop: `{confirm: id}`) |
| `PUT /hosting/apps/:id/{domains,env,database,git-token}` · `GET .../domains/status` | ✔ | domain, env (secret tidak pernah dikembalikan), database, token deploy |
| `GET /hosting/apps/:id/deployments/:did/log` | ✔ | log deployment yang disanitasi |

## Keamanan

- Password admin disimpan sebagai hash bcrypt (cost 12) di `.env`; tidak pernah dicatat ke log.
- Sesi: token acak 256-bit, server hanya menyimpan SHA-256-nya; cookie `HttpOnly`, `SameSite=Strict`, `Secure` otomatis untuk request HTTPS.
- Login dibatasi 5 percobaan gagal / 15 menit per IP. Request mutasi wajib `application/json` (blok CSRF dari form lintas situs).
- Error ke client hanya pesan umum, tanpa stack trace. Header keamanan via Helmet.
- Backend dan frontend hanya bind ke `127.0.0.1`; jangan pernah forward port 3000/3001/19999 di router.
- Hosting: semua endpoint butuh sesi admin, body divalidasi Zod, rate limit deploy, upload ZIP diperiksa (traversal, symlink, duplikat, zip bomb), URL Git HTTPS + allowlist host + cek DNS anti-SSRF. Build/app berjalan di sandbox systemd dengan user terpisah — tidak pernah sebagai root atau user dashboard. Detail: [deploy/hosting/README.md](deploy/hosting/README.md).

## Pengembangan lokal (Windows/macOS)

Mode mock menyajikan data contoh berlabel jelas (banner kuning di UI).

```bash
# 1. Backend
cd backend && npm install
npm run hash-password            # buat hash, salin ke .env
cp ../.env.example ../.env       # isi ADMIN_PASSWORD_HASH, set MOCK_MODE=true, CONFIG_DIR=../config
npm run dev                      # http://127.0.0.1:3001

# 2. Frontend (terminal lain)
cd frontend && npm install
npm run dev                      # http://localhost:3000
```

Tes backend: `cd backend && npm test`.

Di luar Linux (atau dengan `MOCK_MODE=true`), Hosting Manager berjalan dalam **mode simulasi**: data di `.hosting-dev/` (di-ignore Git), build dan service tidak benar-benar dijalankan, dan UI menandainya di panel Prasyarat.

## Deployment di Ubuntu

Jalankan langkah berikut sendiri; perintah bertanda `sudo` mengubah sistem. Untuk instalasi dari repository GitHub privat dan update otomatis dengan rollback, lihat [docs/DEPLOYMENT-GITHUB.md](docs/DEPLOYMENT-GITHUB.md).

### 0. Audit (tanpa mengubah apa pun)

```bash
node -v && npm -v                     # Node ≥ 20.12
ss -ltnp                              # pastikan 3000, 3001, 8088 belum dipakai
systemctl is-active netdata apache2 cloudflared smbd ssh
curl -s 'http://127.0.0.1:19999/api/v1/info' | head -c 200
```

Jika ada port yang bentrok, ubah `API_PORT` / port frontend / port Nginx dan sesuaikan semua file di `deploy/`.

### 1. User dan direktori

```bash
sudo useradd --system --home /opt/nifserver --shell /usr/sbin/nologin nifserver
sudo mkdir -p /opt/nifserver /etc/nifserver
sudo cp -r backend frontend config /opt/nifserver/        # tanpa node_modules/.next
sudo chown -R nifserver:nifserver /opt/nifserver
```

### 2. Rahasia

```bash
sudo cp .env.example /etc/nifserver/nifserver.env
cd /opt/nifserver/backend && sudo -u nifserver npm ci && sudo -u nifserver npm run hash-password
sudo nano /etc/nifserver/nifserver.env      # isi ADMIN_PASSWORD_HASH, MOCK_MODE=false
sudo chown root:nifserver /etc/nifserver/nifserver.env && sudo chmod 640 /etc/nifserver/nifserver.env
```

Opsional: `sudo -u nifserver cp /opt/nifserver/config/applications.example.json /opt/nifserver/config/applications.json` lalu sesuaikan.

### 3. Build

```bash
cd /opt/nifserver/backend  && sudo -u nifserver npm run build && sudo -u nifserver npm prune --omit=dev
cd /opt/nifserver/frontend && sudo -u nifserver npm ci && sudo -u nifserver npm run build
```

### 4. systemd

```bash
sudo cp deploy/nifserver-backend.service deploy/nifserver-frontend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nifserver-backend nifserver-frontend
curl -s http://127.0.0.1:3001/api/v1/health      # {"data":{"status":"ok","mock":false},...}
```

### 5. Nginx (LAN entry point, disarankan)

```bash
sudo apt install nginx            # jika belum ada; pastikan tidak bentrok dengan Apache di :80
sudo cp deploy/nginx-nifserver.conf /etc/nginx/sites-available/nifserver-panel
sudo ln -s /etc/nginx/sites-available/nifserver-panel /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

Jika paket nginx baru di-install, nonaktifkan site `default` miliknya agar tidak merebut port 80 dari Apache. Buka `http://<ip-server>:8088` dari perangkat LAN. Untuk firewall: `sudo ufw allow from 192.168.0.0/16 to any port 8088 proto tcp` (sesuaikan subnet).

### 5b. Hosting Manager (opsional)

```bash
sudo bash deploy/hosting/install.sh <user-backend>    # baca skripnya dulu; tidak memberi sudo
sudo systemctl restart nifserver-backend
```

Jika memakai Nginx dari langkah 5, salin ulang `deploy/nginx-nifserver.conf` (sudah berisi lokasi upload ZIP 55 MB) lalu `sudo nginx -t && sudo systemctl reload nginx`. Panduan lengkap & konfigurasi domain: [deploy/hosting/README.md](deploy/hosting/README.md).

### 6. Remote via Cloudflare (setelah LAN teruji)

1. Backup: `sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak-$(date +%F)`.
2. Tambahkan rule `panel.nifserver.cloud` dari `deploy/cloudflared-ingress.example.yml` **di atas** rule 404. Jangan ubah rule `drive.nifserver.cloud`.
3. `cloudflared tunnel route dns <nama-tunnel> panel.nifserver.cloud`
4. Di Cloudflare Zero Trust → Access → Applications, buat aplikasi self-hosted untuk `panel.nifserver.cloud` dengan policy yang hanya mengizinkan email Anda.
5. `sudo systemctl restart cloudflared`, lalu uji dari jaringan seluler: harus muncul halaman Cloudflare Access dulu, baru login dashboard.
6. Pastikan `drive.nifserver.cloud` (RaiDrive), Samba, dan SSH tetap berfungsi.

## Operasional

| Kebutuhan | Perintah |
|---|---|
| Log | `journalctl -u nifserver-backend -f` · `journalctl -u nifserver-frontend -f` |
| Restart | `sudo systemctl restart nifserver-backend nifserver-frontend` |
| Ganti password | `npm run hash-password` → ubah `.env` → restart backend (semua sesi ter-logout) |
| Tambah service dipantau | edit `config/services.json` → restart backend |

### Troubleshooting

- **Semua service "Tidak diketahui"** — `systemctl` tidak bisa dipanggil; cek `journalctl -u nifserver-backend`.
- **Grafik "Netdata tidak tersedia"** — `curl http://127.0.0.1:19999/api/v1/info`; cek `NETDATA_URL`.
- **Suhu N/A** — `ls /sys/class/hwmon/*/name`; perlu driver `coretemp` (`sudo modprobe coretemp`).
- **Login berulang kali kembali ke halaman login di LAN** — cookie `Secure` di HTTP; set `COOKIE_SECURE=auto` atau `false`.
- **Shared folder N/A** — user `nifserver` tidak punya izin baca `/srv/shared` (sengaja tidak diberi izin tulis).

### Rollback

```bash
sudo systemctl disable --now nifserver-frontend nifserver-backend
sudo rm /etc/systemd/system/nifserver-{frontend,backend}.service && sudo systemctl daemon-reload
sudo rm /etc/nginx/sites-enabled/nifserver-panel && sudo systemctl reload nginx
sudo cp /etc/cloudflared/config.yml.bak-<tanggal> /etc/cloudflared/config.yml && sudo systemctl restart cloudflared
```

Layanan lama (Apache WebDAV, Samba, SSH, Netdata, tunnel `drive`) tidak disentuh oleh dashboard ini. Uninstall Hosting Manager: lihat [deploy/hosting/README.md](deploy/hosting/README.md#uninstall).

## Tahap berikutnya

AI & Automation, notifikasi (disk penuh, service mati, suhu, RAM), dan SQLite untuk audit/riwayat — lihat PRD bagian 6.8–6.9. Menu AI sudah ada sebagai placeholder nonaktif.
