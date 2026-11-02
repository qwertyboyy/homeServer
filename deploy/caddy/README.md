# HTTPS otomatis dengan Caddy (alternatif Cloudflare)

Untuk server yang **tidak** memakai Cloudflare. Caddy menerima koneksi di port 80/443, mengurus sertifikat
Let's Encrypt sendiri, lalu meneruskan ke gateway hosting (`127.0.0.1:8090`). Setiap kali Anda menambah domain di
dashboard, domain itu otomatis disetujui; sertifikatnya dibuat saat pertama kali dibuka.

Pilih **salah satu**: Cloudflare (lihat `deploy/hosting/README.md`) *atau* Caddy. Keduanya tidak saling mengganggu,
tetapi Anda tidak memerlukan Caddy bila semua domain sudah lewat Cloudflare Tunnel.

## Syarat

- Port **80 dan 443** di server kosong dan terjangkau dari internet (firewall dan port-forward router).
  Periksa dulu: `sudo ss -ltnp | grep -E ':(80|443)\s'`. Jika Apache/Nginx sudah memakainya, jangan pasang Caddy di
  mesin yang sama tanpa memindahkan salah satunya.
- DNS domain mengarah ke **IP publik server**: record `A` per domain, atau satu wildcard `*.domainanda.com`.
  Dashboard tidak mengatur DNS tanpa Cloudflare; tab **Domain** hanya memeriksanya.
- Let's Encrypt membatasi jumlah sertifikat per domain induk (sekitar 50 per minggu). Cukup untuk pemakaian pribadi.

## Pasang (sekali)

```bash
# 1. Pasang Caddy (Ubuntu/Debian; lihat caddyserver.com/docs/install bila langkah berubah)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy

# 2. Buat token rahasia dan pasang di backend
openssl rand -hex 24
sudo nano /etc/nifserver/nifserver.env       # tambahkan: CADDY_ASK_TOKEN=<token tadi>
sudo systemctl restart nifserver-backend

# 3. Pasang Caddyfile (ganti email dan token), lalu muat ulang
sudo cp /opt/nifserver/deploy/caddy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
sudo chown root:caddy /etc/caddy/Caddyfile && sudo chmod 640 /etc/caddy/Caddyfile   # berisi token
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Cek

```bash
# Backend menyetujui domain milik aplikasi (200) dan menolak yang lain (404):
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:3001/api/v1/caddy/ask?token=<token>&domain=app.domainanda.com"
# Setelah DNS mengarah ke server:
curl -I https://app.domainanda.com
sudo journalctl -u caddy -n 50 --no-pager      # alasan bila sertifikat gagal
```

Di dashboard, tab **Domain** akan menulis "HTTPS otomatis lewat Caddy" bila `CADDY_ASK_TOKEN` terpasang.

## Keamanan

- Endpoint `ask` tanpa sesi login, jadi dijaga token rahasia (dibandingkan *constant-time*) dan dibatasi 600 permintaan/menit.
  Token salah, endpoint nonaktif, atau domain tidak dikenal semuanya menjawab 404 yang sama.
- Domain yang dicadangkan (`HOSTING_RESERVED_HOSTS`) dan host internal (`*.nifhost.internal`) tidak pernah disetujui.
- Domain yang dihapus dari aplikasi berhenti disetujui; sertifikat yang sudah terbit akan kedaluwarsa sendiri.
- Gateway hanya bind ke loopback; yang terbuka ke internet hanya Caddy (80/443).
- Caddyfile berisi token: simpan dengan `chmod 640`, jangan masukkan ke Git setelah diisi.

## Masalah umum

| Gejala | Penyebab |
|---|---|
| Browser: koneksi ditolak / timeout | Port 80/443 belum dibuka di firewall atau router. |
| Browser: peringatan sertifikat | DNS belum mengarah ke server, atau domain belum ada di tab Domain (ask menjawab 404). |
| `journalctl -u caddy`: *too many certificates* | Batas Let's Encrypt; tunggu atau kurangi jumlah domain baru. |
| `ask` selalu 404 | `CADDY_ASK_TOKEN` di backend berbeda dengan di Caddyfile, atau backend belum direstart. |
