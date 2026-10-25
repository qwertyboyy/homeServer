import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
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

async function setup(envOver: Record<string, string> = {}, executorFactory?: (p: HostingPaths) => HostExecutor) {
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
