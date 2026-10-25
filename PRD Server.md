# PRD — NIFSERVER Dashboard

**Versi:** 1.0  
**Status:** Draft untuk implementasi  
**Platform:** Web responsif  
**Target deployment:** Ubuntu Server LTS, laptop Intel Core i3, RAM 4 GB, HDD 500 GB

---

## 1. Ringkasan Produk

NIFSERVER Dashboard adalah panel web pribadi untuk memantau dan mengelola home server Ubuntu dari jaringan lokal maupun luar rumah. Dashboard menyajikan kondisi sistem, status layanan, kapasitas penyimpanan, aplikasi yang di-host, serta menyediakan fondasi untuk fitur AI dan automation pada tahap berikutnya.

Produk harus ringan, aman, mudah dirawat, dan tidak mengganggu layanan yang sudah berjalan: Cloudflare Tunnel, Apache WebDAV/RaiDrive, Samba, SSH, dan Netdata.

## 2. Tujuan

1. Menyediakan satu dashboard untuk melihat kesehatan server.
2. Menampilkan metrik CPU, RAM, swap, disk, jaringan, suhu, dan uptime.
3. Menampilkan status service penting dengan pembaruan berkala.
4. Memberikan pintasan ke layanan server tanpa membuka port internal ke internet.
5. Mendukung akses dari LAN dan luar rumah dengan autentikasi berlapis.
6. Menjadi fondasi bagi manajemen aplikasi, notifikasi, backup, AI, dan automation.

## 3. Bukan Tujuan MVP

Fitur berikut tidak masuk MVP awal:
- Menjalankan perintah shell bebas dari browser.
- Terminal web interaktif.
- Mengubah firewall, DNS, atau konfigurasi Cloudflare dari dashboard.
- Pengelolaan file penuh; file sharing tetap menggunakan WebDAV/RaiDrive dan Samba.
- Menjalankan model AI secara lokal.
- Kubernetes, Proxmox, atau orkestrasi container.
- Multi-user/role kompleks; MVP cukup satu administrator, tetapi desain harus memungkinkan perluasan.
- Otomatis restart semua service yang gagal tanpa persetujuan.

## 4. Pengguna dan Akses

### Pengguna MVP
- **Administrator:** pemilik home server; dapat melihat monitoring dan mengakses fitur admin yang diizinkan.

### Kanal akses
- **LAN:** akses dari perangkat pada jaringan rumah.
- **Remote:** akses melalui hostname khusus, misalnya `panel.nifserver.cloud`, menggunakan Cloudflare Tunnel dan Cloudflare Access.

### Aturan keamanan
- Dashboard tidak boleh dibuka ke internet tanpa autentikasi.
- Port frontend/API/Netdata tidak boleh dipublikasikan langsung melalui router.
- Backend API dan Netdata hanya boleh diakses secara lokal, kecuali ada kebutuhan terverifikasi.
- Jangan mengubah hostname tunnel yang sudah digunakan `drive.nifserver.cloud`.
- Password/token/secret tidak boleh ditulis ke Git atau log.
- API tidak menyediakan endpoint untuk menjalankan perintah shell arbitrary.
- Aksi administratif menggunakan allowlist service/action, validasi input, autentikasi, dan pencatatan audit.
- Terapkan least privilege; jangan menjalankan seluruh backend sebagai root.
- Gunakan HTTPS pada akses remote dan cookie sesi `HttpOnly`, `Secure` (remote), dan `SameSite`.
- Batasi request login dan endpoint sensitif; validasi semua input.

## 5. Arsitektur Teknis

