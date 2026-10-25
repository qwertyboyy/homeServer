# Deploy NIFSERVER Dashboard dari GitHub

Repository **privat** di GitHub menjadi sumber kode; branch **`main`** adalah branch rilis. Server menarik kode
dengan **deploy key read-only** (tidak ada token pribadi di server, server tidak bisa push).

> Panduan ini untuk dashboard NIFSERVER sendiri. Untuk aplikasi yang di-host lewat menu Hosting, lihat
> [deploy/hosting/README.md](../deploy/hosting/README.md).

Asumsi: kode di `/opt/nifserver`, dijalankan user `hanifsr` (ganti bila berbeda — unit di `deploy/*.service`
memakai `User=nifserver`; sesuaikan `User=`/`Group=` dengan user Anda), secret di `/etc/nifserver/nifserver.env`.

## Yang TIDAK boleh masuk Git

Sudah diatur di `.gitignore`: `.env`, `.env.*` (kecuali `.env.example`), `config/applications.json`,
`node_modules/`, `.next/`, `dist/`, `.hosting-dev/`, `*.tar.gz`, log. File contoh yang aman tetap di-commit:
`.env.example`, `config/applications.example.json`, `config/services.json`.

Sebelum push pertama, pastikan tidak ada secret yang ikut:

```bash
git status --ignored --short | grep -E '\.env|applications\.json'   # harus berstatus "!!" (ignored)
git ls-files | grep -Ei '\.env$|secret|\.pem$|id_rsa'               # harus kosong
```

## 1. Siapkan repository (di komputer pengembangan)

```bash
cd "dashboard server"
git init -b main
git add .
git commit -m "NIFSERVER dashboard + Hosting Manager"
gh repo create <akun>/nifserver --private --source . --push     # atau buat repo privat di web lalu `git remote add` + `git push -u origin main`
```

Disarankan di GitHub: *Settings → Branches* → aturan untuk `main` (require pull request / status check) agar rilis
hanya lewat merge yang sudah dites.

## 2. Deploy key di server (sekali)

```bash
sudo -u hanifsr ssh-keygen -t ed25519 -N '' -C 'nifserver-deploy' -f /home/hanifsr/.ssh/nifserver_deploy
sudo -u hanifsr cat /home/hanifsr/.ssh/nifserver_deploy.pub
```

GitHub → repo → *Settings → Deploy keys → Add deploy key* → tempel public key, **jangan** centang *Allow write access*.

```bash
sudo -u hanifsr tee -a /home/hanifsr/.ssh/config >/dev/null <<'EOF'
Host github-nifserver
  HostName github.com
  User git
  IdentityFile ~/.ssh/nifserver_deploy
  IdentitiesOnly yes
EOF
sudo -u hanifsr ssh -T github-nifserver     # "Hi <akun>/nifserver! You've successfully authenticated..."
```

## 3. Clone pertama kali

```bash
# Audit dulu (tidak mengubah apa pun)
node -v && npm -v && git --version
ss -ltnp | grep -E ':(3000|3001|8088|8090)\b'
systemctl is-active netdata apache2 cloudflared smbd ssh

# Jika /opt/nifserver sudah ada dari instalasi tarball: backup dulu
sudo mv /opt/nifserver /opt/nifserver.pre-git-$(date +%F)

sudo install -d -o hanifsr -g hanifsr /opt/nifserver
sudo -u hanifsr git clone --branch main git@github-nifserver:<akun>/nifserver.git /opt/nifserver

# Konfigurasi lokal (tidak ada di Git)
sudo install -d -m 750 /etc/nifserver
sudo cp /opt/nifserver/.env.example /etc/nifserver/nifserver.env         # jika belum ada
sudo chown root:hanifsr /etc/nifserver/nifserver.env && sudo chmod 640 /etc/nifserver/nifserver.env
# kembalikan config/applications.json dari backup bila ada:
# sudo -u hanifsr cp /opt/nifserver.pre-git-*/config/applications.json /opt/nifserver/config/

# Build + test pertama
cd /opt/nifserver/backend  && sudo -u hanifsr npm ci && sudo -u hanifsr npm test && sudo -u hanifsr npm run build && sudo -u hanifsr npm prune --omit=dev
cd /opt/nifserver/frontend && sudo -u hanifsr npm ci && sudo -u hanifsr npm run build
```

