import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { EventLog } from "../lib/events.js";
import { ArchiveError, defaultLimits, extractZip, inspectZip, isSkippedPath } from "./archive.js";
import { AuditLog } from "./audit.js";
import { dnsStatus, hostMatches, readTunnelConfig, tunnelCommands, tunnelSnippet, type DnsStatus } from "./domains.js";
import type { HostExecutor, UnitAction, UnitState } from "./executor.js";
import { normalizeModes, treeStats, writeFileAtomic } from "./fsutil.js";
import { checkRepoSource, normalizeRepoUrl, SourceError, systemResolver, type Resolver } from "./git.js";
import { httpProbe, waitHealthy, type HealthProbe, type ProbeResult } from "./health.js";
import {
  envKeyProblem,
  isProcessRuntime,
  newId,
  type AppOptions,
  type AppRecord,
  type CreateAppBody,
  type DatabaseBody,
  type DeploymentRecord,
  type EnvBody,
  type ReleaseRecord,
  type UpdateAppBody,
} from "./model.js";
import { HostingPaths } from "./paths.js";
import { detectPrerequisites, type Prerequisites } from "./prereqs.js";
import { Registry, RegistryConflict } from "./registry.js";
import { checkOutput, checkSource, RUNTIME_INFO, runEnv, withDefaults } from "./runtimes.js";
import { clampLog, createRedactor } from "./sanitize.js";
import { buildEnv, envLine, SecretStore } from "./secrets.js";

/** Error with an HTTP status and a message that is safe to return to the client. */
export class HostingError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const KEEP_RELEASES = 5;
const MAX_RELEASE_BYTES = 2 * 1024 ** 3;
const INTERNAL_SUFFIX = ".nifhost.internal";

const BuildResult = z.object({
  ok: z.boolean(),
  phase: z.string(),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/).nullable().optional(),
  error: z.string().max(500).nullable().optional(),
});

export interface HostingDeps {
  env: Env;
  events: EventLog;
  executor: HostExecutor;
  probe?: HealthProbe;
  resolver?: Resolver;
  healthTimeoutMs?: number;
  portFree?: (port: number) => Promise<boolean>;
  dnsCheck?: (domain: string) => Promise<DnsStatus>;
}

const defaultPortFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });

type AppStatus = "running" | "starting" | "stopped" | "failed" | "deploying" | "not_deployed" | "unknown";

const list = (csv: string) => csv.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const short = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

export class HostingService {
  readonly paths: HostingPaths;
  readonly registry: Registry;
  readonly secrets: SecretStore;
  readonly audit: AuditLog;
  private readonly probe: HealthProbe;
  private readonly resolver: Resolver;
  private readonly portFree: (port: number) => Promise<boolean>;
  private readonly dnsCheck: (domain: string) => Promise<DnsStatus>;
  private readonly gitHosts: string[];
  private readonly reserved: string[];
  private busy: { appId: string; deploymentId: string } | null = null;
  private job: Promise<void> = Promise.resolve();
  private health = new Map<string, ProbeResult>();
  private prereqCache: { at: number; value: Prerequisites } | null = null;
  initError: string | null = null;

  constructor(private readonly deps: HostingDeps) {
    const env = deps.env;
    this.paths = new HostingPaths(env.HOSTING_ROOT);
    this.registry = new Registry(this.paths.registry);
    this.secrets = new SecretStore(this.paths);
    this.audit = new AuditLog(this.paths.audit, deps.events);
    this.probe = deps.probe ?? httpProbe;
    this.resolver = deps.resolver ?? systemResolver;
    this.portFree = deps.portFree ?? defaultPortFree;
    this.dnsCheck = deps.dnsCheck ?? dnsStatus;
    this.gitHosts = list(env.HOSTING_GIT_HOSTS);
    this.reserved = list(env.HOSTING_RESERVED_HOSTS);
  }

  get executorKind() {
    return this.deps.executor.kind;
  }

  // ------------------------------------------------------------------ lifecycle

  async init() {
    try {
      await fs.mkdir(this.paths.apps, { recursive: true });
      await fs.rm(this.paths.tmp, { recursive: true, force: true });
      await fs.mkdir(this.paths.tmp, { recursive: true, mode: 0o700 });
      await this.registry.load();
    } catch (err) {
      this.initError = err instanceof Error ? err.message : "init failed";
      console.error(`[hosting] not available: ${this.initError}`);
      return;
    }

    // Deployments cut off by a backend restart never activated anything: mark and clean them.
    for (const app of this.registry.list()) {
      const stale = app.deployments.filter((d) => d.status === "running");
      if (!stale.length) continue;
      for (const d of stale) if (d.releaseId !== app.activeReleaseId && d.kind === "deploy") await this.removeRelease(app.id, d.releaseId);
      await this.registry.update(app.id, (a) => {
        for (const d of a.deployments) {
          if (d.status === "running") Object.assign(d, { status: "failed", finishedAt: new Date().toISOString(), message: "Terputus karena backend restart" });
        }
        return a;
      });
    }
    await this.writeRoutes();
    if (this.deps.executor.kind === "systemd") void this.reconcile();
  }

