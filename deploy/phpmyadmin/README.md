# phpMyAdmin melalui dashboard (Ubuntu 24.04)

Akses: `https://panel.nifserver.cloud/phpmyadmin/` melalui Nginx dashboard, bukan
subdomain database tersendiri. Cloudflare Tunnel harus mengarah ke Nginx panel
(port 8088), bukan langsung ke Next.js 3000. Kebijakan Cloudflare Access pada
hostname panel juga melindungi path ini bila cakupannya seluruh hostname.

## Pasang setelah update kode dashboard

```bash
sudo bash /opt/nifserver/deploy/update-nifserver.sh
sudo bash /opt/nifserver/deploy/phpmyadmin/install.sh
```

Argumen opsional adalah path konfigurasi Nginx panel yang sebenarnya:

```bash
sudo bash /opt/nifserver/deploy/phpmyadmin/install.sh /etc/nginx/sites-available/nifserver-panel
```

Installer untuk Ubuntu 24.04 memasang phpMyAdmin dari apt, PHP 8.3 FPM dan extension,
tanpa konfigurasi Apache/dbconfig. Installer memasang vhost loopback 127.0.0.1:8091,
menambahkan include ke blok server panel, menyiapkan key bridge, mengaktifkan env,
memvalidasi PHP/Nginx, restart backend dan reload Nginx. Port 8091 harus tersedia.
Panel harus memakai `$nif_forwarded_proto` seperti `deploy/nginx-nifserver.conf`.
Backup panel/env ada di `/var/backups/nifserver-phpmyadmin/` (root-only).
Tidak perlu membuka port firewall atau menambahkan DNS baru.

Jika alias phpMyAdmin Apache sudah aktif, installer berhenti; nonaktifkan alias
tersebut agar tidak ada pintu masuk lain di luar pemeriksaan sesi dashboard:

```bash
sudo a2disconf phpmyadmin
sudo systemctl reload apache2
```

Jangan menyalin konfigurasi Nginx panel secara keseluruhan untuk mengganti konfigurasi
lokal: installer hanya menambahkan include. Jika terdapat beberapa blok server dalam
file panel, periksa bahwa include dipasang pada blok yang dipakai untuk dashboard.

## Pemakaian

Login ulang dashboard setelah restart backend. Buka Hosting ? aplikasi ? Database ?
**Buka phpMyAdmin**. Hanya database MySQL terkelola (dibuat dashboard) yang didukung.
Database manual tidak boleh dipakai untuk menyelundupkan akun root/admin.
Tombol melakukan signon sebagai user aplikasi. PHP meminta password melalui loopback
ke API memakai sesi dashboard dan key bridge; password tidak berada dalam URL,
HTML, JavaScript, respons API yang dapat diakses browser, atau log akses.
Sesi signon disimpan server-side oleh PHP. Setiap request phpMyAdmin, termasuk aset
dan impor/ekspor, memeriksa sesi dashboard melalui Nginx auth_request.
Logout atau kedaluwarsa sesi dashboard memblokir request berikutnya. Halaman yang
sudah terbuka harus ditutup bila selesai. Backend restart mengharuskan login ulang.

Saat membuka aplikasi lain, sesi phpMyAdmin tab sebelumnya juga berganti akun:
satu akun aktif per browser. Periksa nama database sebelum menjalankan SQL.
Setelah reset password database, buka kembali phpMyAdmin dari dashboard.
Batas impor 32 MB di Nginx; PHP bisa menerapkan batas lebih kecil. Ubah
`upload_max_filesize` dan `post_max_size` di `/etc/php/8.3/fpm/php.ini` jika diperlukan,
lalu reload php8.3-fpm. Tidak ada akses ke kredensial nifhost_admin melalui bridge.

Key bridge: `/etc/phpmyadmin/nifhost-bridge.key` (root:www-data 0640), disalin installer
ke `PHPMYADMIN_BRIDGE_KEY` di `/etc/nifserver/nifserver.env`. Semua proses PHP yang
berjalan sebagai www-data berada dalam boundary kepercayaan bridge ini. Hosted apps
harus tetap memakai user systemd terisolasi. Jangan menjalankan kode tidak terpercaya
sebagai www-data. Key saja tidak cukup: endpoint API juga memerlukan sesi dashboard.

## Verifikasi di server

```bash
sudo nginx -t
systemctl is-active php8.3-fpm nifserver-backend nginx
curl -I http://127.0.0.1:8091/phpmyadmin/
curl -I http://127.0.0.1:8088/phpmyadmin/
```

Kedua curl tanpa cookie harus menghasilkan **401**. Setelah login, tombol harus
membuka database aplikasi yang tepat. Uji buat tabel sementara, ekspor, lalu hapus
tabelnya; logout dashboard lalu refresh phpMyAdmin harus ditolak. Jangan kirim cookie,
password atau bridge key ke chat.

Jika 404 dari tombol: periksa target tunnel dan include Nginx. Jika 502: periksa
`systemctl status php8.3-fpm` dan socket `/run/php/php8.3-fpm.sock`. Jika akses signon
ditolak: cek env aktif, login ulang, dan pastikan database dikelola dashboard.

Untuk menonaktifkan: set `PHPMYADMIN_ENABLED=false`, restart backend, hapus include
phpMyAdmin dari blok panel dan hapus `/etc/nginx/conf.d/nifhost-phpmyadmin.conf`,
kemudian `sudo nginx -t` dan reload Nginx. Jangan hapus database aplikasi.

Referensi implementasi signon:
https://docs.phpmyadmin.net/en/latest/config.html#cfg_Servers_SignonSession
https://github.com/phpmyadmin/phpmyadmin/blob/RELEASE_5_2_2/examples/signon.php
