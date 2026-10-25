import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { readTunnelConfig } from "./domains.js";
import type { HostExecutor } from "./executor.js";
import { exists } from "./fsutil.js";

export type CheckStatus = "ok" | "missing" | "warning" | "unknown";

export interface PrereqCheck {
  key: string;
  group: "core" | "runtime" | "database" | "network";
  label: string;
  status: CheckStatus;
  detail: string | null;
  fix: string | null;
}

export interface Prerequisites {
  executor: "systemd" | "simulated";
  ready: boolean;
  checks: PrereqCheck[];
  binaries: Record<string, boolean>;
  checkedAt: string;
}

export interface PrereqOptions {
  root: string;
  runtimeDir: string;
  gatewayPort: number;
  cloudflaredConfig: string;
  /** Overridable for tests. */
  fileExists?: (p: string) => Promise<boolean>;
  portOpen?: (port: number) => Promise<boolean>;
}

const BIN_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"];
const BINARIES = ["node", "npm", "git", "php", "composer"] as const;

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 500 });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("timeout", () => (s.destroy(), resolve(false)));
    s.once("error", () => resolve(false));
  });

async function readList(file: string) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Detects what the server already has. Read-only: never installs or changes anything. */
export async function detectPrerequisites(executor: HostExecutor, o: PrereqOptions): Promise<Prerequisites> {
  const has = o.fileExists ?? exists;
  const isOpen = o.portOpen ?? portOpen;
  const checks: PrereqCheck[] = [];
  const add = (c: PrereqCheck) => checks.push(c);
  const install = "Jalankan sekali: sudo bash deploy/hosting/install.sh (lihat deploy/hosting/README.md)";

  if (executor.kind === "simulated") {
    add({
      key: "executor", group: "core", label: "Mode eksekusi", status: "warning",
      detail: "Simulasi (MOCK/dev): build dan service tidak benar-benar dijalankan.",
      fix: "Di server: HOSTING_EXECUTOR=systemd setelah install.sh dijalankan.",
    });
  }

  const linux = process.platform === "linux";
  add({
    key: "systemd", group: "core", label: "systemd", status: linux && (await has("/run/systemd/system")) ? "ok" : "missing",
    detail: linux ? null : `Platform ${process.platform}`, fix: linux ? null : "Hosting Manager membutuhkan Ubuntu dengan systemd.",
  });

  let writable = false;
  try {
    await fs.access(o.root, fs.constants.W_OK);
    writable = true;
  } catch {
    /* missing or no permission */
  }
  add({ key: "root", group: "core", label: `Direktori ${o.root}`, status: writable ? "ok" : "missing", detail: writable ? null : "Tidak ada atau tidak bisa ditulis backend", fix: writable ? null : install });

  const units = ["nifapp@.service", "nifbuild@.service", "nifhost-gateway.service"];
  const missingUnits = [];
  for (const u of units) if (!(await has(`/etc/systemd/system/${u}`))) missingUnits.push(u);
  add({ key: "units", group: "core", label: "Unit systemd hosting", status: missingUnits.length ? "missing" : "ok", detail: missingUnits.length ? `Belum ada: ${missingUnits.join(", ")}` : null, fix: missingUnits.length ? install : null });

  const scripts = ["builder.mjs", "gateway.mjs", "nifapp-run", "router.php"];
  const missingScripts = [];
  for (const s of scripts) if (!(await has(path.join(o.runtimeDir, s)))) missingScripts.push(s);
  add({ key: "scripts", group: "core", label: `Skrip runtime (${o.runtimeDir})`, status: missingScripts.length ? "missing" : "ok", detail: missingScripts.length ? `Belum ada: ${missingScripts.join(", ")}` : null, fix: missingScripts.length ? install : null });

  const passwd = await readList("/etc/passwd");
  const group = await readList("/etc/group");
  const me = os.userInfo().username;
  const users = ["nifbuild", "nifgw"].filter((u) => !passwd?.split("\n").some((l) => l.startsWith(`${u}:`)));
  const nifhost = group?.split("\n").find((l) => l.startsWith("nifhost:"));
  const inGroup = !!nifhost && nifhost.split(":")[3]?.split(",").includes(me);
  add({
    key: "users", group: "core", label: "User build/gateway & grup nifhost",
    status: passwd === null ? "unknown" : users.length === 0 && inGroup ? "ok" : "missing",
    detail: users.length ? `User belum ada: ${users.join(", ")}` : !inGroup ? `User ${me} belum anggota grup nifhost` : null,
    fix: users.length || !inGroup ? install : null,
  });

  // /etc/polkit-1/rules.d is usually not readable by unprivileged users.
  const polkit = await fs.access("/etc/polkit-1/rules.d/50-nifhost.rules").then(() => "ok" as const, (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? "missing" as const : "unknown" as const));
  add({ key: "polkit", group: "core", label: "Izin polkit (hanya nifapp@/nifbuild@)", status: polkit, detail: polkit === "unknown" ? "Tidak bisa dibaca tanpa root; diuji saat aksi pertama" : null, fix: polkit === "missing" ? install : null });

  let gw: CheckStatus = "unknown";
  try {
    gw = (await executor.gatewayState()).activeState === "active" ? "ok" : "missing";
  } catch {
    /* systemctl unavailable */
  }
  add({ key: "gateway", group: "core", label: `Gateway hosting (127.0.0.1:${o.gatewayPort})`, status: gw, detail: null, fix: gw === "ok" ? null : "sudo systemctl enable --now nifhost-gateway" });

  const binaries: Record<string, boolean> = {};
  for (const b of BINARIES) {
    let found = false;
    for (const d of BIN_DIRS) if (await has(path.join(d, b))) found = true;
    binaries[b] = found;
  }
  const label: Record<string, string> = { node: "Node.js (/usr/bin/node)", npm: "npm", git: "git (deploy GitHub)", php: "PHP CLI (Laravel/PHP)", composer: "Composer (Laravel)" };
  for (const b of BINARIES) {
    const optional = b === "php" || b === "composer";
    add({
      key: `bin-${b}`, group: "runtime", label: label[b],
      status: binaries[b] ? "ok" : optional ? "warning" : "missing", detail: binaries[b] ? null : "Tidak ditemukan",
      fix: binaries[b] ? null : b === "composer" ? "sudo apt install composer" : b === "php" ? "sudo apt install php-cli php-mbstring php-xml php-curl php-sqlite3 php-mysql" : b === "git" ? "sudo apt install git" : "Pasang Node.js LTS sistem (mis. paket NodeSource) agar tersedia di /usr/bin/node",
    });
  }
  let fpm = false;
  try {
    fpm = (await fs.readdir("/usr/sbin")).some((f) => /^php-fpm/.test(f));
  } catch {
    /* not linux */
  }
  add({
    key: "php-fpm", group: "runtime", label: "PHP-FPM", status: fpm ? "ok" : "warning",
    detail: fpm ? "Terdeteksi, tetapi belum dipakai: aplikasi PHP berjalan dengan server bawaan PHP (2 worker)" : "Tidak ada — Laravel/PHP memakai server bawaan PHP (cukup untuk trafik rendah)",
    fix: null,
  });

  const mysql = (await has("/run/mysqld/mysqld.sock")) || (await isOpen(3306));
  const pg = (await has("/var/run/postgresql/.s.PGSQL.5432")) || (await isOpen(5432));
  add({ key: "db-sqlite", group: "database", label: "SQLite (file per aplikasi)", status: "ok", detail: "Tidak memerlukan server", fix: null });
  add({ key: "db-mysql", group: "database", label: "MySQL/MariaDB", status: mysql ? "ok" : "warning", detail: mysql ? "Server terdeteksi di localhost" : "Tidak terdeteksi", fix: mysql ? null : "Opsional: sudo apt install mariadb-server" });
  add({ key: "db-postgresql", group: "database", label: "PostgreSQL", status: pg ? "ok" : "warning", detail: pg ? "Server terdeteksi di localhost" : "Tidak terdeteksi", fix: pg ? null : "Opsional: sudo apt install postgresql" });

  const tunnel = await readTunnelConfig(o.cloudflaredConfig);
  const toGateway = tunnel.rules.some((r) => r.service.replace(/\/$/, "").endsWith(`:${o.gatewayPort}`));
  add({
    key: "tunnel", group: "network", label: "Cloudflare Tunnel → gateway",
    status: tunnel.status !== "ok" ? "unknown" : toGateway ? "ok" : "warning",
    detail: tunnel.status === "ok" ? (toGateway ? "Ada rule ingress ke gateway" : "Belum ada rule ingress ke gateway") : `config.yml ${tunnel.status === "missing" ? "tidak ditemukan" : "tidak bisa dibaca"} (${o.cloudflaredConfig})`,
    fix: toGateway ? null : "Lihat tab Domain pada aplikasi untuk snippet ingress",
  });
  add({ key: "wildcard", group: "network", label: "Wildcard DNS", status: "unknown", detail: "Tidak diasumsikan. Setiap domain perlu record DNS sendiri (cloudflared tunnel route dns).", fix: null });

  const ready = executor.kind === "simulated" || checks.filter((c) => c.group === "core").every((c) => c.status === "ok" || c.status === "unknown");
  return { executor: executor.kind, ready, checks, binaries, checkedAt: new Date().toISOString() };
}
