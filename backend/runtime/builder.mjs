#!/usr/bin/env node
// NIFSERVER Hosting builder — ExecStart of nifbuild@<app>.service.
//
// Runs as the unprivileged `nifbuild` user inside a systemd sandbox that only
// exposes /srv/nifhost/apps/<app>/{releases,build}, blocks private networks,
// and caps CPU/RAM/tasks/time. It reads plan.json (written by the dashboard),
// validates it again, and runs ONLY the commands defined in this file —
// never a shell, never a command string taken from the plan.
//
// Self-contained on purpose (no npm dependencies): installed root-owned to
// /usr/local/lib/nifhost so neither the dashboard nor a build can modify it.

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const APP_ID_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const RELEASE_ID_RE = /^r\d{14}-[a-f0-9]{6}$/;
const REL_PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;
const REPO_RE = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}\.git$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const RUNTIMES = ["static", "vite", "nextjs", "node", "laravel", "php"];
const PHASES = ["fetch", "build", "clean"];
const BLOCKED_ENV = /^(PATH|HOME|NODE_OPTIONS|NODE_PATH|BASH_ENV|ENV|IFS|LD_.*|NIF_.*|SYSTEMD_.*|GIT_.*|NPM_CONFIG_.*|npm_config_.*|COMPOSER.*)$/i;

/** The complete set of programs a build may start. */
export const BINARIES = {
  git: ["/usr/bin/git"],
  npm: ["/usr/bin/npm", "/usr/local/bin/npm"],
  composer: ["/usr/local/bin/composer", "/usr/bin/composer"],
};

const relOk = (p) => typeof p === "string" && REL_PATH_RE.test(p) && p.split("/").every((s) => s && s !== "." && s !== ".." && !s.startsWith("."));

export function validatePlan(raw, appId) {
  const p = raw && typeof raw === "object" ? raw : {};
  const bad = (what) => {
    throw new Error(`invalid plan: ${what}`);
  };
  if (p.version !== 1) bad("version");
  if (p.appId !== appId || !APP_ID_RE.test(appId)) bad("appId");
  if (!PHASES.includes(p.phase)) bad("phase");
  if (!RELEASE_ID_RE.test(p.releaseId ?? "")) bad("releaseId");
  if (!RUNTIMES.includes(p.runtime)) bad("runtime");
  const o = p.options ?? {};
  for (const k of Object.keys(o)) if (!["outputDir", "entry", "docroot"].includes(k)) bad(`option ${k}`);
  for (const k of ["outputDir", "docroot"]) if (o[k] !== undefined && o[k] !== "." && !relOk(o[k])) bad(k);
  if (o.entry !== undefined && !relOk(o.entry)) bad("entry");
  if (p.phase === "fetch") {
    if (!p.repo || !REPO_RE.test(p.repo.url ?? "") || !BRANCH_RE.test(p.repo.branch ?? "") || p.repo.branch.includes("..")) bad("repo");
  }
  const buildEnv = {};
  for (const [k, v] of Object.entries(p.buildEnv ?? {})) {
    if (!ENV_KEY_RE.test(k) || BLOCKED_ENV.test(k) || typeof v !== "string" || /[\r\n\0]/.test(v) || v.length > 4096) bad(`buildEnv ${k}`);
    buildEnv[k] = v;
  }
  const maxReleaseBytes = Number.isInteger(p.maxReleaseBytes) && p.maxReleaseBytes > 0 ? p.maxReleaseBytes : 2 * 1024 ** 3;
  return { appId, phase: p.phase, releaseId: p.releaseId, runtime: p.runtime, options: o, repo: p.repo ?? null, buildEnv, maxReleaseBytes };
}

/**
 * The build recipe per runtime. Every step is [binary key, fixed argv].
 * `info` describes the source tree: { pkg, hasLock, hasComposer }.
 */
