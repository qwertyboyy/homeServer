# Alur Dashboard Server dan Panduan Hosting untuk Project Lain

Dokumen ini menjelaskan cara kerja NIFSERVER Dashboard, fasilitas yang tersedia, dan cara project lain dapat di-host melalui dashboard. Salin dokumen ini ke project apa pun sebagai referensi pengembang atau agen coding sebelum menyiapkan deployment.

Panduan disusun dari kode dashboard dan dokumentasi hosting pada 4 November 2026. Domain dan nama aplikasi di bawah adalah contoh; sesuaikan dengan server tujuan. Keberadaan fitur di kode tidak memastikan prasyaratnya sudah terpasang pada server aktif.

## 1. Fungsi dan alur utama dashboard

Dashboard memiliki dua fungsi utama: memantau server dan mengelola aplikasi hosting.

### Monitoring server

```text
Administrator membuka dashboard
  -> login dan mendapat sesi administrator
  -> frontend meminta data ke backend /api/v1
  -> backend membaca metrik sistem, status service, dan Netdata
  -> frontend menampilkan ringkasan, grafik, storage, aplikasi, dan event
```

Backend membaca CPU, RAM, swap, disk, suhu, dan jaringan dari sumber sistem. Status service dibaca dari daftar service yang diizinkan; grafik historis berasal dari Netdata. Data yang tidak tersedia ditampilkan sebagai N/A. Frontend melakukan polling dan menghentikannya saat tab tidak aktif.

Monitoring service sistem bersifat read-only. Dashboard bukan terminal web dan tidak menyediakan eksekusi shell bebas. Aksi start/stop/restart pada Hosting berlaku untuk aplikasi yang dikelola Hosting, bukan semua service server.

### Hosting aplikasi

```text
Administrator login
  -> membuka Hosting dan memeriksa prasyarat server
  -> membuat konfigurasi aplikasi
  -> mengatur sumber, runtime, domain, environment, database bila diperlukan
  -> mengunggah sumber atau memicu deploy GitHub
  -> dashboard memvalidasi dan menyiapkan rilis baru
  -> builder menjalankan build bila diperlukan
  -> dashboard mengaktifkan rilis dan melakukan health check
  -> gateway melayani domain aplikasi
```

Project yang di-host memiliki kode, dependency, environment, dan database sendiri. API `/api/v1` dashboard adalah API administrasi dashboard; project tidak otomatis mendapatkan API bisnis atau database dari endpoint tersebut.

### Komponen sistem

| Komponen | Peran |
| --- | --- |
| Frontend dashboard | Next.js; antarmuka administrator, default loopback port 3000 |
| Backend dashboard | Express; autentikasi, monitoring, administrasi Hosting; `/api/v1`, default loopback port 3001 |
| Nginx dashboard | Contoh pintu masuk dashboard pada port 8088; meneruskan UI dan API |
| Builder `nifbuild@<id>` | Menyiapkan dependency dan build aplikasi dalam sandbox |
| Runtime `nifapp@<id>` | Menjalankan aplikasi dinamis dengan user terisolasi |
| Gateway hosting | Default `127.0.0.1:8090`; memilih aplikasi berdasarkan hostname |
| Cloudflare Tunnel atau Caddy | Menghubungkan domain publik ke hosting sesuai konfigurasi server |

Port dashboard bukan alamat API project yang di-host. Aplikasi hosting mendapat domain dan, untuk proses dinamis, port internal yang dikelola dashboard.

### Prasyarat server dan mode simulasi

Hosting nyata memerlukan server Linux dengan komponen systemd, gateway, builder, runtime, dan izin yang sesuai. Dokumentasi instalasi menargetkan Ubuntu 24.04. PHP/Composer dan database server diperlukan hanya untuk runtime atau fitur terkait.

Di luar Linux atau ketika `MOCK_MODE=true`, Hosting berjalan sebagai simulasi: build dan service tidak benar-benar dijalankan. Periksa panel **Prasyarat server**; keberhasilan mencoba UI pada Windows tidak membuktikan aplikasi sudah online.

## 2. Memilih bentuk aplikasi yang akan di-host

Pelajari struktur project sebelum memilih runtime atau mengubah arsitektur.

