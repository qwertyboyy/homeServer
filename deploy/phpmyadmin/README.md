# Setup Apache + phpMyAdmin ? Ubuntu 24.04

Untuk server dengan Apache/WebDAV aktif di `127.0.0.1:8080`, Next.js dashboard
pada port 3000, API pada 3001, dan Cloudflare Tunnel langsung ke 3000.
Installer default sekarang memakai **Apache**, tanpa memasang Nginx.

## Jalankan setelah commit/push perubahan ini

Di server:

```bash
sudo bash /opt/nifserver/deploy/update-nifserver.sh
sudo bash /opt/nifserver/deploy/phpmyadmin/install.sh
```

Installer harus menampilkan selesai. Jika gagal, jangan ubah Service URL tunnel;
kirim pesan error tanpa cookie, password atau key. Installer menolak konflik port
8088 dan alias phpMyAdmin global yang dapat membuka pintu masuk di luar panel.

Installer memasang phpMyAdmin dan PHP 8.3 FPM melalui apt, menambahkan
`/etc/apache2/conf-available/nifserver-panel.conf`, lalu mengaktifkan modul proxy,
proxy_http, proxy_fcgi, rewrite, headers, setenvif, alias, dir, env. Handler PHP hanya
dipakai dalam vhost panel. Tidak mengganti `webdav.conf`, `000-default.conf`, port
8080, atau konfigurasi tunnel. Apache di-reload agar vhost tambahan berlaku.
Backup file yang diubah ada di `/var/backups/nifserver-phpmyadmin/*-apache/`.
Jika validasi/configtest/smoke test gagal, file yang ditargetkan dipulihkan. Paket,
modul yang telah diaktifkan, dan folder sesi PHP tetap terpasang.

Jika installer mendeteksi alias phpMyAdmin global, nonaktifkan alias itu dahulu:

```bash
sudo a2disconf phpmyadmin
sudo apache2ctl configtest
sudo systemctl reload apache2
```

## Verifikasi sebelum mengubah Cloudflare

```bash
sudo apache2ctl configtest
curl -I http://127.0.0.1:8088/login
curl http://127.0.0.1:8088/api/v1/health
curl -I http://127.0.0.1:8088/phpmyadmin/
```

Hasil: login 200, health JSON sukses, phpMyAdmin **401** tanpa cookie dashboard.
Installer juga memeriksa PHP, signon, dan aset statis menolak akses tanpa cookie.
Lalu di Cloudflare Tunnel, pada hostname dashboard yang sudah ada, ubah:

```text
Service URL lama: http://127.0.0.1:3000
Service URL baru: http://127.0.0.1:8088
```

Tidak perlu DNS baru, port publik baru, atau perubahan hostname WebDAV. Port 8088
hanya mendengarkan loopback. Jika perlu mengembalikan jalur dashboard, arahkan
Service URL ke 3000; phpMyAdmin akan tidak tersedia melalui jalur tersebut.

## Menu dan alur akses

Login ulang setelah backend restart. Buka **Hosting ? nama aplikasi ? Database**.
Buat database MySQL melalui dashboard bila belum ada, lalu klik **Buka phpMyAdmin**.
URL tetap pada domain dashboard, misalnya `/phpmyadmin/`. Database manual belum
didukung untuk mencegah pemakaian akun root/admin melalui bridge.

Apache memeriksa sesi dashboard pada setiap request phpMyAdmin memakai RewriteMap
program Python yang berjalan sebagai www-data. Program meminta `/api/v1/auth/me`
melalui loopback dan hanya menerima status 200; tanpa cache, timeout/error ditolak.
Program map menserialkan pemeriksaan sesi, sesuai untuk panel admin kecil. Bila
backend tidak merespons, pemeriksaan dibatasi timeout 2 detik.

Signon PHP meminta akun/password aplikasi melalui endpoint backend yang memerlukan
sesi dashboard **dan** key bridge. Password tidak diberikan kepada browser. Sesi
phpMyAdmin disimpan di `/var/lib/phpmyadmin/nifhost-sessions` (www-data 0700).
Key di `/etc/phpmyadmin/nifhost-bridge.key` (root:www-data 0640), dan salinannya di
`PHPMYADMIN_BRIDGE_KEY` dalam `/etc/nifserver/nifserver.env`. Jangan menjalankan kode
aplikasi tidak terpercaya sebagai www-data; hosted apps memakai user systemd
terisolasi. User database tetap dibatasi hak MySQL per aplikasi.

Logout dashboard atau sesi kedaluwarsa menolak request phpMyAdmin berikutnya.
Membuka aplikasi lain mengganti akun phpMyAdmin pada browser yang sama: periksa
nama database sebelum menjalankan SQL. Setelah reset password, buka lagi dari tab
Database. Batas impor Apache 32 MB; PHP dapat menerapkan batas lebih rendah melalui
`upload_max_filesize`/`post_max_size` di `/etc/php/8.3/fpm/php.ini`.

## Troubleshooting

- 404 dari domain panel: pastikan tunnel menuju **8088**, bukan 3000.
- 401: login ulang dashboard pada hostname yang sama, kemudian buka dari tab Database.
- 403 saat signon: cek database terkelola, env aktif, dan key bridge; jangan kirim key.
- 503 pada PHP: `systemctl status php8.3-fpm` dan socket `/run/php/php8.3-fpm.sock`.
- Log: `sudo tail -n 50 /var/log/apache2/nifserver-panel-error.log`.
- AH00558 tentang ServerName global bukan penyebab 404; vhost baru memiliki ServerName.

Nonaktifkan akses: set `PHPMYADMIN_ENABLED=false`, restart backend, jalankan
`sudo a2disconf nifserver-panel`, configtest lalu reload Apache. Kembalikan tunnel
ke port 3000 terlebih dahulu agar dashboard tetap dapat diakses.

Untuk server yang memang menggunakan Nginx, installer lama tetap tersedia sebagai
`install-nginx.sh`, dengan petunjuk di [README-nginx.md](README-nginx.md).

## Validasi lokal

```bash
python -m unittest discover -s deploy/phpmyadmin/tests -v
bash -n deploy/phpmyadmin/install.sh
php -l deploy/phpmyadmin/signon.php
php -l deploy/phpmyadmin/config.inc.php
```

Validasi apt, PHP-FPM dan configtest final dilakukan installer pada Ubuntu server.
Referensi Apache: https://httpd.apache.org/docs/2.4/rewrite/rewritemap.html dan
https://httpd.apache.org/docs/2.4/mod/mod_proxy.html#proxypass.