export function buildSteps(runtime, info) {
  const install = info.hasLock ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"];
  const hasBuild = !!info.pkg?.scripts && typeof info.pkg.scripts.build === "string";
  const composer = ["composer", ["install", "--no-dev", "--no-interaction", "--no-progress", "--prefer-dist", "--optimize-autoloader"]];
  switch (runtime) {
    case "static":
      return [];
    case "vite":
    case "nextjs":
      return [["npm", install], ["npm", ["run", "build"]]];
    case "node":
      return [["npm", install], ...(hasBuild ? [["npm", ["run", "build"]]] : []), ["npm", ["prune", "--omit=dev"]]];
    case "laravel":
      return [composer, ...(hasBuild ? [["npm", install], ["npm", ["run", "build"]]] : [])];
    case "php":
      return info.hasComposer ? [composer] : [];
    default:
      throw new Error("unsupported runtime");
  }
}

export function gitCloneArgs(url, branch, dir) {
  return [
    "-c", "protocol.allow=never",
    "-c", "protocol.https.allow=always",
    "-c", "http.followRedirects=false",
    "-c", "core.symlinks=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "submodule.recurse=false",
    "clone", "--depth", "1", "--single-branch", "--no-tags", "--no-recurse-submodules",
    "--branch", branch, "--", url, dir,
  ];
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveBinary(key) {
  for (const candidate of BINARIES[key] ?? []) if (await exists(candidate)) return candidate;
  throw new Error(`${key} tidak terpasang di server`);
}

async function treeBytes(root) {
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) bytes += (await fs.lstat(full)).size;
    }
  }
  return bytes;
}

/** Group-writable for cleanup by the dashboard, world-readable for the app's dynamic user. */
async function normalizeModes(root) {
  const stack = [root];
  await fs.chmod(root, 0o2775).catch(() => {});
  while (stack.length) {
    const dir = stack.pop();
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        await fs.chmod(full, 0o2775).catch(() => {});
        stack.push(full);
      } else if (ent.isFile()) {
        const { mode } = await fs.lstat(full);
        await fs.chmod(full, mode & 0o111 ? 0o775 : 0o664).catch(() => {});
      }
    }
  }
}

