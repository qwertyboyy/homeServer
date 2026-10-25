# Hosting Manager — instalasi, konfigurasi & model keamanan

Hosting Manager (menu **Hosting** di dashboard) men-deploy website/aplikasi dari **upload ZIP** atau **repository GitHub**:
website statis, React/Vite, Next.js, Node.js/Express/API, Laravel, dan PHP.

## Arsitektur

```
Dashboard API (user hanifsr, tanpa sudo)
  │  hanya: tulis /srv/nifhost/*, `systemctl start|stop|restart` pada nifapp@<id> / start nifbuild@<id>
  │  (diizinkan polkit, nama unit = id tervalidasi; argumen tetap; tidak ada shell)
  ▼
nifbuild@<id>.service  ── user nifbuild, sandbox: hanya apps/<id>/{releases,build}, LAN/metadata IP diblokir,
  builder.mjs             CPU 150% · RAM 1,5 GB · 512 task · 30 menit. Perintah dari allowlist di builder.mjs.
  (git clone / npm ci / npm run build / composer install)

nifapp@<id>.service    ── DynamicUser (UID unik per app), rilis read-only, state di /var/lib/nifhost/<id>,
  nifapp-run (exec)       RAM 384 MB · CPU 100% · 128 task, LAN/metadata IP diblokir, secret via EnvironmentFile.
  (next start / node / php -S)

nifhost-gateway        ── user nifgw, 127.0.0.1:8090. Routing per Host header:
  gateway.mjs             situs statis disajikan langsung (tanpa proses per situs), app proses di-proxy ke 127.0.0.1:41xx.
                          .env, .git, node_modules, vendor, kunci, database, lockfile tidak pernah disajikan.

cloudflared ── (dikonfigurasi manual) ── hostname aplikasi → http://127.0.0.1:8090
```

Struktur data (`HOSTING_ROOT`, default `/srv/nifhost`):

```
registry.json          metadata semua aplikasi (tanpa secret), ditulis atomik + divalidasi Zod
routes.json            tabel routing gateway (ditulis atomik)
audit.log              audit JSONL (create, deploy, rollback, domain, aksi service) — tanpa secret
apps/<id>/run.env      runtime, rilis aktif, port (non-secret)
apps/<id>/releases/<rid>/   satu folder per deploy; rilis aktif tidak pernah ditimpa
apps/<id>/build/       plan.json (dari dashboard), build.log, result.json, cache npm/composer
apps/<id>/logs/<did>.log    log deployment yang sudah disanitasi
apps/<id>/secrets/     0700: secrets.json, runtime.env, git-token (0600)
```

### Alur deploy

1. **Sumber** → folder rilis baru: ZIP diperiksa dulu (path traversal, path absolut, symlink, file duplikat, file/folder
   bentrok, terenkripsi, jumlah entri, ukuran per file & total, rasio kompresi zip bomb), lalu diekstrak dengan pengecekan ulang.
   GitHub: URL HTTPS dari host yang di-allowlist, DNS harus publik, clone `--depth 1` dengan redirect, symlink, hook,
   dan submodule dimatikan, di dalam sandbox yang memblokir jaringan privat (anti DNS rebinding).
2. `.git`, `node_modules`, `.env*` (kecuali `.env.example`) dibuang; pohon file dicek ulang (tanpa symlink).
3. **Build** di `nifbuild@<id>` (kecuali situs statis). Gagal → folder rilis dihapus, rilis aktif tetap.
4. **Aktivasi atomik**: `run.env`, `registry.json`, `routes.json` diganti via write-then-rename; service di-restart.
5. **Health check** (2xx/3xx, atau 401/403 untuk app ber-login; 404/5xx = gagal). Untuk situs statis, gateway harus
   melaporkan rilis yang benar. Gagal → **kembali otomatis ke rilis sebelumnya**.
6. Simpan rilis aktif + 4 rilis terakhir untuk rollback.

Satu deployment berjalan pada satu waktu (RAM 4 GB). Rate limit: `HOSTING_DEPLOY_LIMIT` deploy / 15 menit,
60 mutasi / menit; upload maks. `HOSTING_MAX_UPLOAD_MB`.

## Instalasi (sekali)

Prasyarat: Ubuntu 24.04, systemd, Node.js LTS **sistem** di `/usr/bin/node` (bukan nvm di home), `git`.
Opsional: `php-cli` + `composer` (Laravel/PHP), MariaDB/PostgreSQL.