### Stack
- **Frontend:** Next.js (App Router) + TypeScript + Tailwind CSS.
- **UI:** komponen reusable; desain responsif desktop dan mobile.
- **Charts:** library grafik ringan yang kompatibel dengan React; hindari bundle berlebihan.
- **Backend:** Node.js + Express + TypeScript (API terpisah).
- **Monitoring:** Netdata Agent sebagai sumber metrik dan histori yang tersedia.
- **Data host:** baca metrik OS melalui library/proses terkontrol dan file `/proc`; gunakan `systemctl` hanya untuk daftar service yang diizinkan.
- **Reverse proxy:** Nginx lokal bila diperlukan untuk merutekan hostname ke frontend/API.
- **Process management:** systemd units untuk frontend dan backend.
- **Database MVP:** tidak wajib. Simpan konfigurasi non-rahasia dengan file konfigurasi; untuk pengguna, audit, atau riwayat jangka panjang, pertimbangkan SQLite pada tahap selanjutnya.
- **Remote access:** Cloudflare Tunnel + Cloudflare Access.
- **Deployment:** native di Ubuntu untuk menjaga overhead rendah; tidak mewajibkan Docker.

### Arsitektur request
1. Browser mengakses dashboard melalui LAN atau hostname remote.
2. Untuk akses remote, Cloudflare Access mengautentikasi pengguna sebelum request mencapai aplikasi.
3. Reverse proxy lokal merutekan request ke Next.js.
4. Frontend meminta data ke backend API.
5. Backend mengambil metrik yang diperlukan dari Netdata dan sistem Ubuntu.
6. Backend mengembalikan JSON yang tervalidasi dan hanya berisi informasi yang diperlukan.

### Prinsip deployment
- Pertahankan konfigurasi Cloudflare Tunnel, Apache WebDAV, Samba, SSH, dan Netdata yang sudah ada.
- Gunakan port internal yang belum dipakai, verifikasi dengan `ss -ltnp` sebelum menetapkan port.
- Jangan menimpa file konfigurasi yang sudah ada tanpa backup dan pemeriksaan.
- Hindari menjalankan dua layanan pada port yang sama.
- Semua perubahan firewall harus dibatasi ke sumber dan port yang diperlukan.

## 6. Modul dan Fitur

### 6.1 Authentication
**MVP**
- Halaman login administrator.
- Sesi aman; password disimpan dalam bentuk hash menggunakan algoritma yang sesuai (misalnya Argon2id atau bcrypt).
- Logout dan masa berlaku sesi.
- Rate limit untuk percobaan login.
- Tidak ada kredensial default yang dibiarkan aktif setelah setup.

**Acceptance criteria**
- Pengguna yang belum login tidak dapat membaca data dashboard.
- Sesi berakhir sesuai konfigurasi.
- Password tidak pernah dikirim kembali atau ditulis ke log.

> Untuk akses remote, Cloudflare Access tetap digunakan sebagai lapisan tambahan, bukan pengganti autentikasi aplikasi.

### 6.2 Overview Dashboard
Menampilkan:
- Status server (online jika API merespons).
- Uptime dan waktu sistem.
- CPU utilization dan load average.
- RAM total, terpakai, tersedia, dan persentase.
- Swap total dan terpakai.
- Kapasitas disk root: total, terpakai, tersedia, persentase.
- Suhu CPU package/core bila sensor tersedia.
- Trafik jaringan masuk/keluar bila dapat dibaca.
- Status layanan penting.

**Acceptance criteria**
- Metrik ditampilkan dengan satuan yang jelas.
- Nilai yang tidak tersedia tampil sebagai `N/A`, bukan angka palsu.
- Data dashboard diperbarui tanpa reload halaman penuh.
- Timestamp pembaruan terakhir terlihat.
- UI menampilkan indikator loading dan error.

### 6.3 Monitoring
- Grafik CPU, RAM, swap, disk I/O, network, dan suhu jika tersedia.
- Mengambil metrik dari Netdata API; jangan membuat sistem histori baru di MVP.
- Interval polling awal 5–10 detik untuk kartu ringkasan; grafik mengikuti kemampuan API dan kebutuhan performa.
- Jika Netdata tidak tersedia, tampilkan status sumber data gagal tanpa membuat dashboard keseluruhan crash.

