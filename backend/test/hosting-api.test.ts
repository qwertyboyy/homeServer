import { MysqlAdmin, managedName } from "../src/hosting/mysql.js";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import type { CloudflareClient } from "../src/hosting/cloudflare.js";
import { SimulatedExecutor, SystemdExecutor, type HostExecutor, type UnitAction } from "../src/hosting/executor.js";
import { HostingPaths } from "../src/hosting/paths.js";
import { HostingService } from "../src/hosting/service.js";
import { EventLog } from "../src/lib/events.js";
import { mockSources } from "../src/mock.js";
import { makeZip } from "./helpers/zip.js";

const PASSWORD = "correct horse battery staple";
let hash: string;
beforeAll(async () => {
  hash = await bcrypt.hash(PASSWORD, 4);
});

/** Simulated builds with failure / log injection, recording every privileged call. */
class FakeExecutor extends SimulatedExecutor implements HostExecutor {
  failBuild: string | null = null;
  buildOutput = "";
  calls: string[] = [];
  constructor(private readonly p: HostingPaths) {
    super(p);
  }
  async runBuilder(appId: string) {
    const plan = JSON.parse(await fs.readFile(this.p.plan(appId), "utf8"));
    this.calls.push(`build:${plan.phase}:${appId}`);
    if (plan.phase === "build" && this.failBuild) {
      await fs.writeFile(this.p.buildLog(appId), `${this.buildOutput}\nnpm ERR! build failed\n`);
      await fs.writeFile(this.p.result(appId), JSON.stringify({ ok: false, phase: "build", error: this.failBuild }));
      return { started: true, detail: "exit 1" };
    }
    const r = await super.runBuilder(appId);
    if (this.buildOutput) await fs.appendFile(this.p.buildLog(appId), this.buildOutput);
    return r;
  }
  async unitAction(appId: string, action: UnitAction) {
    this.calls.push(`unit:${action}:${appId}`);
    return super.unitAction(appId, action);
  }
}

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await fs.rm(r, { recursive: true, force: true });
});

async function setup(envOver: Record<string, string> = {}, executorFactory?: (p: HostingPaths) => HostExecutor, cloudflare?: CloudflareClient) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nifhost-"));
  roots.push(root);
  const env = loadEnv({
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: hash,
    NODE_ENV: "test",
    HOSTING_ROOT: root,
    HOSTING_CLOUDFLARED_CONFIG: path.join(root, "cloudflared.yml"),
    ...envOver,
  });
  const events = new EventLog();
  const paths = new HostingPaths(root);
  const executor = executorFactory ? executorFactory(paths) : new FakeExecutor(paths);
  const health = { ok: true };
  const service = new HostingService({
    env,
    events,
    executor,
    probe: async () => ({ ok: health.ok, status: health.ok ? 200 : 503, checkedAt: new Date().toISOString() }),
    resolver: async (host) => (host === "github.com" ? ["140.82.112.3"] : ["10.0.0.1"]),
    portFree: async () => true,
    dnsCheck: async () => ({ status: "missing", detail: null }),
    cloudflare,
    healthTimeoutMs: 20,
  });
  await service.init();
  const app = createApp(env, mockSources([{ name: "ssh", label: "SSH", description: "" }], []), events, service);
  const login = await request(app).post("/api/v1/auth/login").send({ username: "admin", password: PASSWORD });
  expect(login.status).toBe(200);
  const cookie = login.headers["set-cookie"] as unknown as string[];
  return { root, env, events, executor, service, app, cookie, health, paths };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

const create = (c: Ctx, body: Record<string, unknown>) => request(c.app).post("/api/v1/hosting/apps").set("Cookie", c.cookie).send(body);
const upload = (c: Ctx, id: string, zip: Buffer) =>
  request(c.app).post(`/api/v1/hosting/apps/${id}/deploy/upload`).set("Cookie", c.cookie).set("Content-Type", "application/zip").send(zip);
const getApp = async (c: Ctx, id: string) => (await request(c.app).get(`/api/v1/hosting/apps/${id}`).set("Cookie", c.cookie).expect(200)).body.data;
const routes = async (c: Ctx) => JSON.parse(await fs.readFile(c.paths.routes, "utf8")).routes;

const site = (html: string) => makeZip([{ name: "index.html", data: html }]);
const viteSrc = (v: string) => makeZip([{ name: "package.json", data: JSON.stringify({ scripts: { build: "vite build" } }) }, { name: "src/main.js", data: v }]);
const nodeSrc = makeZip([{ name: "package.json", data: JSON.stringify({ main: "server.js" }) }, { name: "server.js", data: "require('http')" }]);

/**
 * Streams up to 3 MB in 64 KB chunks and stops as soon as the server answers —
 * like a browser does when the server rejects an upload early.
 */
async function rawUpload(c: Ctx, id: string, opts: { declared?: number }) {
  const server = c.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise<number>((resolve, reject) => {
      const headers: Record<string, string | number> = { "Content-Type": "application/zip", Cookie: c.cookie.map((s) => s.split(";")[0]).join("; ") };
      if (opts.declared) headers["Content-Length"] = opts.declared;
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: `/api/v1/hosting/apps/${id}/deploy/upload`, headers });
      let answered = false;
      req.on("response", (res) => {
        answered = true;
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      });
      req.on("error", (e) => (answered ? undefined : reject(e)));
      const chunk = Buffer.alloc(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (!answered && sent < 3 * 1024 * 1024) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once("drain", pump);
        }
        if (!answered && !opts.declared) req.end();
      };
      pump();
    });
  } finally {
    server.close();
  }
}

async function deploy(c: Ctx, id: string, zip: Buffer) {
  const res = await upload(c, id, zip);
  expect(res.status, JSON.stringify(res.body)).toBe(202);
  await c.service.waitIdle();
  return res.body.data as { deploymentId: string; releaseId: string };
}

describe("hosting: access control", () => {
  it("rejects every hosting endpoint without a session", async () => {
    const c = await setup();
    const anon = () => request(c.app);
    const calls = [
      () => anon().get("/api/v1/hosting/apps"),
      () => anon().get("/api/v1/hosting/prerequisites"),
      () => anon().get("/api/v1/hosting/runtimes"),
      () => anon().get("/api/v1/hosting/audit"),
      () => anon().get("/api/v1/hosting/apps/web"),
      () => anon().post("/api/v1/hosting/apps").send({}),
      () => anon().patch("/api/v1/hosting/apps/web").send({}),
      () => anon().delete("/api/v1/hosting/apps/web").send({ confirm: "web" }),
      () => anon().post("/api/v1/hosting/apps/web/actions").send({ action: "restart" }),
      () => anon().put("/api/v1/hosting/apps/web/env").send({ vars: [] }),
      () => anon().put("/api/v1/hosting/apps/web/domains").send({ domains: [] }),
      () => anon().put("/api/v1/hosting/apps/web/database").send({ type: "none" }),
      () => anon().put("/api/v1/hosting/apps/web/git-token").send({ token: null }),
      () => anon().post("/api/v1/hosting/apps/web/deploy/github").send({}),
      () => anon().post("/api/v1/hosting/apps/web/deploy/upload").set("Content-Type", "application/zip").send(site("x")),
      () => anon().post("/api/v1/hosting/apps/web/rollback").send({ releaseId: "r20260101000000-abcdef" }),
      () => anon().get("/api/v1/hosting/apps/web/deployments/d20260101000000-abcdef/log"),
    ];
    for (const call of calls) {
      const res = await call();
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ data: null, error: "Authentication required" });
    }
  });

  it("still refuses cross-site form posts", async () => {
    const c = await setup();
    const res = await request(c.app).post("/api/v1/hosting/apps").set("Cookie", c.cookie).type("form").send("id=web");
    expect(res.status).toBe(415);
  });
});