```bash
# 0. Audit — tidak mengubah apa pun
ss -ltnp | grep -E ':(8090|41[0-9]{2})\b'      # port gateway & app harus kosong
systemctl --version | head -1                  # >= 255 (Ubuntu 24.04)
ls /usr/bin/node /usr/bin/npm /usr/bin/git

# 1. Pasang komponen (baca skripnya dulu). <user> = user yang menjalankan nifserver-backend
sudo bash deploy/hosting/install.sh hanifsr

# 2. Terapkan grup & drop-in ke backend
sudo systemctl restart nifserver-backend
curl -s http://127.0.0.1:8090/__nifhost/healthz            # ok
```

Lalu buka **Dashboard → Hosting**; panel *Prasyarat server* harus hijau untuk bagian Inti.

`install.sh` melakukan **hanya**: grup `nifhost`, user sistem `nifbuild` & `nifgw` (tanpa shell), `<user>` masuk grup
`nifhost`, `/srv/nifhost`, skrip runtime root-owned di `/usr/local/lib/nifhost`, tiga unit systemd (backup jika ada),
drop-in `nifserver-backend.service.d/hosting.conf` (`ReadWritePaths=/srv/nifhost`), rule polkit, dan
`enable --now nifhost-gateway`. **Tidak** menyentuh SSH, firewall, Apache/WebDAV, Samba, Netdata, cloudflared, Nginx,
dan **tidak** memberi sudo.

### Update komponen hosting

Setiap kali `backend/runtime/*` atau `deploy/hosting/*` berubah, jalankan ulang
`sudo bash deploy/hosting/install.sh hanifsr` (idempotent) lalu `sudo systemctl restart nifhost-gateway`.

### Uninstall

```bash
sudo systemctl disable --now nifhost-gateway
sudo systemctl stop 'nifapp@*'
sudo rm /etc/systemd/system/{nifapp@,nifbuild@,nifhost-gateway}.service /etc/polkit-1/rules.d/50-nifhost.rules
sudo rm -r /etc/systemd/system/nifserver-backend.service.d/hosting.conf /usr/local/lib/nifhost
sudo systemctl daemon-reload && sudo systemctl restart nifserver-backend
# Data (rilis, secret) — hapus hanya bila yakin:  sudo rm -r /srv/nifhost /var/lib/private/nifhost
```

## Domain, DNS & Cloudflare Tunnel

Dashboard **tidak** mengubah DNS, Cloudflare, cloudflared, atau Nginx dan **tidak** mengasumsikan wildcard DNS.
Tab **Domain** menampilkan status DNS, apakah `config.yml` cloudflared (jika bisa dibaca) sudah punya rule ke gateway,
serta snippet & perintah yang perlu dijalankan:

```yaml
# /etc/cloudflared/config.yml — DI ATAS rule http_status:404, backup dulu.
ingress:
  # (rule drive.nifserver.cloud & panel.nifserver.cloud tetap seperti semula)
  - hostname: blog.nifserver.cloud
    service: http://127.0.0.1:8090
  - service: http_status:404
```

```bash
sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak-$(date +%F-%H%M)
sudoedit /etc/cloudflared/config.yml
cloudflared tunnel ingress validate
cloudflared tunnel route dns <nama-tunnel> blog.nifserver.cloud
sudo systemctl restart cloudflared
```

Opsi wildcard (satu rule untuk semua aplikasi): buat record DNS `*.apps.nifserver.cloud` (CNAME ke
`<tunnel-id>.cfargotunnel.com`) di Cloudflare dan rule `hostname: "*.apps.nifserver.cloud"`. Lindungi aplikasi
privat dengan Cloudflare Access. `drive.` dan `panel.nifserver.cloud` dicadangkan dan ditolak oleh dashboard
(`HOSTING_RESERVED_HOSTS`).

Akses LAN tanpa tunnel (opsional): tambahkan server block Nginx per hostname yang `proxy_pass http://127.0.0.1:8090`
dengan `proxy_set_header Host $host;` — gateway hanya bind ke loopback.

## Environment variable & database

