import fs from "node:fs/promises";
import path from "node:path";
import { exists } from "./fsutil.js";
import { RelPath, type AppOptions, type RuntimeKind } from "./model.js";

export interface RuntimeInfo {
  kind: RuntimeKind;
  label: string;
  /** Served by the gateway from files; no process. */
  static: boolean;
  /** Human-readable copy of the builder allowlist (backend/runtime/builder.mjs is canonical). */
  buildSteps: string[];
  requires: string[];
}

export const RUNTIME_INFO: Record<RuntimeKind, RuntimeInfo> = {
  static: { kind: "static", label: "Website statis (HTML/CSS/JS)", static: true, buildSteps: [], requires: [] },
  vite: {
    kind: "vite",
    label: "React / Vite",
    static: true,
    buildSteps: ["npm ci (atau npm install tanpa lockfile)", "npm run build"],
    requires: ["node", "npm"],
  },
  nextjs: {
    kind: "nextjs",
    label: "Next.js",
    static: false,
    buildSteps: ["npm ci", "npm run build"],
    requires: ["node", "npm"],
  },
  node: {
    kind: "node",
    label: "Node.js / Express / API",
    static: false,
    buildSteps: ["npm ci", "npm run build --if-present", "npm prune --omit=dev"],
    requires: ["node", "npm"],
  },
  laravel: {
    kind: "laravel",
    label: "Laravel",
    static: false,
    buildSteps: ["composer install --no-dev --optimize-autoloader", "npm ci && npm run build (jika ada script build)"],
    requires: ["php", "composer"],
  },
  php: {
    kind: "php",
    label: "PHP",
    static: false,
    buildSteps: ["composer install --no-dev (jika ada composer.json)"],
    requires: ["php"],
  },
};

const defaultsFor = (kind: RuntimeKind): AppOptions =>
  kind === "static" ? { outputDir: "." } : kind === "vite" ? { outputDir: "dist" } : kind === "php" ? { docroot: "." } : {};

export const withDefaults = (kind: RuntimeKind, options: AppOptions): AppOptions => ({ ...defaultsFor(kind), ...options });

async function readPackageJson(dir: string): Promise<Record<string, unknown> | null> {
  const file = path.join(dir, "package.json");
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > 1024 * 1024) return null;
    const v = JSON.parse(await fs.readFile(file, "utf8"));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const sub = (dir: string, rel: string | undefined) => (rel && rel !== "." ? path.join(dir, ...rel.split("/")) : dir);
const hasDep = (pkg: Record<string, unknown>, name: string) =>
  [pkg.dependencies, pkg.devDependencies].some((d) => !!d && typeof d === "object" && name in (d as object));
const hasScript = (pkg: Record<string, unknown>, name: string) =>
  !!pkg.scripts && typeof pkg.scripts === "object" && typeof (pkg.scripts as Record<string, unknown>)[name] === "string";

/**
 * Checks an extracted source tree before building. Returns resolved options
 * (e.g. the Node entry file) or throws a message for the administrator.
 */
export async function checkSource(kind: RuntimeKind, dir: string, options: AppOptions): Promise<AppOptions> {
  const opts = withDefaults(kind, options);
  const pkg = await readPackageJson(dir);
  switch (kind) {
    case "static":
      if (!(await exists(path.join(sub(dir, opts.outputDir), "index.html")))) throw new Error(`index.html tidak ditemukan di ${opts.outputDir}`);
      return opts;
    case "vite":
      if (!pkg || !hasScript(pkg, "build")) throw new Error("package.json dengan script \"build\" wajib untuk React/Vite");
      return opts;
    case "nextjs":
      if (!pkg || !hasDep(pkg, "next") || !hasScript(pkg, "build")) throw new Error("package.json harus memiliki dependency \"next\" dan script \"build\"");
      return opts;
    case "node": {
      if (!pkg) throw new Error("package.json tidak ditemukan");
      // The entry may be produced by `npm run build` (e.g. dist/server.js); existence is checked after the build.
      const main = typeof pkg.main === "string" ? pkg.main.replace(/^\.\//, "") : undefined;
      const entry =
        opts.entry ?? (main && RelPath.safeParse(main).success ? main : await firstExisting(dir, ["server.js", "index.js", "app.js"]));
      if (!entry) throw new Error("File entry Node.js tidak ditemukan; isi opsi entry, mis. dist/server.js");
      return { ...opts, entry };
    }
    case "laravel":
      for (const f of ["artisan", "composer.json", "public/index.php"]) {
        if (!(await exists(path.join(dir, ...f.split("/"))))) throw new Error(`${f} tidak ditemukan — bukan proyek Laravel`);
      }
      return opts;
    case "php": {
      const root = sub(dir, opts.docroot);
      if (!(await exists(path.join(root, "index.php"))) && !(await exists(path.join(root, "index.html")))) {
        throw new Error(`index.php tidak ditemukan di ${opts.docroot}`);
      }
      return opts;
    }
  }
}

async function firstExisting(dir: string, names: string[]) {
  for (const n of names) if (await exists(path.join(dir, n))) return n;
  return null;
}

/** Verifies the build produced what the runtime needs before it can go live. */
export async function checkOutput(kind: RuntimeKind, dir: string, opts: AppOptions): Promise<void> {
  const need: Record<RuntimeKind, string[]> = {
    static: [path.join(opts.outputDir ?? ".", "index.html")],
    vite: [path.join(opts.outputDir ?? "dist", "index.html")],
    nextjs: [".next/BUILD_ID"],
    node: [opts.entry ?? "server.js"],
    laravel: ["vendor/autoload.php", "public/index.php"],
    php: [],
  };
  for (const rel of need[kind]) {
    if (!(await exists(path.join(dir, ...rel.split(/[\\/]/))))) throw new Error(`Hasil build tidak lengkap: ${rel.replace(/\\/g, "/")} tidak ada`);
  }
}

/** Values for apps/<id>/run.env, consumed by the nifapp-run launcher (which re-validates them). */
export function runEnv(kind: RuntimeKind, releaseId: string, port: number, opts: AppOptions): Record<string, string> {
  const env: Record<string, string> = { NIF_RUNTIME: kind, NIF_RELEASE: releaseId, NIF_PORT: String(port) };
  if (kind === "node") env.NIF_ENTRY = opts.entry ?? "server.js";
  if (kind === "php") env.NIF_DOCROOT = opts.docroot ?? ".";
  return env;
}