Lalu lanjutkan langkah systemd/Nginx/Cloudflare di [README](../README.md#deployment-di-ubuntu) dan, untuk fitur
hosting, `sudo bash deploy/hosting/install.sh hanifsr`.

## 4. Update (setiap rilis)

Satu perintah — backup, build + test di staging, swap, health check, rollback otomatis:

```bash
sudo RUN_USER=hanifsr bash /opt/nifserver/deploy/update-nifserver.sh
```

Yang dilakukan [deploy/update-nifserver.sh](../deploy/update-nifserver.sh):

1. Menolak jalan bila ada perubahan lokal yang belum di-commit di `/opt/nifserver`.
2. `git fetch origin main`; berhenti jika tidak ada commit baru. Menampilkan daftar commit yang masuk.
3. **Backup** ke `/var/backups/nifserver/<tanggal>/`: commit lama, `nifserver.env`, `config/`, `registry.json`
   hosting, salinan unit systemd.
4. Clone ke `/opt/nifserver.staging`, checkout `origin/main`, salin `config/applications.json`, lalu
   **backend**: `npm ci` → `typecheck` → `npm test` → `build` → `prune`; **frontend**: `npm ci` → `lint` → `build`.
   Semua dijalankan sebagai `RUN_USER`, bukan root. Gagal di sini → versi berjalan tidak tersentuh sama sekali.
5. Stop `nifserver-backend` & `nifserver-frontend`, `/opt/nifserver` → `/opt/nifserver.prev`, staging →
   `/opt/nifserver`, start.
6. **Health check** 60 dtk: `GET /api/v1/health` = `ok` dan halaman `/login` frontend = 200.
7. Gagal → stop, kembalikan `/opt/nifserver.prev`, start lagi, tampilkan 30 baris log backend.

Hanya dua service dashboard yang di-restart. SSH, firewall, Apache/WebDAV, Samba, Netdata, cloudflared, dan aplikasi
yang di-host (`nifapp@*`) tidak disentuh. Jika skrip runtime hosting berubah, skrip mencetak pengingat untuk menjalankan
`deploy/hosting/install.sh` lagi.

### Langkah manual (setara, bila tidak memakai skrip)

```bash
cd /opt/nifserver
sudo -u hanifsr git status --short                     # harus bersih
PREV=$(sudo -u hanifsr git rev-parse HEAD)
sudo install -d -m 700 /var/backups/nifserver/$(date +%F) && sudo cp -a /etc/nifserver/nifserver.env config /var/backups/nifserver/$(date +%F)/
sudo -u hanifsr git pull --ff-only origin main
cd backend  && sudo -u hanifsr npm ci && sudo -u hanifsr npm test && sudo -u hanifsr npm run build && sudo -u hanifsr npm prune --omit=dev
cd ../frontend && sudo -u hanifsr npm ci && sudo -u hanifsr npm run build
sudo systemctl restart nifserver-backend nifserver-frontend
curl -s http://127.0.0.1:3001/api/v1/health && curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login
```

Catatan: pada cara manual, build berjalan di folder yang sedang dipakai; jika build gagal di tengah, frontend bisa
rusak sampai di-rollback. Skrip staging menghindari risiko ini.

## 5. Rollback

- Otomatis: dilakukan skrip jika health check gagal.
- Manual ke versi sebelumnya (setelah update yang "berhasil" tetapi ternyata bermasalah):

```bash
sudo systemctl stop nifserver-backend nifserver-frontend
sudo mv /opt/nifserver /opt/nifserver.bad-$(date +%F-%H%M) && sudo mv /opt/nifserver.prev /opt/nifserver
sudo systemctl start nifserver-backend nifserver-frontend
curl -s http://127.0.0.1:3001/api/v1/health
```

- Ke commit tertentu: `git -C /opt/nifserver checkout -B main <commit>` lalu build seperti langkah manual
  (atau push revert ke `main` dan jalankan skrip update — cara yang disarankan).
- Konfigurasi: salin balik dari `/var/backups/nifserver/<tanggal>/`.

## 6. CI (opsional)

Jalankan tes yang sama di GitHub Actions sebelum merge ke `main`, contoh `.github/workflows/ci.yml`:

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run typecheck && npm test && npm run build
        working-directory: backend
      - run: npm ci && npm run lint && npm run build
        working-directory: frontend
```

Auto-deploy dari GitHub ke server (webhook) sengaja **tidak** disediakan: endpoint publik seperti itu butuh
verifikasi signature HMAC, perlindungan replay, dan rahasia webhook yang dikelola. Update tetap dipicu manual via SSH.