**Acceptance criteria**
- Dashboard tetap dapat digunakan ketika satu metrik gagal.
- Polling berhenti atau melambat ketika tab tidak aktif bila memungkinkan.
- Tidak ada polling berlebihan yang membebani RAM/CPU server.

### 6.4 Service Health
Service yang dipantau awal:
- `netdata`
- `apache2`
- `cloudflared`
- `smbd`
- `ssh`

Data:
- Status `active`, `inactive`, `failed`, atau `unknown`.
- Waktu pemeriksaan terakhir.
- Keterangan error ringkas bila tersedia dan aman.

**Acceptance criteria**
- Nama service berasal dari allowlist konfigurasi, bukan input bebas.
- Status diperbarui secara berkala.
- Endpoint read-only tidak mengubah service.

### 6.5 Storage & File Services
- Informasi disk root dan kapasitas penyimpanan.
- Informasi path `/srv/shared` bila dapat dibaca.
- Status Apache WebDAV dan Samba.
- Pintasan ke layanan yang telah dikonfigurasi.
- Tidak menampilkan daftar file lengkap atau kredensial WebDAV.

### 6.6 Applications
- Daftar aplikasi/website yang dikonfigurasi administrator.
- Nama, hostname, status pemeriksaan, dan deskripsi.
- Tombol membuka URL layanan di tab baru.
- Pemeriksaan health endpoint bersifat opsional dan hanya untuk URL yang telah di-allowlist.
- Tidak melakukan port scanning.

### 6.7 Logs
- MVP hanya menampilkan ringkasan event aplikasi dan status service yang sudah disaring.
- Jangan membuka endpoint yang bisa membaca sembarang file log atau path.
- Detail log hanya dapat dibaca dari file/path yang sudah di-allowlist.
- Hindari menyimpan token, password, cookie, dan data sensitif.

### 6.8 AI & Automation — Tahap lanjutan
- Integrasi API DeepSeek atau provider lain melalui backend.
- Secret API disimpan dalam environment file dengan izin terbatas; tidak pernah dikirim ke frontend.
- Jadwal automation, hasil run, status, dan riwayat.
- Bot WhatsApp hanya setelah mempertimbangkan metode integrasi, biaya, serta kebijakan platform.
- AI tidak boleh mengeksekusi perintah server tanpa allowlist, persetujuan yang sesuai, dan audit log.

### 6.9 Notifications — Tahap lanjutan
- Kondisi disk hampir penuh.
- Service kritis tidak aktif.
- Suhu CPU melewati ambang yang dapat dikonfigurasi.
- RAM/swap kritis.
- Channel notifikasi dapat ditambahkan belakangan (mis. Telegram/email/WhatsApp) setelah rahasia dan aksesnya diatur aman.

## 7. UI/UX

### Arah desain
- Nama produk: **NIFSERVER**.
- Gaya: clean, modern, utilitarian, dashboard admin.
- Default dark theme, dengan kontras yang memenuhi aksesibilitas.
- Sidebar desktop dan navigation drawer pada mobile.
- Status menggunakan label teks dan ikon; jangan hanya mengandalkan warna.
- Kartu metrik ringkas, grafik dengan tooltip, unit yang jelas.
- Loading skeleton, empty state, error state, dan last-updated timestamp.
- Layout mobile tidak boleh memerlukan scroll horizontal.

### Navigasi
1. Overview
2. Monitoring
3. Services
4. Storage
5. Applications
6. Logs
7. AI & Automation (tampilkan sebagai tahap berikutnya/placeholder nonaktif sampai diimplementasikan)
8. Settings

### Halaman Overview
- Header: NIFSERVER, status online/offline, uptime, waktu pembaruan.
- Kartu: CPU, RAM, suhu, storage.
- Grafik: CPU dan RAM.
- Daftar service dengan status.
- Ringkasan storage dan shortcut aplikasi.
- Link menuju halaman Monitoring detail.

