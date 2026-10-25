import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArchiveError, defaultLimits, extractZip, inspectZip } from "../src/hosting/archive.js";
import { hostMatches, readTunnelConfig } from "../src/hosting/domains.js";
import { assertManagedUnit, SystemdExecutor, unitName } from "../src/hosting/executor.js";
import { checkRepoSource, isPublicAddress, normalizeRepoUrl, SourceError } from "../src/hosting/git.js";
import { AppId, Branch, envKeyProblem, Hostname } from "../src/hosting/model.js";
import { httpProbe, isHealthyStatus } from "../src/hosting/health.js";
import { createRedactor } from "../src/hosting/sanitize.js";
import { envLine } from "../src/hosting/secrets.js";
// @ts-expect-error plain ESM runtime script without type declarations
import { BINARIES, buildSteps, gitCloneArgs, validatePlan } from "../runtime/builder.mjs";
// @ts-expect-error plain ESM runtime script without type declarations
import { createGateway, safeSegments, validateRoutes } from "../runtime/gateway.mjs";
import { makeZip, type ZipEntry } from "./helpers/zip.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nif-unit-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const limits = defaultLimits(10 * 1024 * 1024);
async function zipFile(entries: ZipEntry[]) {
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.zip`);
  await fs.writeFile(file, makeZip(entries));
  return file;
}

describe("ZIP validation", () => {
  it("accepts a normal archive", async () => {
    const r = await inspectZip(await zipFile([{ name: "index.html", data: "<h1>hi</h1>" }, { name: "css/", data: "" }, { name: "css/a.css", data: "a{}" }]), limits);
    expect(r.entries.map((e) => e.name).sort()).toEqual(["css", "css/a.css", "index.html"]);
  });

  it.each([
    ["../evil.txt"],
    ["a/../../evil.txt"],
    ["/etc/passwd"],
    ["C:/Windows/evil.txt"],
    ["a\\..\\evil.txt"],
    ["ok/./x.txt"],
  ])("rejects unsafe path %s", async (name) => {
    await expect(inspectZip(await zipFile([{ name, data: "x" }]), limits)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("rejects symlink entries", async () => {
    const file = await zipFile([{ name: "index.html", data: "x" }, { name: "link", data: "/etc/shadow", mode: 0o120777 }]);
    await expect(inspectZip(file, limits)).rejects.toThrow(/symlink/);
  });

  it("rejects duplicate names (case-insensitive) and file/dir conflicts", async () => {
    await expect(inspectZip(await zipFile([{ name: "A.txt", data: "1" }, { name: "a.txt", data: "2" }]), limits)).rejects.toThrow(/duplikat/);
    await expect(inspectZip(await zipFile([{ name: "a", data: "1" }, { name: "a/b", data: "2" }]), limits)).rejects.toThrow(/Konflik/);
  });

  it("rejects zip bombs by compression ratio", async () => {
    const file = await zipFile([{ name: "zeros.bin", data: Buffer.alloc(8 * 1024 * 1024), deflate: true }]);
    await expect(inspectZip(file, limits)).rejects.toThrow(/zip bomb/);
  });

  it("rejects archives whose declared size exceeds the limit", async () => {
    const file = await zipFile([{ name: "big.bin", data: "x", declaredSize: 50 * 1024 * 1024 }]);
    await expect(inspectZip(file, limits)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("rejects encrypted entries and non-zip files", async () => {
    await expect(inspectZip(await zipFile([{ name: "a.txt", data: "x", encrypted: true }]), limits)).rejects.toBeInstanceOf(ArchiveError);
    await expect(inspectZip(await zipFile([{ name: "a.txt", data: "x".repeat(100), encrypted: true, deflate: true }]), limits)).rejects.toBeInstanceOf(ArchiveError);
    const junk = path.join(dir, "junk.zip");
    await fs.writeFile(junk, "not a zip at all");
    await expect(inspectZip(junk, limits)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("enforces real sizes while inflating (lying header)", async () => {
    const file = await zipFile([{ name: "index.html", data: "x".repeat(5000), declaredSize: 10 }]);
    await expect(extractZip(file, path.join(dir, "out"), limits)).rejects.toBeInstanceOf(ArchiveError);
  });

  it("extracts inside the target only, strips a single top folder, skips secrets and VCS data", async () => {
    const file = await zipFile([
      { name: "site/", data: "" },
      { name: "site/index.html", data: "ok" },
      { name: "site/.env", data: "SECRET=1" },
      { name: "site/.env.example", data: "SECRET=" },
      { name: "site/.git/config", data: "[core]" },
      { name: "site/node_modules/x/index.js", data: "x" },
    ]);
    const out = path.join(dir, "out");
    const r = await extractZip(file, out, limits);
    expect(r.stripped).toBe("site/");
    const files = (await fs.readdir(out, { recursive: true })).map((f) => String(f).replace(/\\/g, "/")).sort();
    expect(files).toEqual([".env.example", "index.html"]);
    expect(await fs.readdir(dir)).not.toContain("index.html");
  });
});

describe("git source / SSRF", () => {
  it.each([
    ["127.0.0.1", false], ["10.1.2.3", false], ["172.20.0.1", false], ["192.168.1.10", false], ["169.254.169.254", false],
    ["100.64.0.1", false], ["0.0.0.0", false], ["::1", false], ["fe80::1", false], ["fd00::1", false],
    ["::ffff:127.0.0.1", false], ["::ffff:7f00:1", false], ["64:ff9b::a9fe:a9fe", false], ["2002:c0a8:0101::1", false],
    ["140.82.112.3", true], ["2606:4700::1111", true], ["not-an-ip", false],
  ])("isPublicAddress(%s) = %s", (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });

  it.each([
    "http://github.com/a/b",
    "git@github.com:a/b.git",
    "ssh://github.com/a/b",
    "file:///etc/passwd",
    "ext::sh -c id",
    "https://user:pass@github.com/a/b",
    "https://github.com:8443/a/b",
    "https://github.com.evil.com/a/b",
    "https://127.0.0.1/a/b",
    "https://[::1]/a/b",
    "https://169.254.169.254/latest/meta-data",
    "https://0x7f000001/a/b",
    "https://github.com/a/b?x=1",
    "https://github.com/a",
    "https://github.com/a/b/c",
    "-uhttps://github.com/a/b",
    "https://github.com/--upload-pack=x/b",
  ])("rejects %s", (url) => {
    expect(() => normalizeRepoUrl(url, ["github.com"])).toThrow(SourceError);
  });

  it("normalizes a valid repository URL", () => {
    expect(normalizeRepoUrl("https://GitHub.com/owner/my.repo", ["github.com"]).url).toBe("https://github.com/owner/my.repo.git");
  });

  it("rejects an allowed host that resolves to an internal address (DNS rebinding)", async () => {
    await expect(checkRepoSource("https://github.com/a/b", ["github.com"], async () => ["140.82.112.3", "10.0.0.5"])).rejects.toThrow(/internal/);
    await expect(checkRepoSource("https://github.com/a/b", ["github.com"], async () => [])).rejects.toThrow(SourceError);
    await expect(checkRepoSource("https://github.com/a/b", ["github.com"], async () => ["140.82.112.3"])).resolves.toMatchObject({ slug: "a/b" });
  });

  it("validates branch names", () => {
    for (const ok of ["main", "release/1.2", "feature_x"]) expect(Branch.safeParse(ok).success).toBe(true);
    for (const bad of ["-x", "--upload-pack=sh", "a..b", "a b", "x.lock", "a//b", "@{0}", ""]) expect(Branch.safeParse(bad).success, bad).toBe(false);
  });
});

describe("builder allowlist", () => {
  const plan = (over: Record<string, unknown> = {}) => ({ version: 1, appId: "web", phase: "build", releaseId: "r20261025101500-abcdef", runtime: "vite", options: {}, buildEnv: {}, ...over });

  it("only ever runs allowlisted binaries with fixed arguments", () => {
    const info = { pkg: { scripts: { build: "vite build" } }, hasLock: true, hasComposer: true };
    for (const runtime of ["static", "vite", "nextjs", "node", "laravel", "php"]) {
      for (const [bin, args] of buildSteps(runtime, info) as [string, string[]][]) {
        expect(Object.keys(BINARIES)).toContain(bin);
        for (const a of args) expect(a).toMatch(/^[a-z=-]+$/);
      }
    }
    expect(() => buildSteps("python", info)).toThrow();
  });

  it("rejects tampered plans", () => {
    expect(validatePlan(plan(), "web").runtime).toBe("vite");
    expect(() => validatePlan(plan({ runtime: "bash" }), "web")).toThrow();
    expect(() => validatePlan(plan({ phase: "exec" }), "web")).toThrow();
    expect(() => validatePlan(plan({ appId: "other" }), "web")).toThrow();
    expect(() => validatePlan(plan({ releaseId: "../../etc" }), "web")).toThrow();
    expect(() => validatePlan(plan({ options: { outputDir: "../.." } }), "web")).toThrow();
    expect(() => validatePlan(plan({ options: { command: "rm -rf /" } }), "web")).toThrow();
    expect(() => validatePlan(plan({ buildEnv: { LD_PRELOAD: "/tmp/x.so" } }), "web")).toThrow();
    expect(() => validatePlan(plan({ buildEnv: { NODE_OPTIONS: "--require x" } }), "web")).toThrow();
    expect(() => validatePlan(plan({ phase: "fetch", repo: { url: "https://127.0.0.1/a/b", branch: "main" } }), "web")).toThrow();
    expect(() => validatePlan(plan({ phase: "fetch", repo: { url: "https://github.com/a/b.git", branch: "--upload-pack=x" } }), "web")).toThrow();
  });

  it("clones with redirects, symlinks, hooks and submodules disabled", () => {
    const args: string[] = gitCloneArgs("https://github.com/a/b.git", "main", "/tmp/r");
    for (const flag of ["protocol.allow=never", "protocol.https.allow=always", "http.followRedirects=false", "core.symlinks=false", "core.hooksPath=/dev/null", "--no-recurse-submodules"]) {
      expect(args).toContain(flag);
    }
    expect(args.indexOf("--")).toBe(args.indexOf("https://github.com/a/b.git") - 1);
  });
});

describe("systemd executor", () => {
  it("only addresses nifapp@/nifbuild@ instances and the gateway", () => {
    expect(unitName("app", "blog")).toBe("nifapp@blog.service");
    for (const bad of ["../x", "a;b", "A", "x", "a b"]) expect(() => unitName("app", bad), bad).toThrow();
    // Even a confusing id stays inside the nifapp@ namespace, and the API refuses it anyway.
    expect(unitName("app", "nifserver-backend")).toBe("nifapp@nifserver-backend.service");
    expect(AppId.safeParse("nifserver-backend").success).toBe(false);
    for (const unit of ["nifserver-backend.service", "nifserver-frontend.service", "cloudflared.service", "apache2.service", "smbd.service", "ssh.service", "netdata.service", "nifapp@.service", "nifapp@x;y.service"]) {
      expect(() => assertManagedUnit(unit), unit).toThrow();
    }
  });

  it("passes the unit after `--` with --no-ask-password", async () => {
    const calls: [string, string[]][] = [];
    const ex = new SystemdExecutor(async (file, args) => {
      calls.push([file, args]);
      return { code: 0, stdout: "", stderr: "" };
    });
    await ex.unitAction("blog", "restart");
    expect(calls).toEqual([["systemctl", ["--no-ask-password", "restart", "--", "nifapp@blog.service"]]]);
  });
});

describe("validation helpers", () => {
  it("validates hostnames", () => {
    for (const ok of ["app.nifserver.cloud", "a-b.example.co.id"]) expect(Hostname.safeParse(ok).success).toBe(true);
    for (const bad of ["localhost", "127.0.0.1", "-a.com", "a..com", "http://a.com", "a.com/x", "*.a.com", "a_b.com"]) expect(Hostname.safeParse(bad).success, bad).toBe(false);
  });

  it("refuses reserved environment keys", () => {
    expect(envKeyProblem("API_KEY")).toBeNull();
    for (const k of ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "NIF_PORT", "PORT", "lower", "1X"]) expect(envKeyProblem(k), k).not.toBeNull();
  });

  it("escapes systemd EnvironmentFile values", () => {
    expect(envLine("A", 'x"$HOME`\\')).toBe('A="x\\"\\$HOME\\`\\\\"');
  });
});

describe("health checks", () => {
  it("treats 404 and 5xx as unhealthy (a missing route must not pass a deploy)", () => {
    for (const s of [200, 204, 301, 302, 401, 403]) expect(isHealthyStatus(s), String(s)).toBe(true);
    for (const s of [null, 400, 404, 410, 500, 502, 503]) expect(isHealthyStatus(s), String(s)).toBe(false);
  });

  it("probes 127.0.0.1 with the requested Host header", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      res.writeHead(req.headers.host === "web.nifhost.internal" ? 200 : 404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      expect((await httpProbe({ port, path: "/healthz", host: "web.nifhost.internal" })).ok).toBe(true);
      expect((await httpProbe({ port, path: "/", host: "other.example.com" })).ok).toBe(false);
      expect(seen).toEqual(["web.nifhost.internal /healthz", "other.example.com /"]);
    } finally {
      server.close();
    }
  });

  it("does not accept a 200 from a stale release (gateway not reloaded yet)", async () => {
    const root = path.join(dir, "root");
    const r1 = path.join(root, "apps", "web", "releases", "r20261025000000-aaaaaa");
    await fs.mkdir(r1, { recursive: true });
    await fs.writeFile(path.join(r1, "index.html"), "v1");
    const routes = validateRoutes({ routes: { "web.nifhost.internal": { type: "static", root: r1, release: "r20261025000000-aaaaaa" }, "web.example.com": { type: "static", root: r1, release: "r20261025000000-aaaaaa" } } }, root);
    const server = createGateway({ root, getRoutes: () => routes }) as http.Server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const target = { port, path: "/", host: "web.nifhost.internal" };
      expect((await httpProbe({ ...target, expectRelease: "r20261025000000-aaaaaa" })).ok).toBe(true);
      expect((await httpProbe({ ...target, expectRelease: "r20261025000001-bbbbbb" })).ok).toBe(false);
      // The release id is only disclosed on internal health-check hosts.
      const publicRes = await new Promise<http.IncomingMessage>((resolve) => http.get({ host: "127.0.0.1", port, path: "/", headers: { Host: "web.example.com" } }, resolve));
      publicRes.resume();
      expect(publicRes.headers["x-nifhost-release"]).toBeUndefined();
    } finally {
      server.close();
    }
  });
});

describe("log sanitizer", () => {
  it("removes known secrets and common credential formats", () => {
    const redact = createRedactor(["hunter2-very-secret"]);
    const out = redact(
      [
        "\x1b[31mconnecting with hunter2-very-secret\x1b[0m",
        `token ghp_${"a".repeat(36)}`,
        "fetch https://bob:pa55@github.com/x",
        "DB_PASSWORD=abc123 api_key: xyz",
        "Authorization: Bearer abc.def",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
      ].join("\n"),
    );
    for (const leaked of ["hunter2-very-secret", "ghp_aaaa", "pa55", "abc123", "xyz", "abc.def", "MIIE", "\x1b"]) expect(out).not.toContain(leaked);
    expect(out).toContain("[REDACTED]");
  });
});

describe("cloudflared config (read-only)", () => {
  it("parses ingress hostnames and matches wildcards", async () => {
    const file = path.join(dir, "config.yml");
    await fs.writeFile(file, "tunnel: abc\ningress:\n  - hostname: drive.nifserver.cloud\n    service: http://localhost:80\n  - hostname: '*.apps.nifserver.cloud'\n    service: http://127.0.0.1:8090\n  - service: http_status:404\n");
    const cfg = await readTunnelConfig(file);
    expect(cfg.rules).toEqual([
      { hostname: "drive.nifserver.cloud", service: "http://localhost:80" },
      { hostname: "*.apps.nifserver.cloud", service: "http://127.0.0.1:8090" },
    ]);
    expect(hostMatches("*.apps.nifserver.cloud", "blog.apps.nifserver.cloud")).toBe(true);
    expect(hostMatches("*.apps.nifserver.cloud", "a.b.apps.nifserver.cloud")).toBe(false);
    expect((await readTunnelConfig(path.join(dir, "missing.yml"))).status).toBe("missing");
  });
});

describe("gateway", () => {
  it("refuses dotfiles, traversal and dependency folders", () => {
    for (const bad of ["/.env", "/.git/config", "/a/../../etc/passwd", "/%2e%2e/x", "/node_modules/x.js", "/vendor/autoload.php", "/package.json", "/db.sqlite", "/x%00.html", "/a%2f..%2f.env", "/config.php"]) {
      expect(safeSegments(bad), bad).toBeNull();
    }
    expect(safeSegments("/assets/app.js")).toEqual(["assets", "app.js"]);
    expect(safeSegments("/.well-known/acme")).toEqual([".well-known", "acme"]);
  });

  it("only loads routes inside the hosting root", () => {
    const root = path.join(dir, "root");
    const good = path.join(root, "apps", "web", "releases", "r1");
    const routes = validateRoutes(
      { routes: { "web.example.com": { type: "static", root: good }, "evil.example.com": { type: "static", root: "/etc" }, "p.example.com": { type: "proxy", port: 22 } } },
      root,
    );
    expect([...routes.keys()]).toEqual(["web.example.com"]);
  });

  it("serves the active release and falls back to index.html for SPAs", async () => {
    const root = path.join(dir, "root");
    const site = path.join(root, "apps", "web", "releases", "r1");
    await fs.mkdir(path.join(site, "assets"), { recursive: true });
    await fs.writeFile(path.join(site, "index.html"), "<h1>home</h1>");
    await fs.writeFile(path.join(site, "assets", "app.js"), "console.log(1)");
    await fs.writeFile(path.join(site, ".env"), "SECRET=1");
    const routes = validateRoutes({ routes: { "web.example.com": { type: "static", root: site, spa: true } } }, root);
    const server = createGateway({ root, getRoutes: () => routes }) as http.Server;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const get = (p: string, host = "web.example.com") =>
      new Promise<{ status: number; body: string; type: string }>((resolve) => {
        http.get({ host: "127.0.0.1", port, path: p, headers: { Host: host } }, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode!, body, type: String(res.headers["content-type"]) }));
        });
      });
    try {
      expect(await get("/")).toMatchObject({ status: 200, body: "<h1>home</h1>" });
      expect(await get("/assets/app.js")).toMatchObject({ status: 200, type: expect.stringContaining("javascript") });
      expect((await get("/dashboard/settings")).body).toBe("<h1>home</h1>");
      expect((await get("/.env")).status).toBe(404);
      expect((await get("/%2e%2e/%2e%2e/etc/hosts")).status).toBe(404);
      expect((await get("/", "unknown.example.com")).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