async function main() {
  const appId = process.argv[2] ?? "";
  if (!APP_ID_RE.test(appId)) throw new Error("invalid app id");
  const root = process.env.NIFHOST_ROOT || "/srv/nifhost";
  const appDir = path.join(root, "apps", appId);
  const buildDir = path.join(appDir, "build");
  const resultFile = path.join(buildDir, "result.json");
  const logStream = createWriteStream(path.join(buildDir, "build.log"), { flags: "a", mode: 0o664 });
  let logged = 0;
  const MAX_LOG = 2 * 1024 * 1024;
  const log = (text) => {
    process.stdout.write(text);
    if (logged > MAX_LOG) return;
    logged += Buffer.byteLength(text);
    logStream.write(logged > MAX_LOG ? `${text}\n[log dipotong: melebihi 2 MB]\n` : text);
  };

  const started = Date.now();
  let plan;
  let result = { ok: false, phase: "unknown", commit: null, error: null };
  try {
    plan = validatePlan(JSON.parse(await fs.readFile(path.join(buildDir, "plan.json"), "utf8")), appId);
    result.phase = plan.phase;
    const release = path.join(appDir, "releases", plan.releaseId);
    const stateDir = `/var/lib/nifhost/${appId}`;
    const home = path.join(buildDir, "home");
    await fs.mkdir(home, { recursive: true });

    const baseEnv = {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      HOME: home,
      LANG: "C.UTF-8",
      CI: "1",
      NEXT_TELEMETRY_DISABLED: "1",
      npm_config_cache: path.join(home, ".npm"),
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      COMPOSER_HOME: path.join(home, ".composer"),
      COMPOSER_NO_INTERACTION: "1",
    };

    const run = (key, args, { cwd, env, timeoutMs = 15 * 60_000 } = {}) =>
      resolveBinary(key).then(
        (bin) =>
          new Promise((resolve, reject) => {
            log(`$ ${key} ${args.join(" ")}\n`);
            const child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
            const timer = setTimeout(() => {
              log(`\n[timeout ${Math.round(timeoutMs / 60000)} menit]\n`);
              try {
                process.kill(-child.pid, "SIGKILL");
              } catch {
                /* already gone */
              }
            }, timeoutMs);
            child.stdout.on("data", (d) => log(d.toString()));
            child.stderr.on("data", (d) => log(d.toString()));
            child.on("error", (e) => {
              clearTimeout(timer);
              reject(new Error(`${key} tidak bisa dijalankan: ${e.code ?? "error"}`));
            });
            child.on("close", (code) => {
              clearTimeout(timer);
              code === 0 ? resolve() : reject(new Error(`${key} ${args[0]} gagal (exit ${code})`));
            });
          }),
      );

    if (plan.phase === "clean") {
      await fs.rm(release, { recursive: true, force: true });
      log(`release ${plan.releaseId} dihapus\n`);
    } else if (plan.phase === "fetch") {
      const entries = await fs.readdir(release);
      if (entries.length) throw new Error("folder rilis tidak kosong");
      const env = { ...baseEnv, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_LFS_SKIP_SMUDGE: "1", GIT_ALLOW_PROTOCOL: "https" };
      // Token (systemd credential) goes in as an HTTP header via env — never in argv or the URL.
      const credDir = process.env.CREDENTIALS_DIRECTORY;
      const token = credDir ? (await fs.readFile(path.join(credDir, "git-token"), "utf8").catch(() => "")).trim() : "";
      if (token) {
        const host = new URL(plan.repo.url).host;
        Object.assign(env, {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.https://${host}/.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
        });
      }
      await run("git", gitCloneArgs(plan.repo.url, plan.repo.branch, release), { cwd: buildDir, env, timeoutMs: 5 * 60_000 });
      const head = (await fs.readFile(path.join(release, ".git", "HEAD"), "utf8")).trim();
      result.commit = /^[0-9a-f]{40}$/.test(head) ? head : null;
      if (!result.commit) {
        const ref = head.replace(/^ref:\s*/, "");
        const loose = (await fs.readFile(path.join(release, ".git", ...ref.split("/")), "utf8").catch(() => "")).trim();
        const packed = (await fs.readFile(path.join(release, ".git", "packed-refs"), "utf8").catch(() => ""))
          .split("\n")
          .find((l) => l.endsWith(` ${ref}`))
          ?.split(" ")[0];
        result.commit = [loose, packed].find((s) => s && /^[0-9a-f]{40}$/.test(s)) ?? null;
      }
      await fs.rm(path.join(release, ".git"), { recursive: true, force: true });
    } else {
      const pkg = await fs.readFile(path.join(release, "package.json"), "utf8").then(JSON.parse, () => null);
      const info = {
        pkg,
        hasLock: (await exists(path.join(release, "package-lock.json"))) || (await exists(path.join(release, "npm-shrinkwrap.json"))),
        hasComposer: await exists(path.join(release, "composer.json")),
      };
      if (pkg && !info.hasLock && plan.runtime !== "static") log("[peringatan] package-lock.json tidak ada; memakai npm install (tidak reprodusibel)\n");
      for (const [key, args] of buildSteps(plan.runtime, info)) {
        const isBuild = args[0] === "run";
        await run(key, args, { cwd: release, env: { ...baseEnv, ...plan.buildEnv, ...(isBuild ? { NODE_ENV: "production" } : {}) } });
      }
      if (plan.runtime === "laravel") {
        if (pkg?.scripts?.build) await fs.rm(path.join(release, "node_modules"), { recursive: true, force: true });
        // Persistent, writable storage lives in the app's state dir, shared across releases.
        await fs.rm(path.join(release, "storage"), { recursive: true, force: true });
        await fs.symlink(`${stateDir}/storage`, path.join(release, "storage"));
      }
      if (plan.runtime === "nextjs") {
        await fs.rm(path.join(release, ".next", "cache"), { recursive: true, force: true });
        await fs.symlink(`${stateDir}/next-cache`, path.join(release, ".next", "cache"));
      }
      const bytes = await treeBytes(release);
      if (bytes > plan.maxReleaseBytes) throw new Error(`ukuran rilis ${Math.round(bytes / 1048576)} MB melebihi batas`);
    }
    if (plan.phase !== "clean") await normalizeModes(release);
    result.ok = true;
  } catch (err) {
    result.error = String(err instanceof Error ? err.message : err).slice(0, 400);
    log(`\n[gagal] ${result.error}\n`);
  } finally {
    log(`[selesai dalam ${Math.round((Date.now() - started) / 1000)} dtk]\n`);
    await new Promise((r) => logStream.end(r));
    const tmp = `${resultFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(result), { mode: 0o664 });
    await fs.rename(tmp, resultFile);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`builder: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  });
}