  /** Starts apps that should be running (e.g. after a reboot). */
  private async reconcile() {
    const apps = this.registry.list().filter((a) => isProcessRuntime(a.runtime) && a.desiredState === "running" && a.activeReleaseId);
    if (!apps.length) return;
    try {
      const states = await this.deps.executor.unitStates(apps.map((a) => a.id));
      for (const a of apps) {
        const s = states.get(a.id)?.activeState;
        if (s === "inactive" || s === "failed") {
          await this.deps.executor.unitAction(a.id, "start");
          await this.audit.record("system", "reconcile", a.id, "Aplikasi dijalankan ulang saat backend start");
        }
      }
    } catch {
      console.error("[hosting] reconcile failed");
    }
  }

  private ready() {
    if (this.initError) throw new HostingError(503, `Hosting Manager belum siap: ${this.initError}`);
  }

  /** Resolves when the current background deployment (if any) has finished. */
  waitIdle() {
    return this.job;
  }

  // ------------------------------------------------------------------ views

  requireApp(id: string) {
    this.ready();
    const app = this.registry.get(id);
    if (!app) throw new HostingError(404, "Aplikasi tidak ditemukan");
    return app;
  }

  private internalHost(id: string) {
    return `${id}${INTERNAL_SUFFIX}`;
  }

  private status(app: AppRecord, unit: UnitState | undefined): AppStatus {
    if (this.busy?.appId === app.id) return "deploying";
    if (!app.activeReleaseId) return "not_deployed";
    if (!isProcessRuntime(app.runtime)) return app.desiredState === "running" ? "running" : "stopped";
    switch (unit?.activeState) {
      case "active": return "running";
      case "activating": return "starting";
      case "failed": return "failed";
      case "inactive": case "deactivating": return "stopped";
      default: return "unknown";
    }
  }

