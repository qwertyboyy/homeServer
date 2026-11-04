# Panduan Hosting NIFSERVER Dashboard

Panduan ini untuk men-deploy **proyek dashboard ini sendiri** ke Ubuntu 24.04
menggunakan Apache, systemd, MySQL, dan Cloudflare Tunnel.
File disimpan sebagai `doc.md` di root repository.

Dashboard dijalankan sebagai service sistem. Menu **Hosting** dipakai untuk
aplikasi lain, bukan untuk mengunggah dashboard ini ke dalam dirinya sendiri.

## 1. Susunan server

| Komponen | Alamat lokal / lokasi | Fungsi |
| --- | --- | --- |
| Repository | `/opt/nifserver` | Kode dashboard |
| Environment | `/etc/nifserver/nifserver.env` | Konfigurasi aktif dan secret |
| Frontend Next.js | `127.0.0.1:3000` | Halaman dashboard |
| Backend Express | `127.0.0.1:3001` | API dashboard |
| Apache panel | `127.0.0.1:8088` | Pintu masuk dashboard dan phpMyAdmin |
| Apache WebDAV | `127.0.0.1:8080` | Layanan WebDAV yang sudah ada |
| Gateway Hosting | `127.0.0.1:8090` | Aplikasi yang dibuat lewat menu Hosting |
| MySQL | `127.0.0.1:3306` | Database aplikasi yang di-host |
| Domain panel | `https://panel.nifserver.cloud` | Akses browser melalui Cloudflare |

Alur akses yang dituju:

```text
Browser -> Cloudflare Tunnel -> Apache 127.0.0.1:8088
                                 /api/         -> backend 3001
                                 /phpmyadmin/  -> PHP-FPM + pemeriksaan sesi
                                 halaman lain -> frontend 3000
```

Dashboard menyimpan registry Hosting dalam file; dashboard sendiri tidak perlu
dibuatkan database MySQL. MySQL dipakai aplikasi yang membutuhkan database.

**Untuk server yang dashboardnya sudah berjalan, langsung mulai langkah 3.**
Jangan ulangi clone, menimpa environment aktif, atau mengganti unit systemd yang
sudah disesuaikan.

## 2. Instalasi pertama saja

### 2.1 Prasyarat dan clone

Siapkan Git serta Node.js sistem yang memenuhi `engines` di `backend/package.json`
dan kebutuhan Next.js pada `frontend/package.json`. Verifikasi:

```bash
node --version
npm --version
git --version
command -v node
```

Unit systemd memakai `/usr/bin/node`. Node yang hanya tersedia melalui NVM user
belum tentu dapat dipakai service. Gunakan instalasi Node sistem yang sesuai.

Contoh berikut memakai user Linux `hanifsr`. Ganti bila user deploy Anda berbeda.
Clone hanya jika `/opt/nifserver` belum berisi instalasi proyek:

```bash
sudo install -d -o hanifsr -g hanifsr /opt/nifserver
sudo -u hanifsr git clone --branch main URL_REPOSITORY_ANDA /opt/nifserver
```

Ganti `URL_REPOSITORY_ANDA` dengan URL repository. Untuk repository privat,
siapkan deploy key read-only mengikuti [DEPLOYMENT-GITHUB.md](docs/DEPLOYMENT-GITHUB.md).

### 2.2 Environment, password, dan build

```bash
sudo install -d -o root -g hanifsr -m 750 /etc/nifserver
sudo cp /opt/nifserver/.env.example /etc/nifserver/nifserver.env
sudo chown root:hanifsr /etc/nifserver/nifserver.env
sudo chmod 640 /etc/nifserver/nifserver.env

cd /opt/nifserver/backend
npm ci
npm run hash-password
```

Salin hasil hash password ke file environment menggunakan editor:

```bash
sudo nano /etc/nifserver/nifserver.env
```

Pastikan nilai berikut diisi; pertahankan variabel lain dari `.env.example`:

```dotenv
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=3001
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=SALIN_HASH_BCRYPT_HASIL_PERINTAH
COOKIE_SECURE=auto
MOCK_MODE=false
CONFIG_DIR=/opt/nifserver/config
BACKEND_URL=http://127.0.0.1:3001
HOSTING_ENABLED=true
```

File ini dibaca systemd; isi hash langsung sebagai nilai, tanpa menjalankannya
sebagai perintah shell. Jangan commit file environment aktif.

```bash
cd /opt/nifserver/backend
npm run typecheck
npm test
npm run build
npm prune --omit=dev

cd /opt/nifserver/frontend
npm ci
npm run lint
npm run build
```

### 2.3 Service systemd

Template bawaan memakai `User=nifserver` dan `Group=nifserver`. Jika memakai
`hanifsr`, pasang template lalu sesuaikan **kedua** file sebelum menjalankan service:

```bash
sudo install -m 644 /opt/nifserver/deploy/nifserver-backend.service /etc/systemd/system/
sudo install -m 644 /opt/nifserver/deploy/nifserver-frontend.service /etc/systemd/system/
sudo nano /etc/systemd/system/nifserver-backend.service
sudo nano /etc/systemd/system/nifserver-frontend.service
```

Ubah `User=` dan `Group=` menjadi `hanifsr`; pastikan user tersebut dapat membaca
repository/environment dan menulis cache frontend. Jika memakai user lain,
sesuaikan kepemilikan dan grup file environment dengan user itu juga.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nifserver-backend nifserver-frontend
curl -fsS http://127.0.0.1:3001/api/v1/health
curl -I http://127.0.0.1:3000/login
```

Health API harus sukses dan halaman login harus 200. Jika service belum siap,
tunggu beberapa detik. Jika tetap gagal, periksa log pada langkah 8.

## 3. Update kode pada server yang sudah berjalan

### Di komputer pengembangan

Periksa perubahan, commit file yang memang ingin dirilis, lalu push ke branch
rilis (`main` secara default). Jangan sertakan `.env` atau secret.

```bash
git status --short
# Stage file yang sudah diperiksa, lalu:
git commit -m "Update dashboard dan konfigurasi hosting"
git push origin main
```

### Di server

```bash
cd /
cd /opt/nifserver
git status --short
sudo bash /opt/nifserver/deploy/update-nifserver.sh
cd /
cd /opt/nifserver
```

Tidak perlu `git pull` terpisah. Script melakukan fetch, build/test di staging,
backup, pergantian folder, restart dashboard, dan health check. Jika health check
gagal, script mengembalikan versi sebelumnya. Perintah `cd /` lalu masuk kembali
menghindari shell menunjuk folder lama yang telah diganti updater.

Jika update ditolak karena perubahan lokal, periksa dahulu:

```bash
git status --short
git diff --stat
```

Contoh jika **hanya `.env.example`** yang berubah dan ingin dipertahankan:

```bash
git stash push -m "Contoh konfigurasi lokal sebelum update" -- .env.example
sudo bash /opt/nifserver/deploy/update-nifserver.sh
cd /
cd /opt/nifserver
```

Jangan gunakan `git reset --hard` untuk melewati pemeriksaan perubahan lokal.
Jangan langsung mengembalikan stash ke server; bandingkan isinya dengan contoh
terbaru dan terapkan konfigurasi aktif melalui `/etc/nifserver/nifserver.env`.

## 4. Aktifkan Hosting Manager

Cari user backend yang sebenarnya, lalu pasang unit dan aturan Hosting:

```bash
backend_user=$(systemctl show nifserver-backend -p User --value)
printf 'User backend: %s\n' "$backend_user"
sudo bash /opt/nifserver/deploy/hosting/install.sh "$backend_user"
sudo systemctl restart nifserver-backend
curl -fsS http://127.0.0.1:8090/__nifhost/healthz
```

Lalu buka **Hosting > Prasyarat** di dashboard. Fitur PHP/Laravel memerlukan PHP
CLI dan Composer; runtime lain mengikuti kebutuhan yang ditampilkan di halaman
tersebut. Detail: [Hosting Manager](deploy/hosting/README.md).

## 5. MySQL untuk database aplikasi

Jika MySQL sudah aktif dan akun admin provisioning sudah dikonfigurasi, cukup
verifikasi; jangan mengulang `CREATE USER` untuk akun yang sudah ada.

```bash
systemctl is-active mysql
mysql --version
```

Jika belum terpasang pada Ubuntu 24.04:

```bash
sudo apt update
sudo apt install mysql-server mysql-client
sudo systemctl enable --now mysql
```

Konfigurasi akun `nifhost_admin`, hak prefix database, dan file koneksi mengikuti
[Database MySQL terkelola](deploy/hosting/README.md#database-mysql-terkelola-dan-migrasi-laravel).
Panduan tersebut menjelaskan batas hak global pengelolaan akun dan prasyarat
`partial_revokes`; jangan memberikan akun root kepada dashboard.

Environment aktif harus menunjuk file koneksi yang sudah disiapkan:

```dotenv
HOSTING_MYSQL_DEFAULTS_FILE=/etc/nifserver/mysql-admin.cnf
```

Setelah konfigurasi berubah, restart backend. User backend harus dapat membaca
file koneksi; izin contoh `root:GRUP_BACKEND`, mode `0640`.

## 6. Pasang Apache panel dan phpMyAdmin

Installer default proyek memakai Apache pada port 8088. Jalankan:

```bash
cd /
cd /opt/nifserver
sudo bash deploy/phpmyadmin/install.sh
```

Installer memasang paket phpMyAdmin/PHP-FPM, menambah vhost Apache khusus panel,
menyiapkan bridge login, lalu menjalankan pemeriksaan HTTP. WebDAV tetap pada
konfigurasi port 8080. Nginx tidak diperlukan untuk susunan ini.

**Lanjutkan ke pengaturan tunnel hanya jika installer berhasil.** Jika gagal,
installer mengembalikan file konfigurasi yang ditargetkan; catat pesan error.

Verifikasi:

```bash
sudo apache2ctl configtest
curl -I http://127.0.0.1:8088/login
curl -fsS http://127.0.0.1:8088/api/v1/health
curl -I http://127.0.0.1:8088/phpmyadmin/
```

| Pemeriksaan | Hasil yang diharapkan |
| --- | --- |
| Apache configtest | `Syntax OK` |
| `/login` | HTTP 200 |
| `/api/v1/health` | JSON dengan `data.status` = `ok` |
| `/phpmyadmin/` tanpa cookie | HTTP 401 Unauthorized |

HTTP 401 dari curl tanpa login adalah hasil pemeriksaan proteksi. Itu belum
membuktikan signon setelah login berhasil; lakukan uji browser pada langkah 7.

## 7. Cloudflare Tunnel dan menu Database

Pada Cloudflare, edit hostname **`panel.nifserver.cloud`** di tunnel yang sudah ada:

```text
Type: HTTP
Service URL: http://127.0.0.1:8088
```

Gunakan HTTP untuk koneksi lokal Apache ini. Alamat browser tetap menggunakan
HTTPS. Jangan ubah hostname atau tujuan tunnel WebDAV. Jika tunnel dikelola dari
dashboard Cloudflare, tidak perlu membuat `/etc/cloudflared/config.yml` lokal.

Kemudian pada browser:

1. Buka `https://panel.nifserver.cloud/login` dan login ulang.
2. Pastikan halaman dashboard dan menu Hosting dapat dibuka.
3. Buka **Hosting > nama aplikasi > Database**.
4. Klik **Buat database MySQL** jika aplikasi belum memiliki database dan
   provisioning MySQL pada langkah 5 sudah siap.