- **Secret** (password, API key) disimpan di `apps/<id>/secrets/` (0700/0600, milik user backend), dibaca systemd
  sebagai root sebelum turun ke UID aplikasi; aplikasi tidak bisa membaca filenya, aplikasi lain tidak bisa melihat
  env-nya (`ProtectProc=invisible`). API hanya mengembalikan `set: true`, log deployment disensor nilai secret yang
  diketahui + pola token umum (GitHub, AWS, private key, `password=`, URL ber-kredensial).
- Variabel **non-secret** juga tersedia saat build (`VITE_*`, `NEXT_PUBLIC_*`). Secret **tidak pernah** masuk build.
- Kunci dicadangkan ditolak: `PATH`, `HOME`, `PORT`, `HOST`, `NODE_OPTIONS`, `LD_*`, `NIF_*`, `SYSTEMD_*`, dll.
- Laravel: `APP_KEY` dibuat otomatis sebagai secret; `APP_ENV=production`, `APP_DEBUG=false`, `LOG_CHANNEL=stderr`.
- Database: **SQLite** (file di `/var/lib/nifhost/<id>/database.sqlite`, tanpa server) atau MySQL/MariaDB/PostgreSQL di
  **localhost** (sandbox memblokir LAN). Dashboard tidak membuat database; tab Database menampilkan SQL pembuatan
  DB/user. Variabel: `DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`, `DATABASE_URL`.
- Perubahan env/database berlaku setelah **Restart** (app proses) atau **deploy ulang** (situs statis).

## Repo GitHub privat (aplikasi yang di-host)

Buat **fine-grained personal access token** di GitHub: *Repository access* = repo itu saja, *Permissions* →
*Contents: Read-only*. Simpan di tab **Pengaturan → Token deploy GitHub**. Token disimpan 0600, diberikan ke unit build
sebagai systemd credential, dikirim ke git sebagai header HTTP lewat environment (tidak di argv/URL/log), dan tidak
pernah dikembalikan oleh API. Ganti/hapus kapan saja dari halaman yang sama.

Auto-deploy via webhook **tidak** diimplementasikan (membutuhkan endpoint publik dengan verifikasi signature HMAC,
perlindungan replay, dan manajemen secret — sengaja ditunda). Deploy dipicu manual dari dashboard.

## Batasan yang perlu diketahui

- **Belum diuji di Ubuntu sungguhan dalam pengembangan ini**: unit systemd, rule polkit, dan `install.sh` ditulis untuk
  Ubuntu 24.04 (systemd 255, polkit 124) tetapi diverifikasi hanya secara statis. Lakukan uji pertama dengan satu situs
  statis, lalu cek `journalctl -u nifbuild@<id> -u nifapp@<id> -u nifhost-gateway`.
- Laravel/PHP memakai **server bawaan PHP** (`php -S`, 2 worker) — cukup untuk trafik rendah. PHP-FPM belum dipakai.
- Kuota disk per aplikasi tidak ditegakkan oleh filesystem; dibatasi lewat ukuran upload/ekstrak, batas 2 GB per rilis,
  dan jumlah rilis yang disimpan.
- `npm ci` menjalankan script install paket (postinstall) — di dalam sandbox `nifbuild@`, bukan di proses dashboard.
- Jaringan build/app: internet publik diizinkan (npm registry, GitHub, API eksternal); LAN, `169.254.0.0/16`, dan
  localhost (kecuali resolver DNS untuk build) diblokir di kernel (`IPAddressDeny`). App proses masih bisa menjangkau
  layanan di localhost (mis. database, Netdata read-only).
- Hanya npm yang didukung untuk proyek JavaScript (bukan pnpm/yarn).

## Troubleshooting

| Gejala | Periksa |
|---|---|
| Deploy gagal "Builder tidak menghasilkan result.json" | `journalctl -u nifbuild@<id> -n 50`; prasyarat unit/polkit |
| Aksi start/stop "gagal" | rule polkit terpasang? `pkcheck`/`journalctl -u polkit`; user backend sesuai `install.sh <user>` |
| Health check gagal | `journalctl -u nifapp@<id>`; health path benar? app listen di `$PORT` & `127.0.0.1`? |
| Situs 404 di domain | rule ingress cloudflared ke `:8090`; `curl -H 'Host: <domain>' http://127.0.0.1:8090/` |
| Next.js kehabisan memori saat build | tutup app lain atau naikkan `MemoryMax` via `sudo systemctl edit nifbuild@<id>` |