describe("hosting: input validation", () => {
  it("validates app ids, runtimes, domains and unknown fields", async () => {
    const c = await setup();
    const base = { id: "web", name: "Web", runtime: "static", deployMethod: "upload" };
    for (const [body, why] of [
      [{ ...base, id: "../etc" }, "traversal id"],
      [{ ...base, id: "Web" }, "uppercase id"],
      [{ ...base, id: "a" }, "short id"],
      [{ ...base, id: "web;rm -rf /" }, "shell id"],
      [{ ...base, id: "nifserver-backend" }, "reserved id"],
      [{ ...base, runtime: "python" }, "unknown runtime"],
      [{ ...base, runtime: "static", command: "rm -rf /" }, "unknown field"],
      [{ ...base, domains: ["drive.nifserver.cloud"] }, "reserved domain"],
      [{ ...base, domains: ["panel.nifserver.cloud"] }, "reserved domain"],
      [{ ...base, domains: ["http://evil.com/"] }, "url as domain"],
      [{ ...base, domains: ["127.0.0.1"] }, "ip as domain"],
      [{ ...base, healthPath: "health" }, "relative health path"],
      [{ ...base, options: { outputDir: "../../etc" } }, "outputDir traversal"],
      [{ ...base, deployMethod: "github" }, "github without repo"],
      [{ ...base, deployMethod: "github", repo: { url: "https://127.0.0.1/a/b", branch: "main" } }, "internal repo"],
      [{ ...base, deployMethod: "github", repo: { url: "https://gitlab.internal/a/b", branch: "main" } }, "host not allowed"],
      [{ ...base, deployMethod: "github", repo: { url: "https://github.com/a/b", branch: "--upload-pack=sh" } }, "option as branch"],
    ] as const) {
      const res = await create(c, body);
      expect(res.status, why).toBe(400);
      expect(res.body.data, why).toBeNull();
      expect(typeof res.body.error).toBe("string");
    }
    expect((await create(c, base)).status).toBe(201);
    expect((await create(c, base)).status).toBe(409);
    expect((await create(c, { ...base, id: "web2", domains: [] })).status).toBe(201);
    // Domains are unique across apps.
    await request(c.app).put("/api/v1/hosting/apps/web/domains").set("Cookie", c.cookie).send({ domains: ["web.example.com"] }).expect(200);
    await request(c.app).put("/api/v1/hosting/apps/web2/domains").set("Cookie", c.cookie).send({ domains: ["web.example.com"] }).expect(409);
    await request(c.app).get("/api/v1/hosting/apps/..%2F..%2Fetc").set("Cookie", c.cookie).expect(404);
  });

  it("concurrent creates cannot claim the same id or port", async () => {
    const c = await setup();
    const body = { name: "API", runtime: "node", deployMethod: "upload" };
    const same = await Promise.all([create(c, { ...body, id: "api" }), create(c, { ...body, id: "api" })]);
    expect(same.map((r) => r.status).sort()).toEqual([201, 409]);
    // portFree() is stubbed to always succeed, so both requests pick 4101 before inserting.
    const ports = await Promise.all([create(c, { ...body, id: "api-two" }), create(c, { ...body, id: "api-three" })]);
    expect(ports.map((r) => r.status).sort()).toEqual([201, 409]);
    const apps = (await request(c.app).get("/api/v1/hosting/apps").set("Cookie", c.cookie).expect(200)).body.data;
    expect(new Set(apps.map((a: { port: number }) => a.port)).size).toBe(apps.length);
  });

  it("rejects GitHub repos whose DNS points to an internal network", async () => {
    const c = await setup({ HOSTING_GIT_HOSTS: "github.com,git.example.com" });
    const res = await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "github", repo: { url: "https://git.example.com/a/b", branch: "main" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/internal/);
  });

  it("validates environment variables", async () => {
    const c = await setup();
    await create(c, { id: "api", name: "API", runtime: "node", deployMethod: "upload" }).expect(201);
    const put = (vars: unknown[]) => request(c.app).put("/api/v1/hosting/apps/api/env").set("Cookie", c.cookie).send({ vars });
    expect((await put([{ key: "PATH", value: "/tmp" }])).status).toBe(400);
    expect((await put([{ key: "LD_PRELOAD", value: "/tmp/x.so" }])).status).toBe(400);
    expect((await put([{ key: "lower", value: "x" }])).status).toBe(400);
    expect((await put([{ key: "A", value: "x\nB=y" }])).status).toBe(400);
    expect((await put([{ key: "A", value: "1" }, { key: "A", value: "2" }])).status).toBe(400);
    expect((await put([{ key: "NEW_SECRET", secret: true }])).status).toBe(400);
    expect((await put([{ key: "OK_VALUE", value: "1" }])).status).toBe(200);
  });
});

describe("hosting: ZIP upload", () => {
  it("rejects path traversal and symlinks without writing anything", async () => {
    const c = await setup();
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload" }).expect(201);
    for (const zip of [
      makeZip([{ name: "index.html", data: "ok" }, { name: "../../escape.txt", data: "pwned" }]),
      makeZip([{ name: "index.html", data: "ok" }, { name: "evil", data: "/etc/passwd", mode: 0o120777 }]),
      Buffer.from("PK not really a zip"),
    ]) {
      const res = await upload(c, "web", zip);
      expect(res.status).toBe(400);
    }
    expect(await fs.readdir(c.paths.releases("web"))).toEqual([]);
    expect(await fs.readdir(c.paths.tmp)).toEqual([]);
    await expect(fs.access(path.join(c.root, "escape.txt"))).rejects.toThrow();
    expect((await getApp(c, "web")).deployments).toEqual([]);
  });

  it("enforces the upload size limit", async () => {
    const c = await setup({ HOSTING_MAX_UPLOAD_MB: "1" });
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload" }).expect(201);
    // Declared too large: refused before reading the body.
    expect(await rawUpload(c, "web", { declared: 5 * 1024 * 1024 })).toBe(413);
    // Chunked (no Content-Length): refused once the streamed bytes pass the limit.
    expect(await rawUpload(c, "web", {})).toBe(413);
    expect(await fs.readdir(c.paths.tmp)).toEqual([]);
    expect(await fs.readdir(c.paths.releases("web"))).toEqual([]);
  });

  it("requires application/zip on the upload route", async () => {
    const c = await setup();
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload" }).expect(201);
    const res = await request(c.app).post("/api/v1/hosting/apps/web/deploy/upload").set("Cookie", c.cookie).set("Content-Type", "text/plain").send("x");
    expect(res.status).toBe(415);
  });

  it("rate-limits deployments", async () => {
    const c = await setup({ HOSTING_DEPLOY_LIMIT: "2" });
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload" }).expect(201);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await upload(c, "web", Buffer.from("bad"))).status);
    expect(statuses).toEqual([400, 400, 429]);
  });
});