| Kondisi project | Kebutuhan hosting |
| --- | --- |
| React dengan konten dari file atau data lokal | Satu aplikasi React/Vite; database tidak diperlukan |
| React dengan CMS atau layanan API eksternal | Satu aplikasi React/Vite dan konfigurasi URL layanan tersebut |
| React dengan backend Express/Laravel dan database sendiri | Aplikasi frontend dan backend terpisah; database dikonfigurasi pada backend |
| Next.js dengan API/server dalam project yang sama | Satu aplikasi Next.js dapat menangani frontend dan backend; database dipakai oleh kode server |

Project tanpa kebutuhan penyimpanan dinamis tidak harus mempunyai database. Jika sudah memakai Supabase, Firebase, atau CMS eksternal, periksa integrasi yang ada sebelum menggantinya.

## 3. Alur frontend, backend, dan database

```text
Browser pengunjung
  |
  +--> https://app.example.com
  |      Frontend React hasil build
  |
  +--> https://api.example.com/api/...
         Backend Node.js/Express atau Laravel
           |
           +--> Database di server
```

Contoh alur: frontend meminta data ke `GET /api/items`, backend membaca tabel database, lalu mengirim JSON untuk ditampilkan frontend. Endpoint dan tabel tersebut harus dibuat dalam project; dashboard tidak membuatnya secara otomatis.

Dashboard mengelola deploy, proses aplikasi, environment, domain, dan konfigurasi database. Kode autentikasi pengguna project, validasi input, API, serta schema database tetap menjadi tanggung jawab project. Login administrator dashboard tidak otomatis menjadi login pengguna aplikasi.

## 4. Pilihan hosting dan kontrak deploy

| Runtime | Sumber dan perilaku |
| --- | --- |
| Website statis (HTML/CSS/JS) | ZIP, folder, file, atau GitHub; file langsung disajikan tanpa build |
| React / Vite | ZIP source atau GitHub; instal dependency lalu `npm run build`; output default `dist` |
| Next.js | ZIP source atau GitHub; instal dependency, build, lalu `next start` |
| Node.js / Express / API | ZIP source atau GitHub; instal dependency, build jika ada, prune dev dependency, lalu jalankan file entry dengan `node` |
| Laravel | ZIP source atau GitHub; instal Composer production, build frontend jika ada script build; runtime PHP |
| PHP | ZIP source atau GitHub; Composer jika tersedia; runtime PHP |

Hosting JavaScript menggunakan npm. Sertakan `package-lock.json` agar dependency konsisten. Builder memiliki perintah tetap; jangan mengasumsikan ada kolom perintah build/start bebas atau dukungan Docker, pnpm, dan yarn.

Untuk upload source, letakkan `package.json` di root ZIP. Jangan bergantung pada deteksi folder pembungkus untuk source aplikasi. Jangan sertakan `node_modules`, `.git`, atau `.env`; dashboard membuangnya. Isi konfigurasi deployment melalui tab **Environment** dan **Database**.

Untuk monorepo, siapkan masing-masing sumber deploy dengan manifest dan file yang dibutuhkan pada root. Jangan mengasumsikan dashboard memiliki opsi working directory monorepo.

### Cara mengirim sumber aplikasi

| Cara | Bisa digunakan untuk | Alur |
| --- | --- | --- |
| Upload ZIP source | React/Vite, Next.js, Node.js, Laravel, PHP | Buat aplikasi, pilih runtime, unggah ZIP, lalu build dan aktivasi |
| Upload ZIP hasil build | Website statis | Unggah output HTML/CSS/JS yang sudah siap disajikan |
| Upload folder atau beberapa file | Website statis | File dikirim per file, struktur dipertahankan, lalu upload di-commit menjadi deployment |
| Upload satu `index.html` | Website statis sederhana | Unggah file, lalu gateway menyajikannya |
| Repository GitHub | Runtime yang didukung, termasuk statis | Simpan URL repo dan branch, lalu picu deployment manual |

Untuk situs statis, document root dideteksi dari `index.html` pada root, `dist`, `build`, atau satu subfolder proyek yang tidak ambigu hingga batas deteksi. Kandidat root yang ambigu atau tidak adanya `index.html` ditolak. Untuk source aplikasi dinamis, siapkan struktur root sesuai runtime.