## 8. API Contract Awal

Prefix: `/api/v1`

### Read-only endpoints
- `GET /health` — status backend.
- `GET /system/summary` — uptime, load, CPU, RAM, swap, disk, suhu, network.
- `GET /services` — status service dari allowlist.
- `GET /storage` — disk dan path yang diizinkan.
- `GET /metrics/cpu` — data CPU dari Netdata.
- `GET /metrics/memory` — data memori dari Netdata.
- `GET /metrics/network` — data jaringan dari Netdata.
- `GET /applications` — aplikasi dari konfigurasi.
- `GET /events` — event terpilih yang aman.

### Rules
- Semua endpoint selain health check internal harus memerlukan sesi autentikasi.
- Gunakan skema JSON konsisten: `{ "data": ..., "timestamp": "...", "error": null }`.
- Untuk error, gunakan HTTP status yang sesuai dan pesan publik tanpa stack trace.
- Terapkan timeout untuk request ke Netdata.
- Jangan mengembalikan environment variables, file konfigurasi rahasia, atau output shell mentah.
- Endpoint action (restart/start/stop service) bukan bagian dari MVP.

## 9. Data dan Konfigurasi

- Gunakan `.env` lokal yang tidak masuk Git.
- Sediakan `.env.example` tanpa nilai rahasia.
- Validasi environment saat aplikasi startup.
- Konfigurasi service dan aplikasi menggunakan file terstruktur yang tervalidasi.
- Jangan menyimpan password plaintext.
- Jika memakai SQLite pada tahap berikutnya, batasi file database ke user aplikasi dan buat backup.
- Jangan menggunakan `/srv/shared` sebagai direktori kode atau menyimpan secret di folder sharing.

## 10. Non-Functional Requirements

### Performance
- Frontend responsif pada laptop dan HP.
- Target render awal dashboard < 3 detik pada LAN pada perangkat wajar, dengan asumsi build production.
- Polling kartu ringkasan setiap 5–10 detik.
- Backend tidak menjalankan subprocess berulang secara agresif.
- Hindari library besar yang tidak diperlukan.
- Sasaran penggunaan idle tambahan rendah; ukur setelah deployment dan sesuaikan polling. Jangan menganggap angka RAM/CPU sebagai jaminan sebelum diukur.

### Reliability
- Aplikasi berjalan di bawah `systemd`.
- Restart otomatis bila proses crash dengan batas restart yang wajar.
- Log dapat dibaca melalui `journalctl`.
- Error pada Netdata tidak membuat seluruh UI gagal.
- Konfigurasi lama dibuat backup sebelum perubahan.

### Security
- Akses remote dilindungi Cloudflare Access dan autentikasi aplikasi.
- API bind ke loopback atau jaringan internal yang dibutuhkan saja.
- Jangan mengekspos port `3000`, `3001`, atau `19999` langsung ke internet.
- Gunakan HTTPS untuk remote.
- Validasi input, rate limit, dan audit aksi administratif.
- Least privilege untuk user service; hindari menjalankan aplikasi sebagai root.
- Jangan menyediakan command execution bebas.
- Gunakan allowlist untuk service dan aplikasi.
- Lindungi CSRF jika memakai cookie sesi dan endpoint mutasi pada tahap lanjut.
- Terapkan dependency updates secara terencana.

## 11. Testing

### Functional
- Login berhasil dan gagal.
- Data CPU/RAM/disk tampil dan terbarui.
- Status kelima service sesuai `systemctl`.
- Sensor suhu `N/A` ditangani dengan benar.
- Dashboard tetap bekerja jika Netdata tidak tersedia.
- Pintasan aplikasi membuka tujuan yang benar.
- Logout menutup akses sesi.

### Security
- Endpoint privat menolak request tanpa sesi.
- Endpoint tidak menerima nama service bebas untuk tindakan sistem.
- Secret tidak terlihat di browser atau log.
- Port internal tidak dapat diakses dari internet.
- Akses remote tanpa Cloudflare Access ditolak.
- Rate limit login berfungsi.