describe("hosting: deployment pipeline", () => {
  it("deploys a static site and reports status and health", async () => {
    const c = await setup();
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload", domains: ["web.example.com"] }).expect(201);
    const { releaseId } = await deploy(c, "web", site("<h1>v1</h1>"));
    const app = await getApp(c, "web");
    expect(app.activeRelease.id).toBe(releaseId);
    expect(app.status).toBe("running");
    expect(app.health.status).toBe("up");
    expect(app.deployments[0]).toMatchObject({ status: "succeeded", method: "upload" });
    const r = await routes(c);
    expect(r["web.example.com"]).toMatchObject({ type: "static", root: c.paths.release("web", releaseId) });
    expect(r["web.nifhost.internal"]).toBeDefined();

    // Health goes down → visible after the next probe.
    c.health.ok = false;
    await request(c.app).post("/api/v1/hosting/apps/web/actions").set("Cookie", c.cookie).send({ action: "restart" }).expect(200);
    const list = (await request(c.app).get("/api/v1/hosting/apps").set("Cookie", c.cookie).expect(200)).body.data;
    expect(list[0]).toMatchObject({ id: "web", health: { status: "down", httpStatus: 503 } });
  });

  it("a failed build or health check never changes the active release", async () => {
    const c = await setup();
    const ex = c.executor as FakeExecutor;
    await create(c, { id: "spa", name: "SPA", runtime: "vite", deployMethod: "upload", domains: ["spa.example.com"] }).expect(201);
    const v1 = await deploy(c, "spa", viteSrc("v1"));
    const routesBefore = await routes(c);
    expect((await getApp(c, "spa")).activeRelease.id).toBe(v1.releaseId);

    ex.failBuild = "npm run build gagal (exit 1)";
    const v2 = await deploy(c, "spa", viteSrc("v2"));
    let app = await getApp(c, "spa");
    expect(app.activeRelease.id).toBe(v1.releaseId);
    expect(app.deployments[0]).toMatchObject({ id: v2.deploymentId, status: "failed" });
    expect(app.deployments[0].message).toMatch(/build gagal/);
    expect(await routes(c)).toEqual(routesBefore);
    await expect(fs.access(c.paths.release("spa", v2.releaseId))).rejects.toThrow();
    const log = (await request(c.app).get(`/api/v1/hosting/apps/spa/deployments/${v2.deploymentId}/log`).set("Cookie", c.cookie).expect(200)).body.data.log;
    expect(log).toMatch(/Rilis aktif tidak diubah/);

    ex.failBuild = null;
    c.health.ok = false;
    const v3 = await deploy(c, "spa", viteSrc("v3"));
    app = await getApp(c, "spa");
    expect(app.activeRelease.id).toBe(v1.releaseId);
    expect(app.deployments[0]).toMatchObject({ id: v3.deploymentId, status: "rolled_back" });
    expect(await routes(c)).toEqual(routesBefore);
  });

  it("rolls back to a previous release", async () => {
    const c = await setup();
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload", domains: ["web.example.com"] }).expect(201);
    const v1 = await deploy(c, "web", site("v1"));
    const v2 = await deploy(c, "web", site("v2"));
    expect((await getApp(c, "web")).activeRelease.id).toBe(v2.releaseId);

    await request(c.app).post("/api/v1/hosting/apps/web/rollback").set("Cookie", c.cookie).send({ releaseId: v2.releaseId }).expect(409);
    await request(c.app).post("/api/v1/hosting/apps/web/rollback").set("Cookie", c.cookie).send({ releaseId: "r20200101000000-abcdef" }).expect(404);
    const res = await request(c.app).post("/api/v1/hosting/apps/web/rollback").set("Cookie", c.cookie).send({ releaseId: v1.releaseId });
    expect(res.status).toBe(202);
    await c.service.waitIdle();
    const app = await getApp(c, "web");
    expect(app.activeRelease.id).toBe(v1.releaseId);
    expect(app.deployments[0]).toMatchObject({ kind: "rollback", status: "succeeded" });
    expect((await routes(c))["web.example.com"].root).toBe(c.paths.release("web", v1.releaseId));
    expect(await fs.readFile(path.join(c.paths.release("web", v1.releaseId), "index.html"), "utf8")).toBe("v1");
  });

  it("runs one deployment at a time", async () => {
    const c = await setup();
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload" }).expect(201);
    const first = upload(c, "web", site("a"));
    const [a, b] = await Promise.all([first, upload(c, "web", site("b"))]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    await c.service.waitIdle();
  });

  it("process apps use their unit and port; actions require confirmation for stop", async () => {
    const c = await setup();
    const ex = c.executor as FakeExecutor;
    const created = (await create(c, { id: "api", name: "API", runtime: "node", deployMethod: "upload", healthPath: "/healthz" }).expect(201)).body.data;
    expect(created.port).toBe(4100);
    const { releaseId } = await deploy(c, "api", nodeSrc);
    expect(await fs.readFile(c.paths.runEnv("api"), "utf8")).toContain(`NIF_RELEASE="${releaseId}"`);
    expect((await getApp(c, "api")).status).toBe("running");
    await request(c.app).post("/api/v1/hosting/apps/api/actions").set("Cookie", c.cookie).send({ action: "stop" }).expect(400);
    await request(c.app).post("/api/v1/hosting/apps/api/actions").set("Cookie", c.cookie).send({ action: "stop", confirm: "api" }).expect(200);
    expect((await getApp(c, "api")).status).toBe("stopped");
    await request(c.app).post("/api/v1/hosting/apps/api/actions").set("Cookie", c.cookie).send({ action: "reboot" }).expect(400);
    expect(ex.calls).toEqual(["build:build:api", "unit:restart:api", "unit:stop:api"]);
  });

  it("deploys from GitHub through the builder fetch phase", async () => {
    const c = await setup();
    const ex = c.executor as FakeExecutor;
    await create(c, { id: "ghsite", name: "GH", runtime: "static", deployMethod: "github", repo: { url: "https://github.com/owner/site", branch: "main" } }).expect(201);
    const res = await request(c.app).post("/api/v1/hosting/apps/ghsite/deploy/github").set("Cookie", c.cookie).send({});
    expect(res.status).toBe(202);
    await c.service.waitIdle();
    const app = await getApp(c, "ghsite");
    expect(app.repo.url).toBe("https://github.com/owner/site.git");
    expect(app.activeRelease).toMatchObject({ source: "github", commit: "0000000" });
    expect(ex.calls).toEqual(["build:fetch:ghsite"]);
    const plan = JSON.parse(await fs.readFile(c.paths.plan("ghsite"), "utf8"));
    expect(plan.repo).toEqual({ url: "https://github.com/owner/site.git", branch: "main" });
  });

  it("deletes an app with confirmation", async () => {
    const c = await setup();
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload", domains: ["web.example.com"] }).expect(201);
    await deploy(c, "web", site("x"));
    await request(c.app).delete("/api/v1/hosting/apps/web").set("Cookie", c.cookie).send({ confirm: "nope" }).expect(400);
    await request(c.app).delete("/api/v1/hosting/apps/web").set("Cookie", c.cookie).send({ confirm: "web" }).expect(200);
    await request(c.app).get("/api/v1/hosting/apps/web").set("Cookie", c.cookie).expect(404);
    expect(await routes(c)).toEqual({});
    await expect(fs.access(c.paths.app("web"))).rejects.toThrow();
  });
});

describe("hosting: secrets", () => {
  it("never returns or logs secret values", async () => {
    const c = await setup();
    const ex = c.executor as FakeExecutor;
    const SECRET = "s3cr3t-Value-XYZ-123";
    const DBPASS = "dbPassw0rd-!!-777";
    const TOKEN = `ghp_${"Ab1".repeat(12)}`;
    await create(c, { id: "api", name: "API", runtime: "node", deployMethod: "upload" }).expect(201);
    await request(c.app)
      .put("/api/v1/hosting/apps/api/env")
      .set("Cookie", c.cookie)
      .send({ vars: [{ key: "API_TOKEN", secret: true, value: SECRET }, { key: "PUBLIC_URL", value: "https://api.example.com" }] })
      .expect(200);
    await request(c.app).put("/api/v1/hosting/apps/api/database").set("Cookie", c.cookie).send({ type: "mysql", name: "api", user: "api", password: DBPASS }).expect(200);
    await request(c.app).put("/api/v1/hosting/apps/api/git-token").set("Cookie", c.cookie).send({ token: TOKEN }).expect(200);

    // Keeping a secret without resending it.
    await request(c.app)
      .put("/api/v1/hosting/apps/api/env")
      .set("Cookie", c.cookie)
      .send({ vars: [{ key: "API_TOKEN", secret: true }, { key: "PUBLIC_URL", value: "https://api.example.com" }] })
      .expect(200);

    ex.buildOutput = `echo API_TOKEN is ${SECRET}; mysql -p${DBPASS}; cloning with ${TOKEN}\n`;
    const { deploymentId } = await deploy(c, "api", nodeSrc);

    const detail = await getApp(c, "api");
    expect(detail.env).toEqual([
      { key: "API_TOKEN", secret: true, value: null, set: true },
      { key: "PUBLIC_URL", secret: false, value: "https://api.example.com", set: true },
    ]);
    expect(detail.database).toMatchObject({ type: "mysql", passwordSet: true });
    expect(detail.gitTokenSet).toBe(true);

    const log = (await request(c.app).get(`/api/v1/hosting/apps/api/deployments/${deploymentId}/log`).set("Cookie", c.cookie).expect(200)).body.data.log;
    expect(log).toContain("[REDACTED]");
    const everything = [
      JSON.stringify(detail),
      JSON.stringify((await request(c.app).get("/api/v1/hosting/apps").set("Cookie", c.cookie)).body),
      JSON.stringify((await request(c.app).get("/api/v1/hosting/audit").set("Cookie", c.cookie)).body),
      JSON.stringify((await request(c.app).get("/api/v1/events").set("Cookie", c.cookie)).body),
      log,
      await fs.readFile(c.paths.registry, "utf8"),
      await fs.readFile(c.paths.audit, "utf8"),
      await fs.readFile(c.paths.deployLog("api", deploymentId), "utf8"),
    ].join("\n");
    for (const s of [SECRET, DBPASS, TOKEN]) expect(everything).not.toContain(s);

    // ...but they do reach the app's runtime environment file.
    const runtimeEnv = await fs.readFile(c.paths.runtimeEnv("api"), "utf8");
    expect(runtimeEnv).toContain(`API_TOKEN="${SECRET}"`);
    expect(runtimeEnv).toContain(`DB_PASSWORD="${DBPASS}"`);
    expect(await fs.readFile(c.paths.gitToken("api"), "utf8")).toBe(TOKEN);
    const plan = await fs.readFile(c.paths.plan("api"), "utf8");
    for (const s of [SECRET, DBPASS, TOKEN]) expect(plan).not.toContain(s);
  });

  it("generates a Laravel APP_KEY as a secret", async () => {
    const c = await setup();
    const app = (await create(c, { id: "shop", name: "Shop", runtime: "laravel", deployMethod: "upload" }).expect(201)).body.data;
    expect(app.env).toContainEqual({ key: "APP_KEY", secret: true, value: null, set: true });
    expect(JSON.stringify(app)).not.toMatch(/base64:/);
  });
});

describe("hosting: existing NIFSERVER services are never touched", () => {
  it("only nifapp@/nifbuild@ units are passed to systemctl", async () => {
    const argvs: string[][] = [];
    let paths!: HostingPaths;
    const c = await setup({}, (p) => {
      paths = p;
      const sim = new SimulatedExecutor(p);
      return new SystemdExecutor(async (file, args) => {
        expect(file).toBe("systemctl");
        argvs.push(args);
        const unit = args[args.length - 1];
        if (args.includes("start") && unit.startsWith("nifbuild@")) await sim.runBuilder(unit.slice(9, -8));
        const stdout = args[0] === "show" ? args.slice(4).map((u) => `Id=${u}\nActiveState=active\nSubState=running`).join("\n\n") : "";
        return { code: 0, stdout, stderr: "" };
      });
    });
    await create(c, { id: "api", name: "API", runtime: "node", deployMethod: "upload" }).expect(201);
    await deploy(c, "api", nodeSrc);
    for (const action of ["restart", "start"]) await request(c.app).post("/api/v1/hosting/apps/api/actions").set("Cookie", c.cookie).send({ action }).expect(200);
    await request(c.app).post("/api/v1/hosting/apps/api/actions").set("Cookie", c.cookie).send({ action: "stop", confirm: "api" }).expect(200);
    await request(c.app).get("/api/v1/hosting/apps").set("Cookie", c.cookie).expect(200);
    await request(c.app).get("/api/v1/hosting/prerequisites").set("Cookie", c.cookie).expect(200);
    await request(c.app).delete("/api/v1/hosting/apps/api").set("Cookie", c.cookie).send({ confirm: "api" }).expect(200);
    expect(paths).toBeDefined();

    expect(argvs.length).toBeGreaterThan(4);
    for (const argv of argvs) {
      const text = argv.join(" ");
      expect(text).not.toMatch(/nifserver-|cloudflared|apache2|smbd|\bssh\b|netdata|nginx/);
      const units = argv.slice(argv.indexOf("--") + 1);
      for (const u of units) expect(u).toMatch(/^(nifapp@api\.service|nifbuild@api\.service|nifhost-gateway\.service)$/);
      expect(argv[0] === "show" || argv[0] === "--no-ask-password").toBe(true);
    }
  });
});

// ---------------------------------------------------------------- static site: file / folder / ZIP upload

type Files = Record<string, string | Buffer>;
const base = (id: string) => `/api/v1/hosting/apps/${id}`;

async function beginStage(c: Ctx, id: string) {
  const res = await request(c.app).post(`${base(id)}/uploads`).set("Cookie", c.cookie).send({});
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data.uploadId as string;
}
const putFile = (c: Ctx, id: string, uploadId: string, rel: string, body: string | Buffer, type = "application/octet-stream") =>
  request(c.app).put(`${base(id)}/uploads/${uploadId}/file`).query({ path: rel }).set("Cookie", c.cookie).set("Content-Type", type).send(body);
const commit = (c: Ctx, id: string, uploadId: string) => request(c.app).post(`${base(id)}/uploads/${uploadId}/commit`).set("Cookie", c.cookie).send({});

/** Stages every file, then commits. Returns the commit response. */
async function stageAndCommit(c: Ctx, id: string, files: Files) {
  const uploadId = await beginStage(c, id);
  for (const [rel, body] of Object.entries(files)) {
    const r = await putFile(c, id, uploadId, rel, body);
    expect(r.status, `${rel}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  const res = await commit(c, id, uploadId);
  if (res.status === 202) await c.service.waitIdle();
  return { res, uploadId };
}

const staticApp = async (c: Ctx, id = "web") => {
  await create(c, { id, name: "Web", runtime: "static", deployMethod: "upload", domains: [`${id}.example.com`] }).expect(201);
  return id;
};
const releaseFile = async (c: Ctx, id: string, rel: string) => {
  const app = await getApp(c, id);
  return fs.readFile(path.join(c.paths.release(id, app.activeRelease.id), ...rel.split("/")), "utf8");
};
const releaseExists = async (c: Ctx, id: string, rel: string) => {
  const app = await getApp(c, id);
  return fs.access(path.join(c.paths.release(id, app.activeRelease.id), ...rel.split("/"))).then(() => true, () => false);
};

/** Streams up to 3 MB with no Content-Length (chunked) and stops once the server answers. */
async function rawPut(c: Ctx, id: string, uploadId: string, rel: string) {
  const server = c.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await new Promise<number>((resolve, reject) => {
      const headers = { "Content-Type": "application/octet-stream", Cookie: c.cookie.map((s) => s.split(";")[0]).join("; ") };
      const req = http.request({ host: "127.0.0.1", port, method: "PUT", path: `${base(id)}/uploads/${uploadId}/file?path=${encodeURIComponent(rel)}`, headers });
      let answered = false;
      req.on("response", (res) => {
        answered = true;
        res.resume();
        resolve(res.statusCode!);
        req.destroy();
      });
      req.on("error", (e) => (answered ? undefined : reject(e)));
      const chunk = Buffer.alloc(64 * 1024);
      let sent = 0;
      const pump = () => {
        while (!answered && sent < 3 * 1024 * 1024) {
          sent += chunk.length;
          if (!req.write(chunk)) return void req.once("drain", pump);
        }
        if (!answered) req.end();
      };
      pump();
    });
  } finally {
    server.close();
  }
}

describe("hosting: static site upload without ZIP", () => {
  it("deploys a single index.html", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const { res } = await stageAndCommit(c, id, { "index.html": "<h1>solo</h1>" });
    expect(res.status).toBe(202);
    const app = await getApp(c, id);
    expect(app.deployments[0]).toMatchObject({ status: "succeeded", method: "upload" });
    expect(await releaseFile(c, id, "index.html")).toBe("<h1>solo</h1>");
    expect((await routes(c))["web.example.com"]).toMatchObject({ type: "static", root: c.paths.release(id, app.activeRelease.id) });
  });

  it("serves a lone HTML file with another name as index.html", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const { res } = await stageAndCommit(c, id, { "home.html": "<h1>home</h1>" });
    expect(res.status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("<h1>home</h1>");
  });

  it("serves the only HTML page among several loose files as index.html", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const { res } = await stageAndCommit(c, id, { "home.html": "<h1>home</h1>", "style.css": "body{}" });
    expect(res.status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("<h1>home</h1>");
    expect(await releaseFile(c, id, "style.css")).toBe("body{}");
  });

  it("keeps relative structure for several files", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const { res } = await stageAndCommit(c, id, {
      "index.html": '<link rel="stylesheet" href="css/app.css"><script src="js/app.js"></script>',
      "css/app.css": "body{}",
      "js/app.js": "1",
      "img/logo.png": png,
      "empty.txt": "",
    });
    expect(res.status).toBe(202);
    expect(await releaseFile(c, id, "css/app.css")).toBe("body{}");
    expect(await releaseFile(c, id, "js/app.js")).toBe("1");
    const app = await getApp(c, id);
    expect(await fs.readFile(path.join(c.paths.release(id, app.activeRelease.id), "img", "logo.png"))).toEqual(png);
    expect(await releaseExists(c, id, "empty.txt")).toBe(true);
  });

  it("uses the selected folder name as document root for folder uploads", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const { res } = await stageAndCommit(c, id, { "mysite/index.html": "<p>folder</p>", "mysite/assets/a.css": "a{}", "mysite/.env": "SECRET=1" });
    expect(res.status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("<p>folder</p>");
    expect(await releaseFile(c, id, "assets/a.css")).toBe("a{}");
    expect(await releaseExists(c, id, ".env")).toBe(false);
  });

  it("detects dist/ in a folder upload and leaves out files outside it", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const { res } = await stageAndCommit(c, id, { "proj/dist/index.html": "built", "proj/dist/app.js": "x", "proj/src.js": "source" });
    expect(res.status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("built");
    expect(await releaseExists(c, id, "src.js")).toBe(false);
  });

  it("rejects a commit without index.html and keeps the active release", async () => {
    const c = await setup();
    const id = await staticApp(c);
    await deploy(c, id, site("live"));
    const before = (await getApp(c, id)).activeRelease.id;

    const { res, uploadId } = await stageAndCommit(c, id, { "about.html": "a", "contact.html": "b" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/index\.html tidak ditemukan/);
    const after = await getApp(c, id);
    expect(after.activeRelease.id).toBe(before);
    expect(after.deployments).toHaveLength(1);
    expect(await releaseFile(c, id, "index.html")).toBe("live");

    // The session survives a failed validation: add the missing page and retry.
    expect((await putFile(c, id, uploadId, "index.html", "fixed")).status).toBe(200);
    expect((await commit(c, id, uploadId)).status).toBe(202);
    await c.service.waitIdle();
    expect(await releaseFile(c, id, "index.html")).toBe("fixed");
  });

  it("rejects ambiguous index.html candidates with a clear message", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const { res } = await stageAndCommit(c, id, { "a/index.html": "a", "b/index.html": "b" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/beberapa kandidat index\.html \(a\/, b\/\)/);
  });

  it("rejects traversal, absolute paths, backslashes and forbidden extensions", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const uploadId = await beginStage(c, id);
    for (const bad of ["../escape.html", "a/../../x.html", "/etc/passwd.txt", "C:/x.html", "a\\b.html", "a//b.html", "./x.html", "shell.php", "run.sh", "app.exe", "noext", "a/b/"]) {
      const r = await putFile(c, id, uploadId, bad, "x");
      expect(r.status, bad).toBe(400);
    }
    expect((await request(c.app).put(`${base(id)}/uploads/${uploadId}/file`).set("Cookie", c.cookie).set("Content-Type", "application/octet-stream").send("x")).status).toBe(400);
    expect(await fs.readdir(path.join(c.paths.tmp, "uploads", uploadId))).toEqual([]);
  });

  it("rejects duplicates and file/folder conflicts", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const uploadId = await beginStage(c, id);
    expect((await putFile(c, id, uploadId, "a.html", "1")).status).toBe(200);
    expect((await putFile(c, id, uploadId, "A.html", "2")).status).toBe(409);
    expect((await putFile(c, id, uploadId, "css/app.css", "1")).status).toBe(200);
    expect((await putFile(c, id, uploadId, "css", "x", "application/octet-stream")).status).toBe(400); // no extension
    expect((await putFile(c, id, uploadId, "a.html/x.css", "1")).status).toBe(409);
  });

  it("skips .git, node_modules and .env files without storing them", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const uploadId = await beginStage(c, id);
    for (const p of [".git/config.txt", "node_modules/x/index.js", ".env.txt"]) {
      const r = await putFile(c, id, uploadId, p, "x");
      expect(r.status, p).toBe(200);
    }
    expect((await putFile(c, id, uploadId, ".git/config.txt", "x")).body.data.skipped).toBe(true);
    expect(await fs.readdir(path.join(c.paths.tmp, "uploads", uploadId))).toEqual([]);
  });

  it("enforces file count and size limits", async () => {
    const c = await setup({ HOSTING_MAX_UPLOAD_FILES: "2", HOSTING_MAX_UPLOAD_MB: "1" });
    const id = await staticApp(c);
    const uploadId = await beginStage(c, id);
    expect((await putFile(c, id, uploadId, "a.html", "1")).status).toBe(200);
    expect((await putFile(c, id, uploadId, "b.css", "1")).status).toBe(200);
    expect((await putFile(c, id, uploadId, "c.js", "1")).status).toBe(413);

    const second = await beginStage(c, id);
    expect(await rawPut(c, id, second, "big.html")).toBe(413);
    expect(await fs.readdir(path.join(c.paths.tmp, "uploads", second))).toEqual([]);
    expect((await putFile(c, id, second, "ok.html", Buffer.alloc(600 * 1024))).status).toBe(200);
    // Total budget is shared by the whole session.
    expect(await rawPut(c, id, second, "ok2.html")).toBe(413);
  });

  it("only accepts loose files for static sites, via octet-stream, in the owning session", async () => {
    const c = await setup();
    await create(c, { id: "spa", name: "SPA", runtime: "vite", deployMethod: "upload" }).expect(201);
    expect((await request(c.app).post(`${base("spa")}/uploads`).set("Cookie", c.cookie).send({})).status).toBe(400);

    const id = await staticApp(c);
    const uploadId = await beginStage(c, id);
    // Form-style content types are refused (CSRF guard).
    expect((await putFile(c, id, uploadId, "a.html", "x", "text/plain")).status).toBe(415);
    expect((await putFile(c, id, uploadId, "a.html", "x", "multipart/form-data; boundary=x")).status).toBe(415);
    // Another app cannot use this session.
    await staticApp(c, "other");
    expect((await putFile(c, "other", uploadId, "a.html", "x")).status).toBe(404);
    expect((await commit(c, "other", uploadId)).status).toBe(404);
    // Unauthenticated access.
    expect((await request(c.app).post(`${base(id)}/uploads`).send({})).status).toBe(401);
    expect((await request(c.app).put(`${base(id)}/uploads/${uploadId}/file`).query({ path: "a.html" }).set("Content-Type", "application/octet-stream").send("x")).status).toBe(401);
  });

  it("cancelling discards the staged files", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const uploadId = await beginStage(c, id);
    await putFile(c, id, uploadId, "index.html", "x");
    await request(c.app).delete(`${base(id)}/uploads/${uploadId}`).set("Cookie", c.cookie).send({}).expect(200);
    expect(await fs.readdir(path.join(c.paths.tmp, "uploads"))).toEqual([]);
    expect((await commit(c, id, uploadId)).status).toBe(404);
  });
});

describe("hosting: static site ZIP document root", () => {
  const zipDeploy = async (c: Ctx, id: string, entries: { name: string; data?: string }[]) => {
    const res = await upload(c, id, makeZip(entries));
    if (res.status === 202) await c.service.waitIdle();
    return res;
  };

  it("deploys a ZIP with index.html at the root", async () => {
    const c = await setup();
    const id = await staticApp(c);
    expect((await zipDeploy(c, id, [{ name: "index.html", data: "root" }, { name: "css/a.css", data: "c" }])).status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("root");
    expect(await releaseFile(c, id, "css/a.css")).toBe("c");
  });

  it("serves the only HTML page of a ZIP as index.html, with its assets", async () => {
    const c = await setup();
    const id = await staticApp(c);
    expect((await zipDeploy(c, id, [{ name: "Home Page.html", data: "<h1>hi</h1>" }, { name: "css/a.css", data: "c" }])).status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("<h1>hi</h1>");
    expect(await releaseFile(c, id, "css/a.css")).toBe("c");
    expect((await getApp(c, id)).deployments[0].status).toBe("succeeded");
  });

  it("promotes the only HTML page inside a wrapper folder", async () => {
    const c = await setup();
    const id = await staticApp(c);
    expect((await zipDeploy(c, id, [{ name: "site/home.html", data: "<h1>in folder</h1>" }, { name: "site/js/a.js", data: "1" }])).status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("<h1>in folder</h1>");
    expect(await releaseFile(c, id, "js/a.js")).toBe("1");
  });

  it("rejects a ZIP with several HTML pages and no index.html", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const res = await zipDeploy(c, id, [{ name: "a.html", data: "a" }, { name: "b.html", data: "b" }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/index\.html/);
  });

  it("strips a single wrapper folder", async () => {
    const c = await setup();
    const id = await staticApp(c);
    expect((await zipDeploy(c, id, [{ name: "site/index.html", data: "wrapped" }, { name: "site/a.js", data: "j" }])).status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("wrapped");
  });

  it("uses dist/ as document root", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const res = await zipDeploy(c, id, [
      { name: "package.json", data: "{}" },
      { name: "src/main.js", data: "src" },
      { name: "dist/index.html", data: "built" },
      { name: "dist/assets/app.js", data: "bundle" },
    ]);
    expect(res.status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("built");
    expect(await releaseFile(c, id, "assets/app.js")).toBe("bundle");
    expect(await releaseExists(c, id, "package.json")).toBe(false);
    expect(await releaseExists(c, id, "dist/index.html")).toBe(false);
  });

  it("uses build/ and a wrapper folder around dist/", async () => {
    const c = await setup();
    const id = await staticApp(c);
    expect((await zipDeploy(c, id, [{ name: "app/build/index.html", data: "b" }, { name: "app/README.md", data: "r" }])).status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("b");
  });

  it("detects an unambiguous project subfolder", async () => {
    const c = await setup();
    const id = await staticApp(c);
    expect((await zipDeploy(c, id, [{ name: "README.md", data: "r" }, { name: "website/index.html", data: "sub" }])).status).toBe(202);
    expect(await releaseFile(c, id, "index.html")).toBe("sub");
  });

  it("rejects a ZIP without index.html and keeps the active release", async () => {
    const c = await setup();
    const id = await staticApp(c);
    await deploy(c, id, site("live"));
    const before = (await getApp(c, id)).activeRelease.id;
    const res = await zipDeploy(c, id, [{ name: "about.html", data: "a" }, { name: "contact.html", data: "b" }, { name: "css/a.css", data: "c" }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/index\.html tidak ditemukan/);
    const after = await getApp(c, id);
    expect(after.activeRelease.id).toBe(before);
    expect(await releaseFile(c, id, "index.html")).toBe("live");
    expect(await fs.readdir(c.paths.tmp)).not.toContainEqual(expect.stringMatching(/\.zip$/));
  });

  it("rejects a ZIP with ambiguous candidates (dist and build)", async () => {
    const c = await setup();
    const id = await staticApp(c);
    const res = await zipDeploy(c, id, [{ name: "dist/index.html", data: "d" }, { name: "build/index.html", data: "b" }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dist\/, build\//);
  });

  it("does not change ZIP handling for non-static runtimes", async () => {
    const c = await setup();
    await create(c, { id: "spa", name: "SPA", runtime: "vite", deployMethod: "upload" }).expect(201);
    expect((await zipDeploy(c, "spa", [{ name: "package.json", data: JSON.stringify({ scripts: { build: "vite build" } }) }, { name: "src/main.js", data: "x" }])).status).toBe(202);
    expect((await getApp(c, "spa")).deployments[0].status).toBe("succeeded");
  });
});

describe("cloudflare domain sync", () => {
  it("syncs added/removed domains, reports failures without rolling back, and retries on demand", async () => {
    const calls: { add: string[]; remove: string[] }[] = [];
    let failing = false;
    const cf: CloudflareClient = {
      status: async () => ({ configured: true, dns: true, ingress: false, zone: "example.com", tunnelTarget: "t.cfargotunnel.com" }),
      sync: async (add, remove) => {
        calls.push({ add, remove });
        return [...add, ...remove].map((domain) => ({ domain, ok: !failing, steps: failing ? [] : ["ok"], error: failing ? "boom" : null }));
      },
    };
    const c = await setup({}, undefined, cf);
    const base = { id: "web", name: "Web", runtime: "static", deployMethod: "upload" };
    const made = await create(c, { ...base, domains: ["a.example.com"] }).expect(201);
    expect(made.body.data.cloudflare).toEqual([{ domain: "a.example.com", ok: true, steps: ["ok"], error: null }]);

    failing = true;
    const put = await request(c.app).put("/api/v1/hosting/apps/web/domains").set("Cookie", c.cookie).send({ domains: ["b.example.com"] }).expect(200);
    expect(calls[1]).toEqual({ add: ["b.example.com"], remove: ["a.example.com"] });
    expect(put.body.data.cloudflare.every((r: { ok: boolean }) => !r.ok)).toBe(true);
    expect((await getApp(c, "web")).domains).toEqual(["b.example.com"]); // saved despite the failure

    failing = false;
    const retry = await request(c.app).post("/api/v1/hosting/apps/web/domains/sync").set("Cookie", c.cookie).send({}).expect(200);
    expect(calls[2]).toEqual({ add: ["b.example.com"], remove: [] });
    expect(retry.body.data[0].ok).toBe(true);

    const st = await request(c.app).get("/api/v1/hosting/apps/web/domains/status").set("Cookie", c.cookie).expect(200);
    expect(st.body.data.cloudflare.zone).toBe("example.com");

    await request(c.app).delete("/api/v1/hosting/apps/web").set("Cookie", c.cookie).send({ confirm: "web" }).expect(200);
    expect(calls[3]).toEqual({ add: [], remove: ["b.example.com"] });
  });

  it("requires a session for the sync endpoint", async () => {
    const c = await setup();
    await request(c.app).post("/api/v1/hosting/apps/web/domains/sync").send({}).expect(401);
  });
});

describe("caddy on-demand TLS ask hook", () => {
  const TOKEN = "k3y_" + "a".repeat(30);
  const ask = (c: Ctx, query: string) => request(c.app).get(`/api/v1/caddy/ask?${query}`); // no session cookie: Caddy has none

  it("approves only domains of registered apps, and only with the shared secret", async () => {
    const c = await setup({ CADDY_ASK_TOKEN: TOKEN });
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload", domains: ["web.example.com"] }).expect(201);

    await ask(c, `token=${TOKEN}&domain=web.example.com`).expect(200);
    await ask(c, `token=${TOKEN}&domain=WEB.example.com`).expect(200); // Caddy may send any case
    await ask(c, `token=${TOKEN}&domain=other.example.com`).expect(404);
    await ask(c, `token=${TOKEN}&domain=drive.nifserver.cloud`).expect(404); // reserved
    await ask(c, `token=${TOKEN}&domain=web.nifhost.internal`).expect(404);
    await ask(c, `token=${TOKEN}`).expect(404);
    await ask(c, `token=wrong&domain=web.example.com`).expect(404);
    await ask(c, `domain=web.example.com`).expect(404);

    const st = await request(c.app).get("/api/v1/hosting/apps/web/domains/status").set("Cookie", c.cookie).expect(200);
    expect(st.body.data.caddy).toEqual({ enabled: true });
    expect(JSON.stringify(st.body)).not.toContain(TOKEN);
  });

  it("is disabled (404) when no token is configured", async () => {
    const c = await setup();
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload", domains: ["web.example.com"] }).expect(201);
    await ask(c, "token=anything&domain=web.example.com").expect(404);
    await ask(c, "domain=web.example.com").expect(404);
  });

  it("stops approving a domain after it is removed", async () => {
    const c = await setup({ CADDY_ASK_TOKEN: TOKEN });
    await create(c, { id: "web", name: "Web", runtime: "static", deployMethod: "upload", domains: ["web.example.com"] }).expect(201);
    await request(c.app).put("/api/v1/hosting/apps/web/domains").set("Cookie", c.cookie).send({ domains: [] }).expect(200);
    await ask(c, `token=${TOKEN}&domain=web.example.com`).expect(404);
  });
});


describe("managed MySQL", () => {
  it("creates a custom database and preserves its name through phpMyAdmin, reset, and deletion", async () => {
    const sql = vi.spyOn(MysqlAdmin.prototype, "run").mockResolvedValue();
    try {
      const key = "c".repeat(64);
      const c = await setup({ PHPMYADMIN_ENABLED: "true", PHPMYADMIN_BRIDGE_KEY: key });
      await create(c, { id: "portfolio", name: "Portfolio", runtime: "node", deployMethod: "upload" }).expect(201);
      const base = "/api/v1/hosting/apps/portfolio/database";
      const result = await request(c.app).post(`${base}/create`).set("Cookie", c.cookie).send({ name: "portofolio_data" }).expect(200);
      expect(result.body.data.database).toMatchObject({ name: "portofolio_data", user: managedName("portfolio"), managed: true });
      expect(sql.mock.calls[0][0]).toContain("CREATE DATABASE `portofolio_data`");
      expect(sql.mock.calls[2][0]).toContain("ON `portofolio\\_data`.*");
      const runtime = await fs.readFile(c.paths.runtimeEnv("portfolio"), "utf8");
      expect(runtime).toContain('DB_DATABASE="portofolio_data"');
      const credentials = await request(c.app).post(`${base}/phpmyadmin-credentials`).set("Cookie", c.cookie).set("X-Nif-Pma-Key", key).send({}).expect(200);
      expect(credentials.body.data).toMatchObject({ database: "portofolio_data", user: managedName("portfolio") });
      await request(c.app).put(base).set("Cookie", c.cookie).send({ type: "mysql", name: "other" }).expect(409);
      await request(c.app).put(base).set("Cookie", c.cookie).send({ type: "mysql", autoMigrate: false }).expect(200);
      await request(c.app).post(`${base}/reset`).set("Cookie", c.cookie).send({ confirm: "portfolio" }).expect(200);
      expect((await getApp(c, "portfolio")).database.name).toBe("portofolio_data");
      expect(sql.mock.calls[3][0]).toContain(`ALTER USER '${managedName("portfolio")}'`);
      await request(c.app).post(`${base}/delete`).set("Cookie", c.cookie).send({ confirm: "portfolio" }).expect(200);
      expect(sql.mock.calls[4][0]).toBe(`DROP DATABASE IF EXISTS \`portofolio_data\`; DROP USER IF EXISTS '${managedName("portfolio")}'@'127.0.0.1';`);
    } finally { sql.mockRestore(); }
  });

  it("rejects unsafe, reserved, and duplicate names before executing SQL", async () => {
    const sql = vi.spyOn(MysqlAdmin.prototype, "run").mockResolvedValue();
    try {
      const c = await setup();
      for (const id of ["first-app", "second-app"]) {
        await create(c, { id, name: id, runtime: "node", deployMethod: "upload" }).expect(201);
      }
      const post = (id: string, body: object) => request(c.app).post(`/api/v1/hosting/apps/${id}/database/create`).set("Cookie", c.cookie).send(body);
      for (const name of ["", "mysql", "sys", "information_schema", "performance_schema", "name`; DROP DATABASE mysql;--", "../db", "db%", "a".repeat(65)]) {
        await post("first-app", { name }).expect(400);
      }
      await post("first-app", { name: "valid", user: "root" }).expect(400);
      expect(sql).not.toHaveBeenCalled();
      await post("first-app", { name: "portfolio" }).expect(200);
      await post("second-app", { name: "portfolio" }).expect(409);
      expect(sql).toHaveBeenCalledTimes(3);
      expect((await getApp(c, "second-app")).database.type).toBe("none");
    } finally { sql.mockRestore(); }
  });

  it("reports missing admin configuration without recording a database as created", async () => {
    const c = await setup({ HOSTING_MYSQL_DEFAULTS_FILE: "" });
    await create(c, { id: "no-admin", name: "No admin", runtime: "node", deployMethod: "upload" }).expect(201);
    const result = await request(c.app).post("/api/v1/hosting/apps/no-admin/database/create").set("Cookie", c.cookie).send({ name: "portfolio" }).expect(503);
    expect(JSON.stringify(result.body)).toContain("HOSTING_MYSQL_DEFAULTS_FILE");
    expect((await getApp(c, "no-admin")).database.type).toBe("none");
  });

  it("does not drop an existing custom database when creation is rejected", async () => {
    const sql = vi.spyOn(MysqlAdmin.prototype, "run").mockRejectedValueOnce(new Error("database exists"));
    try {
      await expect(new MysqlAdmin("unused").create("portfolio", "a".repeat(64), "portfolio")).rejects.toThrow("database exists");
      expect(sql).toHaveBeenCalledTimes(1);
    } finally { sql.mockRestore(); }
  });

  it("keeps generated credentials private, requires confirmation and protects manual databases", async () => {
    const sql = vi.spyOn(MysqlAdmin.prototype, "run").mockResolvedValue();
    try {
      const c = await setup();
      await create(c, { id: "mysql-app", name: "MySQL app", runtime: "laravel", deployMethod: "upload" }).expect(201);
      const post = (op: string, body = {}) => request(c.app).post(`/api/v1/hosting/apps/mysql-app/database/${op}`).set("Cookie", c.cookie).send(body);
      await post("create").expect(200);
      const db = (await getApp(c, "mysql-app")).database;
      expect(db).toMatchObject({ managed: true, name: managedName("mysql-app"), host: "127.0.0.1", passwordSet: true });
      const first = (await c.service.secrets.read("mysql-app")).dbPassword!;
      expect(first).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(await getApp(c, "mysql-app"))).not.toContain(first);
      await post("create").expect(409);
      await post("delete", { confirm: "wrong" }).expect(400);
      expect(sql).toHaveBeenCalledTimes(3);
      await post("reset", { confirm: "mysql-app" }).expect(200);
      expect((await c.service.secrets.read("mysql-app")).dbPassword).not.toBe(first);
      await post("delete", { confirm: "mysql-app" }).expect(200);
      expect((await getApp(c, "mysql-app")).database.type).toBe("none");
      await post("reset", { confirm: "mysql-app" }).expect(400);
      expect(managedName("foo-bar")).not.toBe(managedName("foob-ar"));
    } finally { sql.mockRestore(); }
  });
  it("cleans up only its newly created database when account creation fails", async () => {
    const sql = vi.spyOn(MysqlAdmin.prototype, "run").mockResolvedValueOnce().mockRejectedValueOnce(new Error("account exists")).mockResolvedValueOnce();
    try {
      await expect(new MysqlAdmin("unused").create("mysql-app", "a".repeat(64))).rejects.toThrow("account exists");
      expect(sql.mock.calls[2][0]).toMatch(/^DROP DATABASE/);
      expect(sql.mock.calls.map(x => x[0]).join(" ")).not.toContain("DROP USER");
    } finally { sql.mockRestore(); }
  });
});