Repository privat membutuhkan token deploy GitHub dengan akses read-only ke isi repository. Simpan melalui **Pengaturan → Token deploy GitHub**. Deployment GitHub bukan sinkronisasi folder langsung; perubahan repo baru berlaku setelah deploy dipicu.

## 5. Proses deployment di dalam dashboard

1. **Penerimaan sumber:** dashboard memeriksa ZIP atau menerima upload statis bertahap; untuk GitHub, builder mengambil repository yang diizinkan.
2. **Validasi:** path tidak aman, symlink, duplikat, upload berlebihan, atau arsip berbahaya ditolak. `.git`, `node_modules`, dan `.env*` dibuang, kecuali `.env.example`.
3. **Rilis baru:** deployment memakai direktori rilis terpisah sehingga rilis aktif tidak ditimpa.
4. **Build:** builder menjalankan perintah yang ditentukan runtime. Situs statis siap pakai melewati build.
5. **Pemeriksaan output:** dashboard memastikan file hasil yang diperlukan tersedia, misalnya `dist/index.html`, `.next/BUILD_ID`, atau entry Node.
6. **Migrasi opsional:** Laravel dapat menjalankan migrasi sebelum aktivasi jika diaktifkan. Kegagalan migrasi menggagalkan deploy.
7. **Aktivasi:** konfigurasi rilis, registry, dan routing diganti secara atomik; aplikasi dinamis direstart.
8. **Health check:** respons 2xx/3xx, atau 401/403 untuk aplikasi berlogin, diterima; 404/5xx gagal. Situs statis juga harus dilayani dari rilis yang benar.
9. **Hasil:** log dan status disimpan. Bila aktivasi gagal, dashboard mencoba mengembalikan rilis sebelumnya. Rilis aktif dan beberapa rilis terakhir disimpan untuk rollback.

Default penyimpanan hosting adalah `/srv/nifhost`: registry aplikasi, routing gateway, audit log, rilis per aplikasi, log build/deployment, dan secret. State persisten aplikasi berada terpisah dari source rilis, di `/var/lib/nifhost/<id>`.

Satu deployment berjalan pada satu waktu. Batas jumlah file, ukuran upload, ekstraksi, dan frekuensi deploy mengikuti konfigurasi server serta batas reverse proxy/Cloudflare di depan dashboard.

### Tab pada detail aplikasi

| Tab | Fungsi |
| --- | --- |
| Ringkasan | Status, informasi aplikasi, deploy, dan kontrol proses yang relevan |
| Deployment | Riwayat, log deploy, rilis, dan rollback |
| Domain | Daftar domain, status DNS/tunnel, sinkronisasi Cloudflare bila aktif |
| Environment | Variabel konfigurasi dan secret |
| Database | Konfigurasi koneksi, MySQL terkelola, migrasi Laravel, dan phpMyAdmin jika tersedia |
| Pengaturan | Pengaturan aplikasi, output/entry, health path, sumber, token GitHub, dan penghapusan |

## 6. Menyiapkan frontend React/Vite

Pastikan `package.json` mempunyai script build yang sesuai project, misalnya:

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  }
}
```

Pertahankan langkah TypeScript atau pemeriksaan lain jika sudah menjadi bagian script build project. Uji build lokal menggunakan `npm ci` lalu `npm run build`.

Jika frontend memakai backend sendiri, gunakan konfigurasi URL API, misalnya:

```js
const apiBaseUrl = import.meta.env.VITE_API_URL;
const response = await fetch(`${apiBaseUrl}/api/items`);
if (!response.ok) throw new Error("Gagal memuat data");
const items = await response.json();
```

Contoh nilai deployment: `VITE_API_URL=https://api.example.com`. Sesuaikan prefix `/api` dengan kontrak backend agar tidak terduplikasi. Jangan hardcode `localhost` untuk deployment publik.

Di dashboard:

1. Buka **Hosting → Aplikasi baru**.
2. Isi nama, ID, domain/subdomain, dan pilih runtime **React / Vite**.
3. Pilih upload ZIP source atau repository GitHub.
4. Isi **Folder output** sesuai hasil build: biasanya `dist`, atau `build` untuk Create React App.
5. Untuk mengisi environment sebelum deploy pertama, buat konfigurasi aplikasi tanpa memilih ZIP terlebih dahulu.
6. Buka tab **Environment**, tambahkan `VITE_API_URL` sebagai non-secret, dan simpan.
7. Upload ZIP di bagian Deploy pada **Ringkasan**, atau picu deploy GitHub.
8. Periksa tab **Deployment**, lalu buka domain dan uji navigasi serta refresh halaman bersarang.

