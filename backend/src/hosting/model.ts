import { z } from "zod";

/**
 * Hosting Manager data model. Everything that reaches the filesystem, systemd,
 * or the builder is derived from these schemas — never from raw request input.
 */

export const RUNTIMES = ["static", "vite", "nextjs", "node", "laravel", "php"] as const;
export type RuntimeKind = (typeof RUNTIMES)[number];

/** Runtimes served directly by the gateway (no process of their own). */
export const STATIC_RUNTIMES: ReadonlySet<RuntimeKind> = new Set(["static", "vite"]);
export const isProcessRuntime = (r: RuntimeKind) => !STATIC_RUNTIMES.has(r);

// App id doubles as the systemd instance name (nifapp@<id>.service) and a directory name.
export const APP_ID_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const RELEASE_ID_RE = /^r\d{14}-[a-f0-9]{6}$/;
export const DEPLOY_ID_RE = /^d\d{14}-[a-f0-9]{6}$/;

export const AppId = z
  .string()
  .regex(APP_ID_RE, "id: 3–32 karakter a-z, 0-9, '-' dan diawali huruf")
  .refine((id) => !/^nif(server|host|app|build)/.test(id), "id dengan awalan nifserver/nifhost dicadangkan");

/** Relative path inside a release: no absolute paths, no "..", no hidden segments. */
export const RelPath = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/, "path tidak valid")
  .refine((p) => p.split("/").every((s) => s !== "" && s !== "." && s !== ".." && !s.startsWith(".")), "path tidak valid");

export const OutputDir = z.union([z.literal("."), RelPath]);

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
export function isValidHostname(h: string) {
  if (h.length > 253 || !h.includes(".")) return false;
  if (/^[\d.]+$/.test(h) || h.includes(":")) return false; // no IP literals
  const labels = h.split(".");
  return labels.every((l) => LABEL.test(l)) && /[a-z]/.test(labels[labels.length - 1]);
}
export const Hostname = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isValidHostname, "hostname tidak valid (contoh: app.nifserver.cloud)");

export const HealthPath = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9._~/?=&%-]*$/, "health path harus diawali '/'");

// git check-ref-format subset — enough for real branch names, nothing that can act as an option.
export const Branch = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "nama branch tidak valid")
  .refine(
    (b) => !b.includes("..") && !b.includes("//") && !b.endsWith("/") && !b.endsWith(".") && !b.endsWith(".lock"),
    "nama branch tidak valid",
  );

export const RepoUrl = z.string().trim().max(300);

// Keys managed by the platform or dangerous for the loader/runtime.
const RESERVED_KEYS = new Set([
  "PORT", "HOST", "HOSTNAME", "PATH", "HOME", "USER", "SHELL", "PWD", "NODE_OPTIONS", "NODE_PATH",
  "BASH_ENV", "ENV", "IFS", "PYTHONPATH", "PERL5OPT", "STATE_DIRECTORY", "CREDENTIALS_DIRECTORY",
  "PHP_CLI_SERVER_WORKERS",
]);
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
export function envKeyProblem(key: string): string | null {
  if (!ENV_KEY_RE.test(key)) return `${key}: gunakan A-Z, 0-9, _`;
  if (RESERVED_KEYS.has(key) || key.startsWith("NIF_") || key.startsWith("LD_") || key.startsWith("SYSTEMD_")) {
    return `${key}: nama variabel dicadangkan sistem`;
  }
  return null;
}
// One line, printable — values go into a systemd EnvironmentFile.
export const EnvValue = z
  .string()
  .max(4096)
  .refine((v) => !/[\r\n\0]/.test(v), "nilai tidak boleh berisi baris baru");

export const AppOptions = z
  .object({
    outputDir: OutputDir.optional(), // static, vite
    entry: RelPath.optional(), // node
    docroot: OutputDir.optional(), // php
  })
  .strict();
export type AppOptions = z.infer<typeof AppOptions>;

export const DbType = z.enum(["none", "sqlite", "mysql", "postgresql"]);
export const DbConfig = z.object({
  type: DbType,
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  name: z.string().nullable(),
  user: z.string().nullable(),
  passwordSet: z.boolean(),
});
export type DbConfig = z.infer<typeof DbConfig>;

