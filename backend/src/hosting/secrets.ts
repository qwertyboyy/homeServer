import fs from "node:fs/promises";
import { z } from "zod";
import { writeFileAtomic } from "./fsutil.js";
import type { AppRecord } from "./model.js";
import { appStateDir, type HostingPaths } from "./paths.js";

const SecretsFile = z.object({
  env: z.record(z.string(), z.string()).default({}),
  dbPassword: z.string().nullable().default(null),
  gitToken: z.string().nullable().default(null),
});
export type Secrets = z.infer<typeof SecretsFile>;

const EMPTY: Secrets = { env: {}, dbPassword: null, gitToken: null };

/** systemd EnvironmentFile line. Inside double quotes systemd unescapes \" \\ \` \$ like a shell. */
export function envLine(key: string, value: string) {
  return `${key}="${value.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`;
}

/**
 * Per-app secrets in apps/<id>/secrets/ (dir 0700, files 0600, owned by the
 * dashboard user). systemd reads runtime.env as root before dropping to the
 * app's dynamic user, so the app never has file access to it. Values are never
 * returned by the API or written to logs.
 */
export class SecretStore {
  constructor(private readonly paths: HostingPaths) {}

  async init(id: string) {
    await fs.mkdir(this.paths.secrets(id), { recursive: true, mode: 0o700 });
    await fs.chmod(this.paths.secrets(id), 0o700).catch(() => undefined);
  }

  async read(id: string): Promise<Secrets> {
    try {
      return SecretsFile.parse(JSON.parse(await fs.readFile(this.paths.secretsFile(id), "utf8")));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY);
      throw new Error("secrets.json tidak dapat dibaca");
    }
  }

  async write(app: AppRecord, secrets: Secrets) {
    await this.init(app.id);
    await writeFileAtomic(this.paths.secretsFile(app.id), JSON.stringify(secrets), 0o600);
    await writeFileAtomic(this.paths.runtimeEnv(app.id), renderRuntimeEnv(app, secrets), 0o600);
    // Always present (possibly empty): the build unit loads it as a systemd credential.
    await writeFileAtomic(this.paths.gitToken(app.id), secrets.gitToken ?? "", 0o600);
  }

  /** All secret values for an app — used only to scrub them out of logs. */
  async values(id: string): Promise<string[]> {
    const s = await this.read(id);
    return [...Object.values(s.env), s.dbPassword ?? "", s.gitToken ?? ""].filter(Boolean);
  }
}

export function databaseEnv(app: AppRecord, password: string | null): Record<string, string> {
  const db = app.database;
  if (db.type === "none") return {};
  if (db.type === "sqlite") {
    const file = `${appStateDir(app.id)}/database.sqlite`;
    return { DB_CONNECTION: "sqlite", DB_DATABASE: file, DATABASE_URL: `file:${file}` };
  }
  const port = String(db.port ?? (db.type === "mysql" ? 3306 : 5432));
  const host = db.host ?? "127.0.0.1";
  const auth = `${encodeURIComponent(db.user ?? "")}${password ? `:${encodeURIComponent(password)}` : ""}`;
  const scheme = db.type === "mysql" ? "mysql" : "postgresql";
  return {
    DB_CONNECTION: db.type === "mysql" ? "mysql" : "pgsql",
    DB_HOST: host,
    DB_PORT: port,
    DB_DATABASE: db.name ?? "",
    DB_USERNAME: db.user ?? "",
    ...(password ? { DB_PASSWORD: password } : {}),
    DATABASE_URL: `${scheme}://${auth}@${host.includes(":") ? `[${host}]` : host}:${port}/${db.name ?? ""}`,
  };
}

export function renderRuntimeEnv(app: AppRecord, secrets: Secrets) {
  const vars: Record<string, string> = { NODE_ENV: "production", ...databaseEnv(app, secrets.dbPassword) };
  for (const e of app.env) {
    const v = e.secret ? secrets.env[e.key] : e.value;
    if (v !== undefined && v !== null) vars[e.key] = v;
  }
  return Object.entries(vars).map(([k, v]) => envLine(k, v)).join("\n") + "\n";
}

// Tool configuration the builder pins itself; the builder rejects plans that try to set these.
const BUILD_ENV_BLOCKED = /^(GIT_|NPM_CONFIG_|COMPOSER)/;

/** Non-secret variables are exposed at build time (VITE_*, NEXT_PUBLIC_*); secrets never are. */
export function buildEnv(app: AppRecord): Record<string, string> {
  return Object.fromEntries(
    app.env.filter((e) => !e.secret && e.value !== null && !BUILD_ENV_BLOCKED.test(e.key)).map((e) => [e.key, e.value as string]),
  );
}