Alternatif: build di laptop, pilih runtime **Website statis**, dan upload folder hasil build melalui pilihan **Folder**. Pada cara ini nilai environment frontend harus sudah tersedia saat build lokal; mengubah environment dashboard tidak mengubah JavaScript yang telah dibuild di laptop.

## 7. Menyiapkan backend Node.js/Express

Backend berjalan sebagai aplikasi Hosting terpisah dari React/Vite. Pilih runtime **Node.js / Express / API**.

Ketentuan backend:

- Dengarkan `process.env.PORT`; dashboard menentukan port secara otomatis.
- Bind ke `127.0.0.1`, sesuai runtime hosting.
- Sediakan file entry JavaScript, misalnya `server.js` atau hasil kompilasi `dist/server.js`.
- Isi **File entry** di dashboard bila entry dihasilkan oleh build atau tidak terdeteksi dari `package.json`.
- Letakkan dependency runtime, termasuk driver database, pada `dependencies`. Builder memangkas `devDependencies` setelah build.
- Sediakan endpoint health, misalnya `/health`, yang mengembalikan HTTP 200 saat aplikasi siap. Isi health path dashboard dengan path yang benar.
- Konfigurasikan CORS untuk origin frontend jika memakai domain frontend dan API terpisah. Nama environment seperti `FRONTEND_URL` harus dibaca dan diterapkan oleh kode backend sendiri.

Contoh bagian listen Express:

```js
app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));
app.listen(Number(process.env.PORT), "127.0.0.1");
```

Launcher Node menjalankan `node <file-entry>`, sehingga script `npm start` saja tidak cukup untuk menentukan proses production. TypeScript perlu dibuild ke JavaScript sebelum dijalankan.

Rilis aplikasi bersifat read-only. Jangan menyimpan upload pengunjung atau database file di folder source/rilis. Jika aplikasi menyimpan file, gunakan direktori state persisten yang disediakan runtime dan konfigurasikan kode untuk menggunakannya.

## 8. Database pada backend

Pilih aplikasi **backend** di Hosting, lalu buka tab **Database**.

### MySQL terkelola

1. Pastikan prasyarat MySQL server, client, dan konfigurasi admin hosting telah disiapkan administrator.
2. Isi **Nama database baru**, misalnya `portofolio`, lalu klik **Buat database MySQL**. Gunakan huruf kecil, angka, dan underscore, diawali huruf (maksimal 64 karakter). Administrator server perlu memberikan izin pada nama custom tersebut jika izin admin hosting masih terbatas pada prefix `nifdb`.
3. Dashboard membuat database, user, dan password aplikasi serta menyimpan konfigurasi koneksinya.
4. Sesuaikan kode backend agar membaca environment yang diberikan dashboard.
5. Buat schema menggunakan migrasi project atau impor SQL melalui phpMyAdmin bila tersedia.
6. Restart backend setelah perubahan konfigurasi koneksi atau reset password, lalu uji operasi baca/tulis.