export const ReleaseRecord = z.object({
  id: z.string().regex(RELEASE_ID_RE),
  createdAt: z.string(),
  source: z.enum(["upload", "github"]),
  commit: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  status: z.enum(["ready", "failed", "removed"]),
});
export type ReleaseRecord = z.infer<typeof ReleaseRecord>;

export const DeploymentStatus = z.enum(["running", "succeeded", "failed", "rolled_back"]);
export const DeploymentRecord = z.object({
  id: z.string().regex(DEPLOY_ID_RE),
  kind: z.enum(["deploy", "rollback"]),
  method: z.enum(["upload", "github", "rollback"]),
  releaseId: z.string().regex(RELEASE_ID_RE),
  status: DeploymentStatus,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  message: z.string().max(500),
});
export type DeploymentRecord = z.infer<typeof DeploymentRecord>;

export const EnvEntry = z.object({
  key: z.string().regex(ENV_KEY_RE),
  secret: z.boolean(),
  // Non-secret values are stored here; secret values only live in secrets/secrets.json.
  value: z.string().nullable(),
});
export type EnvEntry = z.infer<typeof EnvEntry>;

export const AppRecord = z.object({
  id: AppId,
  name: z.string().min(1).max(64),
  runtime: z.enum(RUNTIMES),
  deployMethod: z.enum(["upload", "github"]),
  repo: z.object({ url: RepoUrl, branch: Branch }).nullable(),
  domains: z.array(Hostname).max(5),
  port: z.number().int().nullable(),
  healthPath: HealthPath,
  options: AppOptions,
  env: z.array(EnvEntry).max(100),
  database: DbConfig,
  gitTokenSet: z.boolean(),
  desiredState: z.enum(["running", "stopped"]),
  activeReleaseId: z.string().regex(RELEASE_ID_RE).nullable(),
  releases: z.array(ReleaseRecord),
  deployments: z.array(DeploymentRecord),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AppRecord = z.infer<typeof AppRecord>;

export const RegistryFile = z.object({
  version: z.literal(1),
  apps: z.array(AppRecord).max(100),
});
export type RegistryFile = z.infer<typeof RegistryFile>;

// ---------- Request bodies ----------

export const CreateAppBody = z
  .object({
    id: AppId,
    name: z.string().trim().min(1).max(64),
    runtime: z.enum(RUNTIMES),
    deployMethod: z.enum(["upload", "github"]),
    repo: z.object({ url: RepoUrl, branch: Branch.default("main") }).optional(),
    domains: z.array(Hostname).max(5).default([]),
    healthPath: HealthPath.default("/"),
    options: AppOptions.default({}),
  })
  .strict()
  .refine((b) => b.deployMethod !== "github" || b.repo, { message: "repo wajib untuk deploy GitHub", path: ["repo"] });

export const UpdateAppBody = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    deployMethod: z.enum(["upload", "github"]).optional(),
    repo: z.object({ url: RepoUrl, branch: Branch }).nullable().optional(),
    healthPath: HealthPath.optional(),
    options: AppOptions.optional(),
  })
  .strict();

export const DomainsBody = z.object({ domains: z.array(Hostname).max(5) }).strict();

export const EnvBody = z
  .object({
    vars: z
      .array(
        z
          .object({
            key: z.string().trim(),
            secret: z.boolean().default(false),
            // Omit for an existing secret to keep its stored value.
            value: EnvValue.optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const DatabaseBody = z
  .object({
    type: DbType,
    host: z.enum(["127.0.0.1", "localhost", "::1"]).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    name: z.string().regex(/^[A-Za-z0-9_]{1,64}$/).optional(),
    user: z.string().regex(/^[A-Za-z0-9_]{1,32}$/).optional(),
    password: EnvValue.optional(), // omit to keep the stored one
  })
  .strict();

export const GitTokenBody = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_]{20,255}$/, "format token tidak valid").nullable() })
  .strict();

export const ActionBody = z
  .object({ action: z.enum(["start", "stop", "restart"]), confirm: z.string().optional() })
  .strict();

export const RollbackBody = z.object({ releaseId: z.string().regex(RELEASE_ID_RE) }).strict();
export const DeleteBody = z.object({ confirm: z.string() }).strict();
export const GithubDeployBody = z.object({}).strict();

export function newId(prefix: "r" | "d") {
  const ts = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${prefix}${ts}-${rand}`;
}