it("runs Laravel migrations before activation and preserves the active release on migration failure", async () => {
  const c = await setup();
  const migration = vi.fn().mockResolvedValue({ started: true, detail: null });
  (c.executor as HostExecutor).runMigration = migration;
  await create(c, { id: "migrate-app", name: "Migrate", runtime: "laravel", deployMethod: "upload" }).expect(201);
  await c.service.setDatabase("migrate-app", { type: "mysql", name: "manual_db", user: "manual_user", password: "secret", autoMigrate: true }, "test");
  const source = makeZip([{ name: "artisan", data: "<?php" }, { name: "composer.json", data: "{}" }, { name: "public/index.php", data: "<?php" }]);
  await upload(c, "migrate-app", source).expect(202);
  await c.service.waitIdle();
  expect(migration).toHaveBeenCalledTimes(1);
  const first = await getApp(c, "migrate-app");
  expect(first.activeRelease.id).toBeTruthy();
  migration.mockResolvedValue({ started: true, detail: "failed" });
  await upload(c, "migrate-app", source).expect(202);
  await c.service.waitIdle();
  const failed = await getApp(c, "migrate-app");
  expect(failed.activeRelease.id).toBe(first.activeRelease.id);
  expect(failed.deployments[0].status).toBe("failed");
  await request(c.app).post("/api/v1/hosting/apps/migrate-app/database/migrate").set("Cookie", c.cookie).send({ confirm: "wrong" }).expect(400);
  migration.mockResolvedValue({ started: true, detail: null });
  await request(c.app).post("/api/v1/hosting/apps/migrate-app/database/migrate").set("Cookie", c.cookie).send({ confirm: "migrate-app" }).expect(200);
});