  private async probeApp(app: AppRecord, force = false): Promise<ProbeResult | null> {
    if (!app.activeReleaseId || app.desiredState !== "running") return null;
    const cached = this.health.get(app.id);
    if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < 30_000) return cached;
    const result = await this.probe(this.probeTarget(app));
    this.health.set(app.id, result);
    return result;
  }

  private probeTarget(app: AppRecord) {
    return isProcessRuntime(app.runtime)
      ? { port: app.port!, path: app.healthPath }
      : { port: this.deps.env.HOSTING_GATEWAY_PORT, path: app.healthPath, host: this.internalHost(app.id), expectRelease: app.activeReleaseId ?? undefined };
  }

  private view(app: AppRecord, unit: UnitState | undefined, health: ProbeResult | null) {
    return {
      id: app.id,
      name: app.name,
      runtime: app.runtime,
      runtimeLabel: RUNTIME_INFO[app.runtime].label,
      deployMethod: app.deployMethod,
      repo: app.repo,
      domains: app.domains,
      urls: app.domains.map((d) => `https://${d}`),
      port: app.port,
      healthPath: app.healthPath,
      options: app.options,
      desiredState: app.desiredState,
      status: this.status(app, unit),
      unit: unit ?? null,
      health: health ? { status: health.ok ? "up" : "down", httpStatus: health.status, checkedAt: health.checkedAt } : { status: "unchecked", httpStatus: null, checkedAt: null },
      activeRelease: app.releases.find((r) => r.id === app.activeReleaseId) ?? null,
      lastDeployment: app.deployments[app.deployments.length - 1] ?? null,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    };
  }

  async listApps() {
    this.ready();
    const apps = this.registry.list();
    const proc = apps.filter((a) => isProcessRuntime(a.runtime) && a.activeReleaseId);
    let units = new Map<string, UnitState>();
    try {
      units = await this.deps.executor.unitStates(proc.map((a) => a.id));
    } catch {
      /* unknown state is shown */
    }
    return Promise.all(apps.map(async (a) => this.view(a, units.get(a.id), await this.probeApp(a))));
  }

  async getApp(id: string) {
    const app = this.requireApp(id);
    let unit: UnitState | undefined;
    if (isProcessRuntime(app.runtime) && app.activeReleaseId) {
      try {
        unit = (await this.deps.executor.unitStates([id])).get(id);
      } catch {
        /* unknown */
      }
    }
    const secrets = await this.secrets.read(id);
    return {
      ...this.view(app, unit, await this.probeApp(app)),
      internalHost: this.internalHost(id),
      buildSteps: RUNTIME_INFO[app.runtime].buildSteps,
      releases: [...app.releases].reverse(),
      deployments: [...app.deployments].reverse(),
      // Secret values never leave the server: only whether one is set.
      env: app.env.map((e) => ({ key: e.key, secret: e.secret, value: e.secret ? null : e.value, set: e.secret ? e.key in secrets.env : true })),
      database: app.database,
      gitTokenSet: app.gitTokenSet,
    };
  }

  async prerequisites(force = false) {
    if (!force && this.prereqCache && Date.now() - this.prereqCache.at < 30_000) return this.prereqCache.value;
    const value = await detectPrerequisites(this.deps.executor, {
      root: this.paths.root,
      runtimeDir: this.deps.env.HOSTING_RUNTIME_DIR,
      gatewayPort: this.deps.env.HOSTING_GATEWAY_PORT,
      cloudflaredConfig: this.deps.env.HOSTING_CLOUDFLARED_CONFIG,
    });
    this.prereqCache = { at: Date.now(), value };
    return value;
  }

  async deploymentLog(id: string, deploymentId: string) {
    const app = this.requireApp(id);
    if (!app.deployments.some((d) => d.id === deploymentId)) throw new HostingError(404, "Deployment tidak ditemukan");
    let text = "";
    try {
      text = await fs.readFile(this.paths.deployLog(id, deploymentId), "utf8");
    } catch {
      /* no log yet */
    }
    // Re-scrub with the current secret set in case a value changed since the log was written.
    return createRedactor(await this.secrets.values(id))(text);
  }

  async domainStatus(id: string) {
    const app = this.requireApp(id);
    const tunnel = await readTunnelConfig(this.deps.env.HOSTING_CLOUDFLARED_CONFIG);
    const port = this.deps.env.HOSTING_GATEWAY_PORT;
    const domains = await Promise.all(
      app.domains.map(async (d) => {
        const rule = tunnel.rules.find((r) => hostMatches(r.hostname, d));
        return {
          domain: d,
          dns: await this.dnsCheck(d),
          tunnel: tunnel.status !== "ok" ? tunnel.status : !rule ? "missing" : rule.service.replace(/\/$/, "").endsWith(`:${port}`) ? "configured" : "wrong-target",
          tunnelService: rule?.service ?? null,
        };
      }),
    );
    return {
      gatewayPort: port,
      internalHost: this.internalHost(id),
      baseDomain: this.deps.env.HOSTING_BASE_DOMAIN || null,
      tunnelConfig: tunnel.status,
      domains,
      snippet: app.domains.length ? tunnelSnippet(app.domains, port) : null,
      commands: app.domains.length ? tunnelCommands(app.domains) : [],
    };
  }

  auditList(limit: number) {
    return this.audit.list(limit);
  }

  // ------------------------------------------------------------------ app config

  private checkDomains(domains: string[], selfId: string | null) {
    const seen = new Set<string>();
    for (const d of domains) {
      if (seen.has(d)) throw new HostingError(400, `Domain duplikat: ${d}`);
      seen.add(d);
      if (this.reserved.some((r) => hostMatches(r, d)) || d.endsWith(INTERNAL_SUFFIX)) throw new HostingError(400, `Domain ${d} dicadangkan dan tidak boleh dipakai`);
      const owner = this.registry.list().find((a) => a.id !== selfId && a.domains.includes(d));
      if (owner) throw new HostingError(409, `Domain ${d} sudah dipakai aplikasi ${owner.id}`);
    }
  }

  private async checkRepo(url: string) {
    try {
      return (await checkRepoSource(url, this.gitHosts, this.resolver)).url;
    } catch (err) {
      if (err instanceof SourceError) throw new HostingError(400, err.message);
      throw err;
    }
  }

  private async allocatePort() {
    const { HOSTING_PORT_MIN: min, HOSTING_PORT_MAX: max, HOSTING_GATEWAY_PORT: gw } = this.deps.env;
    const used = new Set(this.registry.list().map((a) => a.port));
    for (let p = min; p <= max; p++) if (p !== gw && !used.has(p) && (await this.portFree(p))) return p;
    throw new HostingError(409, "Tidak ada port kosong di rentang hosting");
  }

  async createApp(body: z.infer<typeof CreateAppBody>, actor: string) {
    this.ready();
    if (this.registry.get(body.id)) throw new HostingError(409, "ID aplikasi sudah dipakai");
    this.checkDomains(body.domains, null);
    const repo = body.repo ? { url: await this.checkRepo(body.repo.url), branch: body.repo.branch } : null;
    const now = new Date().toISOString();
    const app: AppRecord = {
      id: body.id,
      name: body.name,
      runtime: body.runtime,
      deployMethod: body.deployMethod,
      repo,
      domains: body.domains,
      port: isProcessRuntime(body.runtime) ? await this.allocatePort() : null,
      healthPath: body.healthPath,
      options: withDefaults(body.runtime, body.options),
      env: [],
      database: { type: "none", host: null, port: null, name: null, user: null, passwordSet: false },
      gitTokenSet: false,
      desiredState: "running",
      activeReleaseId: null,
      releases: [],
      deployments: [],
      createdAt: now,
      updatedAt: now,
    };
    const secrets = { env: {} as Record<string, string>, dbPassword: null, gitToken: null };
    if (app.runtime === "laravel") {
      app.env = [
        { key: "APP_ENV", secret: false, value: "production" },
        { key: "APP_DEBUG", secret: false, value: "false" },
        { key: "LOG_CHANNEL", secret: false, value: "stderr" },
        { key: "APP_KEY", secret: true, value: null },
      ];
      secrets.env.APP_KEY = `base64:${crypto.randomBytes(32).toString("base64")}`;
    }

    // The insert is the atomic claim on the id and port; only then touch the app's files.
    try {
      await this.registry.insert(app);
    } catch (err) {
      if (err instanceof RegistryConflict) throw new HostingError(409, err.message);
      throw err;
    }
    try {
      // Shared with the build user via the setgid nifhost group (see install.sh).
      for (const dir of [this.paths.app(app.id), this.paths.releases(app.id), this.paths.build(app.id)]) {
        await fs.mkdir(dir, { recursive: true });
        if (process.platform !== "win32") await fs.chmod(dir, 0o2775);
      }
      await fs.mkdir(this.paths.logs(app.id), { recursive: true, mode: 0o750 });
      await this.secrets.write(app, secrets);
    } catch (err) {
      await this.registry.update(app.id, () => null).catch(() => undefined);
      throw err;
    }
    await this.audit.record(actor, "app.create", app.id, `Aplikasi dibuat (${RUNTIME_INFO[app.runtime].label}, deploy ${app.deployMethod})`);
    return this.getApp(app.id);
  }

  async updateApp(id: string, body: z.infer<typeof UpdateAppBody>, actor: string) {
    const app = this.requireApp(id);
    const repo = body.repo === undefined ? app.repo : body.repo === null ? null : { url: await this.checkRepo(body.repo.url), branch: body.repo.branch };
    const method = body.deployMethod ?? app.deployMethod;
    if (method === "github" && !repo) throw new HostingError(400, "Repository wajib untuk deploy GitHub");
    await this.registry.update(id, (a) => ({
      ...a,
      name: body.name ?? a.name,
      deployMethod: method,
      repo,
      healthPath: body.healthPath ?? a.healthPath,
      options: body.options ? withDefaults(a.runtime, body.options) : a.options,
    }));
    const changed = Object.keys(body).join(", ");
    await this.audit.record(actor, "app.update", id, `Pengaturan diubah (${changed || "tidak ada"})`);
    return this.getApp(id);
  }

  async setDomains(id: string, domains: string[], actor: string) {
    const app = this.requireApp(id);
    this.checkDomains(domains, id);
    await this.registry.update(id, (a) => ({ ...a, domains }));
    await this.writeRoutes();
    await this.audit.record(actor, "domain.update", id, `Domain diubah: ${app.domains.join(", ") || "-"} → ${domains.join(", ") || "-"}`);
    return this.getApp(id);
  }

  async setEnv(id: string, body: z.infer<typeof EnvBody>, actor: string) {
    const app = this.requireApp(id);
    const current = await this.secrets.read(id);
    const keys = new Set<string>();
    const nextEnv: AppRecord["env"] = [];
    const nextSecrets: Record<string, string> = {};
    for (const v of body.vars) {
      const problem = envKeyProblem(v.key);
      if (problem) throw new HostingError(400, problem);
      if (keys.has(v.key)) throw new HostingError(400, `Variabel duplikat: ${v.key}`);
      keys.add(v.key);
      if (v.secret) {
        const value = v.value ?? current.env[v.key];
        if (value === undefined) throw new HostingError(400, `${v.key}: nilai wajib diisi untuk secret baru`);
        nextSecrets[v.key] = value;
        nextEnv.push({ key: v.key, secret: true, value: null });
      } else {
        nextEnv.push({ key: v.key, secret: false, value: v.value ?? "" });
      }
    }
    const updated = (await this.registry.update(id, (a) => ({ ...a, env: nextEnv })))!;
    await this.secrets.write(updated, { ...current, env: nextSecrets });
    const secretCount = nextEnv.filter((e) => e.secret).length;
    await this.audit.record(actor, "env.update", id, `Environment diperbarui: ${nextEnv.length} variabel (${secretCount} secret)`);
    return { app: await this.getApp(id), restartRequired: isProcessRuntime(app.runtime) && !!app.activeReleaseId, rebuildRequired: !isProcessRuntime(app.runtime) };
  }

  async setDatabase(id: string, body: z.infer<typeof DatabaseBody>, actor: string) {
    this.requireApp(id);
    const current = await this.secrets.read(id);
    const server = body.type === "mysql" || body.type === "postgresql";
    if (server && (!body.name || !body.user)) throw new HostingError(400, "Nama database dan user wajib diisi");
    const password = server ? (body.password ?? current.dbPassword) : null;
    const database: AppRecord["database"] = server
      ? { type: body.type, host: body.host ?? "127.0.0.1", port: body.port ?? (body.type === "mysql" ? 3306 : 5432), name: body.name!, user: body.user!, passwordSet: !!password }
      : { type: body.type, host: null, port: null, name: null, user: null, passwordSet: false };
    const updated = (await this.registry.update(id, (a) => ({ ...a, database })))!;
    await this.secrets.write(updated, { ...current, dbPassword: password });
    await this.audit.record(actor, "database.update", id, `Database diatur: ${body.type}${server ? ` (${database.name}@${database.host})` : ""}`);
    return this.getApp(id);
  }

  async setGitToken(id: string, token: string | null, actor: string) {
    this.requireApp(id);
    const current = await this.secrets.read(id);
    const updated = (await this.registry.update(id, (a) => ({ ...a, gitTokenSet: !!token })))!;
    await this.secrets.write(updated, { ...current, gitToken: token });
    await this.audit.record(actor, "git-token.update", id, token ? "Token deploy GitHub disimpan" : "Token deploy GitHub dihapus");
    return this.getApp(id);
  }

  async action(id: string, action: UnitAction, actor: string) {
    const app = this.requireApp(id);
    if (this.busy?.appId === id) throw new HostingError(409, "Deployment sedang berjalan untuk aplikasi ini");
    if (!app.activeReleaseId) throw new HostingError(409, "Aplikasi belum pernah di-deploy");
    if (isProcessRuntime(app.runtime)) {
      try {
        await this.deps.executor.unitAction(id, action);
      } catch {
        await this.audit.record(actor, `service.${action}`, id, `Aksi ${action} gagal`, "error");
        throw new HostingError(502, `Aksi ${action} gagal. Periksa prasyarat (polkit/unit) dan journalctl -u nifapp@${id}`);
      }
    }
    // For static sites start/stop publishes/unpublishes the gateway route.
    await this.registry.update(id, (a) => ({ ...a, desiredState: action === "stop" ? "stopped" : "running" }));
    await this.writeRoutes();
    this.health.delete(id);
    await this.audit.record(actor, `service.${action}`, id, `Aplikasi di-${action}`);
    return this.getApp(id);
  }

  async deleteApp(id: string, actor: string) {
    const app = this.requireApp(id);
    if (this.busy?.appId === id) throw new HostingError(409, "Deployment sedang berjalan untuk aplikasi ini");
    if (isProcessRuntime(app.runtime) && app.activeReleaseId) {
      await this.deps.executor.unitAction(id, "stop").catch(() => undefined);
    }
    // Unpublish first, then remove releases while the registry entry still exists:
    // the fallback cleanup (builder "clean" phase) needs it for build-owned files.
    await this.registry.update(id, (a) => ({ ...a, desiredState: "stopped" }));
    await this.writeRoutes();
    for (const r of app.releases) if (r.status === "ready") await this.removeRelease(id, r.id);
    await this.registry.update(id, () => null);
    await fs.rm(this.paths.app(id), { recursive: true, force: true }).catch(() => console.error(`[hosting] could not fully remove ${id}`));
    this.health.delete(id);
    await this.audit.record(actor, "app.delete", id, `Aplikasi dihapus (${app.releases.length} rilis)`, "warning");
  }

  // ------------------------------------------------------------------ routes

  /** Gateway routing table, rewritten atomically. The gateway re-reads it on change. */
  async writeRoutes() {
    const routes: Record<string, unknown> = {};
    for (const a of this.registry.list()) {
      if (!a.activeReleaseId || a.desiredState !== "running") continue;
      const dir = this.paths.release(a.id, a.activeReleaseId);
      const target = isProcessRuntime(a.runtime)
        ? { app: a.id, release: a.activeReleaseId, type: "proxy", port: a.port }
        : { app: a.id, release: a.activeReleaseId, type: "static", root: a.options.outputDir && a.options.outputDir !== "." ? path.join(dir, ...a.options.outputDir.split("/")) : dir, spa: a.runtime === "vite" };
      for (const host of [...a.domains, this.internalHost(a.id)]) routes[host] = target;
    }
    await writeFileAtomic(this.paths.routes, JSON.stringify({ version: 1, routes }, null, 2), 0o644);
  }

  // ------------------------------------------------------------------ deployments

  private claim(app: AppRecord) {
    if (this.busy) {
      throw new HostingError(409, this.busy.appId === app.id ? "Deployment untuk aplikasi ini sedang berjalan" : `Deployment lain sedang berjalan (${this.busy.appId}); tunggu hingga selesai`);
    }
    const deploymentId = newId("d");
    this.busy = { appId: app.id, deploymentId };
    return deploymentId;
  }

  async deployUpload(id: string, zipPath: string, actor: string) {
    let app: AppRecord;
    try {
      app = this.requireApp(id);
      // Validate the whole central directory before accepting the job.
      await inspectZip(zipPath, defaultLimits(this.deps.env.HOSTING_MAX_EXTRACTED_MB * 1024 * 1024));
    } catch (err) {
      await fs.rm(zipPath, { force: true });
      if (err instanceof ArchiveError) {
        await this.audit.record(actor, "deploy.rejected", id, `Upload ZIP ditolak: ${short(err.message, 160)}`, "warning");
        throw new HostingError(400, err.message);
      }
      throw err;
    }
    let deploymentId: string;
    try {
      deploymentId = this.claim(app);
    } catch (err) {
      await fs.rm(zipPath, { force: true });
      throw err;
    }
    return this.startDeploy(app, deploymentId, "upload", actor, async (dir, log) => {
      try {
        const r = await extractZip(zipPath, dir, defaultLimits(this.deps.env.HOSTING_MAX_EXTRACTED_MB * 1024 * 1024));
        await normalizeModes(dir);
        await log(`Arsip diekstrak: ${r.files} file, ${(r.bytes / 1048576).toFixed(1)} MB${r.skipped ? `, ${r.skipped} entri dilewati (.git, node_modules, .env)` : ""}${r.stripped ? `, folder induk "${r.stripped}" dilepas` : ""}`);
        return null;
      } finally {
        await fs.rm(zipPath, { force: true });
      }
    });
  }

  async deployGithub(id: string, actor: string) {
    const app = this.requireApp(id);
    if (!app.repo) throw new HostingError(400, "Repository GitHub belum diatur");
    // Re-validate URL and DNS on every deploy (records can change after creation).
    const url = await this.checkRepo(app.repo.url);
    const branch = app.repo.branch;
    const deploymentId = this.claim(app);
    return this.startDeploy(app, deploymentId, "github", actor, async (_dir, log, releaseId) => {
      await log(`Clone ${normalizeRepoUrl(url, this.gitHosts).slug} branch ${branch} (depth 1, tanpa submodule, redirect dimatikan)`);
      const result = await this.runPhase(app, { phase: "fetch", releaseId, repo: { url, branch } }, log);
      return result.commit ?? null;
    });
  }

  private async runPhase(app: AppRecord, plan: Record<string, unknown>, log: (l: string) => Promise<void>) {
    await fs.rm(this.paths.result(app.id), { force: true });
    await fs.rm(this.paths.buildLog(app.id), { force: true });
    const full = {
      version: 1,
      appId: app.id,
      runtime: app.runtime,
      options: app.options,
      buildEnv: buildEnv(app),
      maxReleaseBytes: MAX_RELEASE_BYTES,
      ...plan,
    };
    await writeFileAtomic(this.paths.plan(app.id), JSON.stringify(full, null, 2), 0o644);
    const run = await this.deps.executor.runBuilder(app.id);
    let builderLog = "";
    try {
      builderLog = await fs.readFile(this.paths.buildLog(app.id), "utf8");
    } catch {
      /* builder did not start */
    }
    if (builderLog) await log(clampLog(builderLog.trimEnd(), 200 * 1024));
    let result: z.infer<typeof BuildResult>;
    try {
      result = BuildResult.parse(JSON.parse(await fs.readFile(this.paths.result(app.id), "utf8")));
    } catch {
      throw new Error(`Builder tidak menghasilkan result.json${run.detail ? ` (${short(run.detail, 160)})` : ""}. Periksa prasyarat dan journalctl -u nifbuild@${app.id}`);
    }
    if (!result.ok) throw new Error(result.error ?? `Fase ${String(plan.phase)} gagal`);
    return result;
  }

  private async removeRelease(appId: string, releaseId: string) {
    const dir = this.paths.release(appId, releaseId);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // Files written by the build user: let the builder (their owner) remove them.
      const app = this.registry.get(appId);
      if (app && this.deps.executor.kind === "systemd") {
        await this.runPhase(app, { phase: "clean", releaseId }, async () => undefined).catch(() => undefined);
        await fs.rm(dir, { recursive: true, force: true }).catch(() => console.error(`[hosting] could not remove release ${releaseId}`));
      }
    }
  }

  private startDeploy(
    app: AppRecord,
    deploymentId: string,
    method: "upload" | "github",
    actor: string,
    fetchSource: (dir: string, log: (l: string) => Promise<void>, releaseId: string) => Promise<string | null>,
  ) {
    const releaseId = newId("r");
    const record: DeploymentRecord = { id: deploymentId, kind: "deploy", method, releaseId, status: "running", startedAt: new Date().toISOString(), finishedAt: null, message: "Berjalan" };
    const started = this.registry.update(app.id, (a) => ({ ...a, deployments: [...a.deployments, record] }));

    this.job = started
      .then(async () => {
        await this.audit.record(actor, "deploy.start", app.id, `Deploy ${method} dimulai (${deploymentId})`);
        const log = await this.logger(app.id, deploymentId);
        const dir = this.paths.release(app.id, releaseId);
        try {
          await fs.mkdir(dir, { recursive: true });
          if (process.platform !== "win32") await fs.chmod(dir, 0o2775);
          await log(`Deployment ${deploymentId} → rilis ${releaseId} (${RUNTIME_INFO[app.runtime].label})`);
          const commit = await fetchSource(dir, log, releaseId);
          if (commit) await log(`Commit ${commit}`);

          await this.pruneSkipped(dir);
          const stats = await treeStats(dir);
          if (stats.symlinks.length) throw new Error(`Sumber berisi symlink (${stats.symlinks.slice(0, 3).join(", ")}); ditolak`);
          await log(`Sumber diperiksa: ${stats.files} file, tanpa symlink`);

          const opts = await checkSource(app.runtime, dir, app.options);
          let current = (await this.registry.update(app.id, (a) => ({ ...a, options: opts })))!;

          if (app.runtime !== "static") {
            await log(`Build: ${RUNTIME_INFO[app.runtime].buildSteps.join(" → ")}`);
            await this.runPhase(current, { phase: "build", releaseId }, log);
          }
          await checkOutput(app.runtime, dir, opts);
          const size = (await treeStats(dir)).bytes;
          if (size > MAX_RELEASE_BYTES) throw new Error("Ukuran rilis melebihi 2 GB");

          const release: ReleaseRecord = { id: releaseId, createdAt: new Date().toISOString(), source: method, commit, sizeBytes: size, status: "ready" };
          current = (await this.registry.update(app.id, (a) => ({ ...a, releases: [...a.releases, release] })))!;

          const outcome = await this.activate(current, releaseId, log);
          await this.finish(app.id, deploymentId, outcome.status, outcome.message);
          await this.audit.record(actor, outcome.status === "succeeded" ? "deploy.success" : "deploy.failed", app.id, `Deploy ${deploymentId}: ${outcome.message}`, outcome.status === "succeeded" ? "info" : "error");
          if (outcome.status === "succeeded") await this.pruneReleases(app.id);
          else await this.dropRelease(app.id, releaseId);
        } catch (err) {
          const message = short(createRedactor(await this.secrets.values(app.id))(err instanceof Error ? err.message : "Deployment gagal"));
          await log(`GAGAL: ${message}`);
          await log("Rilis aktif tidak diubah.");
          await this.dropRelease(app.id, releaseId);
          await this.finish(app.id, deploymentId, "failed", message);
          await this.audit.record(actor, "deploy.failed", app.id, `Deploy ${deploymentId} gagal: ${short(message, 160)}`, "error");
        }
      })
      .catch((err) => console.error("[hosting] deployment bookkeeping failed:", err instanceof Error ? err.message : err))
      .finally(() => {
        this.busy = null;
      });
    return started.then(() => ({ deploymentId, releaseId }));
  }

  async rollback(id: string, releaseId: string, actor: string) {
    const app = this.requireApp(id);
    const release = app.releases.find((r) => r.id === releaseId);
    if (!release || release.status !== "ready") throw new HostingError(404, "Rilis tidak tersedia untuk rollback");
    if (releaseId === app.activeReleaseId) throw new HostingError(409, "Rilis tersebut sudah aktif");
    const deploymentId = this.claim(app);
    const record: DeploymentRecord = { id: deploymentId, kind: "rollback", method: "rollback", releaseId, status: "running", startedAt: new Date().toISOString(), finishedAt: null, message: "Berjalan" };
    const started = this.registry.update(id, (a) => ({ ...a, deployments: [...a.deployments, record] }));
    this.job = started
      .then(async () => {
        const log = await this.logger(id, deploymentId);
        await log(`Rollback ke rilis ${releaseId}`);
        const outcome = await this.activate(this.registry.get(id)!, releaseId, log).catch((err) => ({
          status: "failed" as const,
          message: short(err instanceof Error ? err.message : "Rollback gagal"),
        }));
        await this.finish(id, deploymentId, outcome.status, outcome.message);
        await this.audit.record(actor, "rollback", id, `Rollback ke ${releaseId}: ${outcome.message}`, outcome.status === "succeeded" ? "warning" : "error");
      })
      .catch((err) => console.error("[hosting] rollback bookkeeping failed:", err instanceof Error ? err.message : err))
      .finally(() => {
        this.busy = null;
      });
    await started;
    return { deploymentId, releaseId };
  }

  /**
   * Points the app at `releaseId` (run.env + registry + gateway routes, each
   * replaced atomically), restarts it, and health-checks it. On failure the
   * previous release is restored, so the live site is never left broken by a
   * bad deploy.
   */
  private async activate(app: AppRecord, releaseId: string, log: (l: string) => Promise<void>) {
    const previous = app.activeReleaseId;
    await this.pointTo(app, releaseId);
    await log(`Rilis ${releaseId} diaktifkan${previous ? ` (sebelumnya ${previous})` : ""}`);

    const fresh = this.registry.get(app.id)!;
    const health = await waitHealthy(this.probe, this.probeTarget(fresh), this.deps.healthTimeoutMs ?? 30_000);
    this.health.set(app.id, health);
    if (health.ok) {
      await log(`Health check OK (HTTP ${health.status})`);
      return { status: "succeeded" as const, message: `Aktif: ${releaseId}` };
    }

    await log(`Health check GAGAL (${health.status ? `HTTP ${health.status}` : "tidak merespons"})`);
    if (previous && this.registry.get(app.id)?.releases.some((r) => r.id === previous && r.status === "ready")) {
      await this.pointTo(this.registry.get(app.id)!, previous);
      await log(`Dikembalikan ke rilis sebelumnya ${previous}`);
      return { status: "rolled_back" as const, message: `Health check gagal; kembali ke ${previous}` };
    }
    // First deployment: nothing to fall back to — take it offline rather than serve a broken app.
    if (isProcessRuntime(app.runtime)) await this.deps.executor.unitAction(app.id, "stop").catch(() => undefined);
    await this.registry.update(app.id, (a) => ({ ...a, activeReleaseId: null }));
    await this.writeRoutes();
    await log("Tidak ada rilis sebelumnya; aplikasi dihentikan");
    return { status: "failed" as const, message: "Health check gagal" };
  }

  private async pointTo(app: AppRecord, releaseId: string) {
    if (isProcessRuntime(app.runtime)) {
      const vars = runEnv(app.runtime, releaseId, app.port!, app.options as AppOptions);
      await writeFileAtomic(this.paths.runEnv(app.id), Object.entries(vars).map(([k, v]) => envLine(k, v)).join("\n") + "\n", 0o644);
    }
    await this.registry.update(app.id, (a) => ({ ...a, activeReleaseId: releaseId, desiredState: "running" }));
    await this.writeRoutes();
    if (isProcessRuntime(app.runtime)) await this.deps.executor.unitAction(app.id, "restart");
  }

  private async dropRelease(appId: string, releaseId: string) {
    const app = this.registry.get(appId);
    if (!app || app.activeReleaseId === releaseId) return;
    await this.removeRelease(appId, releaseId);
    if (app.releases.some((r) => r.id === releaseId)) {
      await this.registry.update(appId, (a) => ({ ...a, releases: a.releases.map((r) => (r.id === releaseId ? { ...r, status: "failed" } : r)) }));
    }
  }

  /** Keeps the active release plus the newest KEEP_RELEASES-1 others for rollback. */
  private async pruneReleases(appId: string) {
    const app = this.registry.get(appId);
    if (!app) return;
    const ready = app.releases.filter((r) => r.status === "ready" && r.id !== app.activeReleaseId);
    const drop = ready.slice(0, Math.max(0, ready.length - (KEEP_RELEASES - 1)));
    for (const r of drop) await this.removeRelease(appId, r.id);
    if (drop.length || app.releases.length > 20) {
      const ids = new Set(drop.map((r) => r.id));
      await this.registry.update(appId, (a) => ({
        ...a,
        releases: a.releases.map((r) => (ids.has(r.id) ? { ...r, status: "removed" as const } : r)).slice(-20),
      }));
    }
  }

  private async pruneSkipped(dir: string) {
    const stack = [""];
    while (stack.length) {
      const rel = stack.pop()!;
      for (const ent of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${ent.name}` : ent.name;
        if (isSkippedPath(child)) await fs.rm(path.join(dir, child), { recursive: true, force: true });
        else if (ent.isDirectory()) stack.push(child);
      }
    }
  }

  private async finish(appId: string, deploymentId: string, status: DeploymentRecord["status"], message: string) {
    await this.registry.update(appId, (a) => ({
      ...a,
      deployments: a.deployments.map((d) => (d.id === deploymentId ? { ...d, status, message: short(message, 480), finishedAt: new Date().toISOString() } : d)),
    }));
  }

  private async logger(appId: string, deploymentId: string) {
    const redact = createRedactor(await this.secrets.values(appId));
    const file = this.paths.deployLog(appId, deploymentId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    return async (line: string) => {
      const stamped = line
        .split("\n")
        .map((l) => `[${new Date().toISOString().slice(11, 19)}] ${l}`)
        .join("\n");
      await fs.appendFile(file, redact(stamped) + "\n", { mode: 0o640 });
    };
  }
}
