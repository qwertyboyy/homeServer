import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { AppId, ManagedDatabaseName } from "./model.js";

export function managedName(id: string) {
  AppId.parse(id);
  return `nifdb${crypto.createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
}

/** Only these sanitized operational errors may be shown to the browser. */
export class MysqlAdminError extends Error {}

/** Usernames/passwords are generated; custom database identifiers are strictly validated. */
export class MysqlAdmin {
  constructor(private readonly defaultsFile: string) {}
  async run(sql: string) {
    if (!this.defaultsFile) throw new MysqlAdminError("Atur HOSTING_MYSQL_DEFAULTS_FILE di server terlebih dahulu");
    await new Promise<void>((resolve, reject) => {
      const child = execFile("/usr/bin/mysql", [`--defaults-file=${this.defaultsFile}`, "--batch", "--skip-column-names"],
        { timeout: 30000, maxBuffer: 65536, env: { PATH: "/usr/bin:/bin", LANG: "C" } },
        (error) => error ? reject(new MysqlAdminError("Operasi MySQL gagal. Periksa koneksi, nama database yang sudah ada, dan hak akun admin untuk nama database tersebut di server.")) : resolve());
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(sql);
    });
  }
  async create(id: string, password: string, databaseName = managedName(id)) {
    const user = managedName(id);
    const name = ManagedDatabaseName.parse(databaseName);
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("invalid generated password");
    // No IF NOT EXISTS: never adopt or overwrite an existing account/database.
    await this.run(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    try {
      await this.run(`CREATE USER '${user}'@'127.0.0.1' IDENTIFIED BY '${password}';`);
    } catch (error) {
      await this.run(`DROP DATABASE \`${name}\`;`).catch(() => undefined);
      throw error;
    }
    try {
      // Escape grant wildcards so '_' cannot grant access to other databases.
      const grantName = name.replace(/_/g, "\\_");
      await this.run(`GRANT ALL PRIVILEGES ON \`${grantName}\`.* TO '${user}'@'127.0.0.1';`);
    } catch (error) {
      await this.drop(id, name).catch(() => undefined);
      throw error;
    }
  }
  async reset(id: string, password: string) {
    if (!/^[a-f0-9]{64}$/.test(password)) throw new Error("invalid generated password");
    await this.run(`ALTER USER '${managedName(id)}'@'127.0.0.1' IDENTIFIED BY '${password}';`);
  }
  async drop(id: string, databaseName = managedName(id)) {
    const user = managedName(id);
    const name = ManagedDatabaseName.parse(databaseName);
    await this.run(`DROP DATABASE IF EXISTS \`${name}\`; DROP USER IF EXISTS '${user}'@'127.0.0.1';`);
  }
}