### Operational
- Frontend/backend hidup setelah reboot.
- Restart otomatis setelah crash.
- Log bisa diperiksa lewat `journalctl`.
- Layanan WebDAV, Samba, SSH, dan Cloudflare Tunnel tetap berfungsi setelah deployment.

## 12. Deployment dan Struktur Proyek

Lokasi yang disarankan: `/opt/nifserver/`

```text
/opt/nifserver/
├── frontend/             # Next.js + Tailwind
├── backend/              # Express + TypeScript
├── config/
│   ├── applications.example.json
│   └── services.json
├── .env.example
└── README.md
```

Environment secrets disimpan terpisah dari Git dan tidak di dalam direktori publik. Buat user service khusus bila memungkinkan. `systemd` unit harus memiliki working directory, user, environment file, restart policy, dan batas akses yang sesuai.

Sebelum deployment:
1. Verifikasi port dengan `ss -ltnp`.
2. Backup konfigurasi yang akan diubah.
3. Build aplikasi production.
4. Uji frontend dan API di localhost.
5. Uji dashboard dari LAN.
6. Konfigurasikan hostname Cloudflare baru dan Cloudflare Access.
7. Uji dari jaringan luar rumah.
8. Pastikan WebDAV/RaiDrive, Samba, SSH, dan tunnel lama tidak terganggu.

## 13. Acceptance Criteria MVP

MVP dianggap selesai jika:
- [ ] Administrator bisa login dan logout.
- [ ] Overview menampilkan CPU, RAM, swap, storage, suhu, dan uptime.
- [ ] Nilai yang tidak tersedia ditampilkan sebagai `N/A`.
- [ ] Lima service utama menunjukkan status yang benar.
- [ ] Grafik monitoring mengambil data dari Netdata.
- [ ] Data diperbarui berkala tanpa reload penuh.
- [ ] Dashboard dapat dibuka melalui LAN.
- [ ] Akses luar rumah melalui Cloudflare Tunnel dan Cloudflare Access berfungsi.
- [ ] Port internal tidak terekspos langsung ke internet.
- [ ] Aplikasi berjalan melalui `systemd` setelah reboot.
- [ ] Layanan WebDAV, Samba, SSH, dan Cloudflare Tunnel yang sudah ada tetap berfungsi.
- [ ] Tidak ada fitur eksekusi shell bebas.

## 14. Urutan Implementasi untuk Coding Agent

1. Audit lingkungan: versi Node/npm, OS, port, service, direktori, dan konfigurasi tunnel yang sudah ada. Jangan mengubah konfigurasi pada tahap audit.
2. Inisialisasi frontend Next.js App Router + TypeScript + Tailwind.
3. Buat UI statis responsif dengan data mock yang diberi label jelas.
4. Inisialisasi backend Express + TypeScript.
5. Implementasikan autentikasi dan validasi konfigurasi.
6. Implementasikan endpoint summary, service, storage, dan metrics.
7. Hubungkan Netdata API dengan timeout dan error handling.
8. Ganti data mock dengan data nyata dan tambahkan polling.
9. Tambahkan tests untuk API dan UI.
10. Buat `systemd` units dan deploy di localhost.
11. Uji LAN.
12. Baru tambahkan hostname Cloudflare dan Cloudflare Access.
13. Verifikasi semua layanan lama tetap aktif.
14. Dokumentasikan instalasi, konfigurasi, backup, troubleshooting, dan rollback.

**Aturan untuk coding agent:** Jangan menjalankan perubahan destruktif, jangan menimpa file konfigurasi yang ada, jangan membuka port internet, dan jangan mengubah tunnel `drive.nifserver.cloud`. Laporkan setiap asumsi, port yang dipilih, file yang diubah, dan perintah yang membutuhkan `sudo`.
