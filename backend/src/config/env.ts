import path from "node:path";
import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_HOST: z.string().default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  ADMIN_USERNAME: z.string().min(3).max(64),
  // bcrypt hash; generate with `npm run hash-password`
  ADMIN_PASSWORD_HASH: z
    .string()
    .regex(/^\$2[aby]\$\d{2}\$.{53}$/, "ADMIN_PASSWORD_HASH must be a bcrypt hash"),

  SESSION_TTL_HOURS: z.coerce.number().min(0.25).max(720).default(12),
  // auto = Secure only when the request arrived over HTTPS (remote via Cloudflare).
  COOKIE_SECURE: z.enum(["auto", "true", "false"]).default("auto"),

  NETDATA_URL: z.url().default("http://127.0.0.1:19999"),
  NETDATA_TIMEOUT_MS: z.coerce.number().int().min(250).max(15000).default(3000),

  CONFIG_DIR: z.string().default(path.resolve(process.cwd(), "../config")),
  SHARED_PATH: z.string().default("/srv/shared"),

  // Serves clearly labelled sample data (for development on non-Linux machines).
  MOCK_MODE: bool.default(false),

  // ---- Hosting Manager (see deploy/hosting/README.md) ----
  HOSTING_ENABLED: bool.default(true),
  // Off Linux (development) default to a git-ignored folder in the repo, never a system path.
  HOSTING_ROOT: z.string().default(process.platform === "linux" ? "/srv/nifhost" : path.resolve(process.cwd(), "../.hosting-dev")),
  // systemd = real builds/units (needs deploy/hosting/install.sh); simulated = dev only, nothing is executed.
  HOSTING_EXECUTOR: z.enum(["systemd", "simulated"]).optional(),
  HOSTING_GATEWAY_PORT: z.coerce.number().int().min(1024).max(65535).default(8090),
  HOSTING_PORT_MIN: z.coerce.number().int().min(1024).max(65535).default(4100),
  HOSTING_PORT_MAX: z.coerce.number().int().min(1024).max(65535).default(4199),
  HOSTING_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(500).default(50),
  HOSTING_MAX_EXTRACTED_MB: z.coerce.number().int().min(1).max(4000).default(300),
  HOSTING_DEPLOY_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
  // Comma-separated hostnames allowed as git sources (HTTPS only).
  HOSTING_GIT_HOSTS: z.string().default("github.com"),
  // Hostnames hosted apps may never claim (existing tunnel routes).
  HOSTING_RESERVED_HOSTS: z.string().default("drive.nifserver.cloud,panel.nifserver.cloud"),
  HOSTING_BASE_DOMAIN: z.string().default(""),
  HOSTING_CLOUDFLARED_CONFIG: z.string().default("/etc/cloudflared/config.yml"),
  HOSTING_RUNTIME_DIR: z.string().default("/usr/local/lib/nifhost"),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Only report variable names and reasons, never values.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