describe("phpMyAdmin bridge", () => {
  it("requires both dashboard login and bridge key, and sends only the app credentials", async () => {
    const key = "a".repeat(64);
    const c = await setup({ PHPMYADMIN_ENABLED: "true", PHPMYADMIN_BRIDGE_KEY: key });
    await create(c, { id: "pma-app", name: "PMA", runtime: "laravel", deployMethod: "upload" }).expect(201);
    const sql = vi.spyOn(MysqlAdmin.prototype, "run").mockResolvedValue();
    try { await c.service.managedDatabase("pma-app", "create", "test"); } finally { sql.mockRestore(); }
    const url = "/api/v1/hosting/apps/pma-app/database/phpmyadmin-credentials";
    await request(c.app).post(url).set("X-Nif-Pma-Key", key).send({}).expect(401);
    await request(c.app).post(url).set("Cookie", c.cookie).send({}).expect(403);
    await request(c.app).post(url).set("Cookie", c.cookie).set("X-Nif-Pma-Key", "wrong").send({}).expect(403);
    const secret = (await c.service.secrets.read("pma-app")).dbPassword;
    const detail = await getApp(c, "pma-app");
    expect(detail.phpMyAdminAvailable).toBe(true);
    expect(JSON.stringify(detail)).not.toContain(secret);
    const result = await request(c.app).post(url).set("Cookie", c.cookie).set("X-Nif-Pma-Key", key).send({}).expect(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body.data).toEqual({ user: managedName("pma-app"), password: secret, host: "127.0.0.1", port: 3306, database: managedName("pma-app") });
    await request(c.app).post("/api/v1/auth/logout").set("Cookie", c.cookie).send({}).expect(200);
    await request(c.app).post(url).set("Cookie", c.cookie).set("X-Nif-Pma-Key", key).send({}).expect(401);
  });
  it("rejects manual accounts and stays disabled by default", async () => {
    const c = await setup({ PHPMYADMIN_ENABLED: "true", PHPMYADMIN_BRIDGE_KEY: "b".repeat(64) });
    await create(c, { id: "manual-pma", name: "Manual", runtime: "node", deployMethod: "upload" }).expect(201);
    await c.service.setDatabase("manual-pma", { type: "mysql", user: "root", name: "mysql", password: "not-exportable" }, "test");
    expect((await getApp(c, "manual-pma")).phpMyAdminAvailable).toBe(false);
    await request(c.app).post("/api/v1/hosting/apps/manual-pma/database/phpmyadmin-credentials").set("Cookie", c.cookie).set("X-Nif-Pma-Key", "b".repeat(64)).send({}).expect(400);
    const off = await setup();
    await request(off.app).post("/api/v1/hosting/apps/manual-pma/database/phpmyadmin-credentials").set("Cookie", off.cookie).set("X-Nif-Pma-Key", "b".repeat(64)).send({}).expect(404);
  });
});