Variabel koneksi yang dipakai dashboard antara lain:

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_DATABASE=<nama-database-dari-dashboard>
DB_USERNAME=<user-dari-dashboard>
DB_PASSWORD=<secret-yang-dikelola-dashboard>
```

Dashboard juga menyediakan `DB_CONNECTION` dan `DATABASE_URL` sesuai konfigurasi. Periksa format yang diharapkan driver/ORM project. Jika kode memakai nama seperti `MYSQL_USER`, petakan ke variabel dashboard atau sesuaikan kode; nama tersebut tidak otomatis menjadi alias `DB_USERNAME`.

### Database manual dan SQLite

Tab Database juga menyediakan konfigurasi koneksi manual MySQL/MariaDB/PostgreSQL serta SQLite. Untuk koneksi server database, gunakan konfigurasi localhost sesuai pembatasan sandbox; jangan mengasumsikan database di LAN dapat dijangkau.

SQLite yang dikelola hosting menggunakan lokasi persisten `/var/lib/nifhost/<id-aplikasi>/database.sqlite`. Backend tetap membutuhkan driver SQLite dan schema yang sesuai. Pembuatan MySQL otomatis tidak berarti PostgreSQL otomatis ikut diprovisikan.

### Migrasi

- Laravel memiliki tombol **Migrate Laravel** dan pilihan migrasi otomatis sebelum deploy.
- Node.js tidak memiliki tombol migrasi umum untuk seluruh ORM. Tentukan prosedur migrasi berdasarkan ORM project dan akses eksekusi yang tersedia; jangan mengasumsikan dashboard menyediakan terminal atau perintah bebas.
- Secret database hanya tersedia saat runtime. Jangan membuat build frontend atau build backend bergantung pada koneksi database dengan secret runtime.
- Rollback aplikasi mengembalikan rilis kode; perubahan schema atau isi database tidak ikut dibatalkan. Backup sebelum perubahan schema dan gunakan migrasi yang kompatibel dengan rilis sebelumnya.

## 9. Environment dan secret

| Jenis nilai | Tempat | Perlakuan |
| --- | --- | --- |
| URL API frontend | Environment frontend, misalnya `VITE_API_URL` | Non-secret; perlu build/deploy ulang |
| Password database | Database backend / secret runtime | Jangan dimasukkan ke React |
| Secret sesi, token privat | Environment backend | Tandai secret; dibaca saat runtime |
| Origin frontend untuk CORS | Environment backend | Kode backend harus menerapkannya |

Semua `VITE_*` yang digunakan frontend bisa masuk ke bundle publik. Menandai sebuah nilai sebagai secret tidak membuatnya aman untuk dipakai di browser; dashboard justru tidak memberikan secret ke tahap build.

Jangan mengatur sendiri variabel runtime yang dicadangkan seperti `PORT`, `HOST`, `PATH`, `NODE_OPTIONS`, atau `NIF_*`. Simpan contoh konfigurasi tanpa kredensial nyata di `.env.example` bila diperlukan.

## 10. Domain, akses publik, dan urutan deployment

Contoh pemisahan domain:

| Aplikasi | Domain contoh |
| --- | --- |
| Frontend | `app.example.com` |
| Backend | `api.example.com` |

Simpan domain pada tab **Domain** masing-masing aplikasi. Gateway hosting memilih aplikasi berdasarkan hostname. Menambahkan domain saja belum memastikan DNS, routing, dan HTTPS sudah aktif.

Jika integrasi Cloudflare telah disiapkan, gunakan hasil sinkronisasi dan status yang ditampilkan dashboard. Jika menggunakan Caddy, arahkan DNS ke IP publik server sesuai konfigurasi administrator. Jika keduanya belum disiapkan, ikuti instruksi DNS/tunnel dari tab Domain.

```text
Pengunjung -> DNS dan HTTPS publik
           -> Cloudflare Tunnel atau reverse proxy/Caddy
           -> gateway hosting 127.0.0.1:8090
           -> hostname terdaftar?
                -> statis: gateway membaca file hasil build
                -> dinamis: gateway meneruskan request ke port internal aplikasi