5. Klik **Buka phpMyAdmin** untuk database MySQL yang dibuat dashboard.
6. Setelah selesai, logout dashboard lalu refresh phpMyAdmin; akses berikutnya
   harus ditolak.

Tab Database ada pada detail **aplikasi yang di-host**, bukan pada halaman utama
monitoring server. Jika belum ada aplikasi, buat lewat form pembuatan aplikasi pada halaman **Hosting**.
Untuk Laravel, gunakan tombol **Migrate Laravel** setelah deploy atau atur migrasi
otomatis sebelum deploy. Rollback kode tidak membatalkan perubahan schema database.

## 8. Troubleshooting berdasarkan gejala

### Port 8088 tidak dapat dihubungi

```bash
sudo ss -ltnp | grep ':8088'
sudo apache2ctl configtest
ls -l /etc/apache2/conf-enabled/nifserver-panel.conf
```

Periksa output installer. Konfigurasi mungkin belum diaktifkan atau dipulihkan
setelah pemeriksaan gagal. Tetap gunakan tunnel port 3000 sampai 8088 siap.

### Bad Gateway setelah mengganti Service URL

Kembalikan sementara Service URL panel ke `http://127.0.0.1:3000` untuk memulihkan
akses dashboard. phpMyAdmin tidak tersedia melalui jalur langsung ke 3000.
Periksa port 8088 dan log cloudflared:

```bash
sudo journalctl -u cloudflared --since "5 minutes ago" --no-pager -n 40
```

### 404 pada phpMyAdmin

Pastikan hostname panel mengarah ke 8088, bukan langsung ke Next.js 3000. Buka
phpMyAdmin dari tombol di tab Database dan periksa URL pada browser.

### Unauthorized setelah login

Login ulang pada **hostname yang sama**. Pada browser yang sama, buka:

```text
https://panel.nifserver.cloud/api/v1/auth/me
```

Jika API mengembalikan 401, sesi dashboard belum valid. Jika API menunjukkan
sudah login tetapi phpMyAdmin masih 401, periksa log Apache dan program pemeriksaan
sesi; jangan menonaktifkan proteksi untuk melewati masalah tersebut.

### getcwd / HTTP 503 / service bermasalah

```bash
cd /
cd /opt/nifserver
systemctl status nifserver-backend nifserver-frontend apache2 php8.3-fpm --no-pager
sudo journalctl -u nifserver-backend -u nifserver-frontend -n 60 --no-pager
sudo tail -n 50 /var/log/apache2/nifserver-panel-error.log
```

Installer terbaru menunggu layanan siap setelah restart. Jika tetap 503, cari
endpoint yang gagal pada pesan installer. Jangan menganggap peringatan `AH00558`
tentang ServerName global sebagai penyebab tunggal: gunakan hasil configtest dan
log request untuk diagnosis.

## 9. Update dan pemulihan berikutnya

- Setiap rilis: commit/push dari komputer, lalu jalankan updater pada langkah 3.
- Jika runtime Hosting berubah: jalankan ulang langkah 4.
- Jika konfigurasi Apache/phpMyAdmin berubah: jalankan ulang langkah 6.
- Backup updater ada di `/var/backups/nifserver/`; backup installer phpMyAdmin
  ada di `/var/backups/nifserver-phpmyadmin/`.
- Backup updater bukan backup lengkap database atau data aplikasi. Backup MySQL,
  `/srv/nifhost`, dan state aplikasi perlu dilakukan secara terpisah.
- Jika kode bermasalah setelah rilis, ikuti prosedur
  [rollback dashboard](docs/DEPLOYMENT-GITHUB.md#5-rollback).

Referensi konfigurasi yang digunakan:
[unit backend](deploy/nifserver-backend.service),
[unit frontend](deploy/nifserver-frontend.service),
[updater](deploy/update-nifserver.sh),
[panduan Apache/phpMyAdmin](deploy/phpmyadmin/README.md).