```

DNS, ingress tunnel/proxy, dan routing gateway adalah langkah yang berbeda. Domain yang tersimpan di dashboard belum tentu bisa dibuka bila salah satunya belum sesuai. Host internal aplikasi dipakai untuk pemeriksaan gateway dan bukan jaminan adanya alamat publik.

Urutan untuk aplikasi dengan database:

1. Buat konfigurasi aplikasi backend tanpa deploy sumber terlebih dahulu.
2. Siapkan database, environment, domain API, dan prosedur migrasi.
3. Deploy backend dan selesaikan migrasi sesuai kebutuhan project.
4. Verifikasi health endpoint dan satu endpoint data lewat HTTPS.
5. Isi URL API pada environment frontend, lalu build/deploy frontend.
6. Uji dari browser: data tampil, CORS benar, autentikasi bekerja jika ada, dan data tetap tersimpan setelah restart.

Jika health check membutuhkan database/schema, selesaikan kebutuhan itu sebelum aktivasi; deploy dengan health check gagal akan dikembalikan ke rilis sebelumnya bila tersedia.

## 11. Update dan pemulihan

Deployment membuat rilis baru. Dashboard melakukan validasi, build, aktivasi, dan health check. Build gagal tidak menggantikan rilis aktif; aktivasi yang gagal health check memicu pemulihan rilis sebelumnya.

Untuk update, upload ZIP baru atau picu deploy GitHub secara manual. Auto-deploy webhook GitHub belum tersedia. Repository privat menggunakan token deploy GitHub pada tab **Pengaturan**.

Periksa log di **Deployment** saat gagal. Gunakan rollback rilis ketika perlu kembali ke versi kode sebelumnya. Setelah mengganti environment backend, restart aplikasi; setelah mengganti environment frontend, deploy ulang dengan build yang memakai nilai baru.

## 12. Cara project lain menggunakan dokumen ini

Saat memakai dokumen ini sebagai konteks:

1. Baca struktur project, `package.json`, konfigurasi build, backend, dan ORM yang sudah ada.
2. Jelaskan arsitektur aktual dan tentukan apakah aplikasi memerlukan backend dan database.
3. Pertahankan framework dan database yang sudah dipakai kecuali ada kebutuhan perubahan yang jelas.
4. Siapkan script build, output frontend, entry backend, health endpoint, environment, dan koneksi database sesuai kontrak hosting di atas.
5. Buat `.env.example` tanpa secret nyata dan petunjuk deploy yang sesuai project tersebut.
6. Dokumentasikan migrasi/schema, seed bila perlu, CORS, serta penyimpanan file persisten.
7. Jalankan build dan pemeriksaan relevan yang tersedia. Bedakan verifikasi lokal dengan verifikasi deployment pada server.
8. Laporkan nilai dashboard yang harus diisi: runtime, output/entry, health path, domain, environment, dan langkah database. Jangan mengklaim deploy berhasil sebelum server diuji.

Contoh instruksi yang dapat dipakai pada project lain:

> Pelajari DASHBOARD_GUIDE.md sebagai kontrak platform hosting tujuan. Periksa project ini, tentukan cara hosting yang sesuai, lalu siapkan konfigurasi dan dokumentasi deployment berdasarkan fitur yang benar-benar tersedia pada dashboard. Catat runtime, bentuk sumber upload/repository, output/entry, health path, environment, kebutuhan database/migrasi, domain, dan cara verifikasinya.

### Masalah yang umum ditemui

| Gejala | Hal yang diperiksa |
| --- | --- |
| `package.json` tidak ditemukan | Root ZIP/source dan manifest project |
| Build berhasil tetapi output tidak ditemukan | Folder output atau file entry dashboard sesuai hasil build |
| Backend gagal health check | Entry, dependency production, port dari environment, bind localhost, dan health path |
| Frontend masih memanggil localhost | URL API pada environment build dan kebutuhan build ulang |
| Request lintas domain gagal | CORS backend, URL API, dan HTTPS |
| Database tidak tersambung | Database/user tersedia, driver, environment runtime, dan restart backend |
| Tabel tidak ditemukan | Migrasi atau impor schema belum dijalankan |
| Deploy berhasil tetapi domain tidak terbuka | DNS, ingress/proxy, hostname gateway, dan HTTPS |
| Data/file hilang setelah update | Data disimpan di folder rilis, bukan state persisten/database |

## 13. Referensi pada repository dashboard

Path berikut merujuk ke repository dashboard asal. Setelah dokumen disalin ke project lain, file sumber ini tidak otomatis ikut tersedia:

- `README.md`: fungsi dashboard, monitoring, autentikasi, arsitektur, dan API administrasi.
- `deploy/hosting/README.md`: instalasi hosting, domain, environment, database, dan troubleshooting.
- `backend/src/hosting/runtimes.ts`: runtime, build, validasi source, dan output.
- `backend/runtime/builder.mjs`: eksekusi build.
- `backend/runtime/nifapp-run`: launcher dan kontrak proses aplikasi.
- `backend/runtime/gateway.mjs`: penyajian statis dan proxy backend.
- `frontend/src/app/(dashboard)/hosting/page.tsx`: form aplikasi baru.
- `frontend/src/app/(dashboard)/hosting/[id]/AppDetail.tsx`: deploy, domain, environment, database, dan pengaturan.
