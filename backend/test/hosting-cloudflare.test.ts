import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { addIngress, Cloudflare, removeIngress } from "../src/hosting/cloudflare.js";

const ZONE = "a".repeat(32);
const ACCOUNT = "b".repeat(32);
const TUNNEL = "11111111-2222-3333-4444-555555555555";
const TARGET = `${TUNNEL}.cfargotunnel.com`;
const SECRET = "tok_" + "x".repeat(30);

const env = (over: Record<string, string> = {}) =>
  loadEnv({
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD_HASH: "$2a$04$" + "a".repeat(53),
    NODE_ENV: "test",
    CLOUDFLARE_API_TOKEN: SECRET,
    CLOUDFLARE_ZONE_ID: ZONE,
    CLOUDFLARE_TUNNEL_ID: TUNNEL,
    ...over,
  });

interface Call {
  method: string;
  path: string;
  auth: string | null;
}

type Rec = { id: string; type: string; name: string; content: string };

/** In-memory Cloudflare: one zone, DNS records, and an optional remotely-managed tunnel. */
function fakeCf(opts: { records?: Rec[]; source?: string; deny?: boolean; chActive?: boolean } = {}) {
  const records = [...(opts.records ?? [])];
  const custom: { id: string; hostname: string; status: string; ssl: { status: string } }[] = [];
  let fallback = "";
  let ingress: { hostname?: string; service: string }[] = [{ hostname: "drive.example.com", service: "http://127.0.0.1:80" }, { service: "http_status:404" }];
  const calls: Call[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace("/client/v4", "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, auth: (init.headers as Record<string, string>).Authorization });
    const json = (result: unknown, status = 200) =>
      new Response(JSON.stringify({ success: status < 400, errors: status < 400 ? [] : [{ message: "denied" }], result }), { status });
    if (opts.deny) return json(null, 403);
    if (path === `/zones/${ZONE}`) return json({ name: "example.com" });
    if (path === `/zones/${ZONE}/dns_records` && method === "GET") {
      const name = u.searchParams.get("name");
      const type = u.searchParams.get("type");
      return json(records.filter((r) => r.name === name && (!type || r.type === type)));
    }
    if (path === `/zones/${ZONE}/dns_records` && method === "POST") {
      records.push({ id: `id${records.length}`, ...body });
      return json(body);
    }
    if (path.startsWith(`/zones/${ZONE}/dns_records/`) && method === "DELETE") {
      records.splice(records.findIndex((r) => r.id === path.split("/").pop()), 1);
      return json({});
    }
    if (path === `/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}/configurations`) {
      if (method === "GET") return json({ source: opts.source ?? "cloudflare", config: { ingress } });
      ingress = body.config.ingress;
      return json({});
    }
    if (path === `/zones/${ZONE}/custom_hostnames/fallback_origin`) {
      if (method === "PUT") fallback = body.origin;
      return json({ origin: fallback });
    }
    if (path === `/zones/${ZONE}/custom_hostnames` && method === "GET") {
      const h = u.searchParams.get("hostname");
      return json(custom.filter((c) => c.hostname === h));
    }
    if (path === `/zones/${ZONE}/custom_hostnames` && method === "POST") {
      const c = { id: `ch${custom.length}`, hostname: body.hostname, status: opts.chActive ? "active" : "pending", ssl: { status: opts.chActive ? "active" : "pending_validation" } };
      custom.push(c);
      return json(c);
    }
    if (path.startsWith(`/zones/${ZONE}/custom_hostnames/`) && method === "DELETE") {
      custom.splice(custom.findIndex((c) => c.id === path.split("/").pop()), 1);
      return json({});
    }
    return json(null, 404);
  }) as unknown as typeof fetch;
  return { fetcher, records, calls, custom, fallback: () => fallback, ingress: () => ingress };
}

describe("ingress helpers", () => {
  const gw = "http://127.0.0.1:8090";
  it("inserts before the catch-all and is idempotent", () => {
    const base = [{ hostname: "drive.example.com", service: "http://127.0.0.1:80" }, { service: "http_status:404" }];
    const r = addIngress(base, ["a.example.com", "drive.example.com"], gw);
    expect(r.added).toEqual(["a.example.com"]);
    expect(r.ingress.map((x) => x.hostname ?? "*")).toEqual(["drive.example.com", "a.example.com", "*"]);
    expect(addIngress(r.ingress, ["a.example.com"], gw).added).toEqual([]);
  });
  it("adds a catch-all when missing and removes only gateway rules", () => {
    expect(addIngress([], ["a.example.com"], gw).ingress.at(-1)).toEqual({ service: "http_status:404" });
    const list = [{ hostname: "a.example.com", service: gw }, { hostname: "drive.example.com", service: "http://127.0.0.1:80" }, { service: "http_status:404" }];
    const r = removeIngress(list, ["a.example.com", "drive.example.com"], gw);
    expect(r.removed).toEqual(["a.example.com"]);
    expect(r.ingress).toHaveLength(2);
  });
});

describe("Cloudflare client", () => {
  it("does nothing when not configured", async () => {
    const f = fakeCf();
    const cf = new Cloudflare(env({ CLOUDFLARE_API_TOKEN: "" }), f.fetcher);
    expect(await cf.sync(["a.example.com"], [])).toEqual([]);
    expect((await cf.status()).configured).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("creates a proxied CNAME to the tunnel, once", async () => {
    const f = fakeCf();
    const cf = new Cloudflare(env(), f.fetcher);
    const [r] = await cf.sync(["a.example.com"], []);
    expect(r).toMatchObject({ domain: "a.example.com", ok: true });
    expect(f.records).toMatchObject([{ type: "CNAME", name: "a.example.com", content: TARGET, proxied: true }]);
    expect(f.calls.every((c) => c.auth === `Bearer ${SECRET}`)).toBe(true);
    await cf.sync(["a.example.com"], []);
    expect(f.records).toHaveLength(1);
  });

  it("refuses to overwrite a foreign record and skips domains outside the zone", async () => {
    const f = fakeCf({ records: [{ id: "x", type: "A", name: "a.example.com", content: "1.2.3.4" }] });
    const cf = new Cloudflare(env(), f.fetcher);
    const res = await cf.sync(["a.example.com", "x.other.org"], []);
    const a = res.find((r) => r.domain === "a.example.com")!;
    const b = res.find((r) => r.domain === "x.other.org")!;
    expect(a.ok).toBe(false);
    expect(a.error).toMatch(/Sudah ada record DNS/);
    expect(b.ok).toBe(true);
    expect(b.steps[0]).toMatch(/di luar zona/);
    expect(f.records).toHaveLength(1);
  });

  it("deletes only records pointing at its own tunnel", async () => {
    const f = fakeCf({
      records: [
        { id: "mine", type: "CNAME", name: "a.example.com", content: TARGET },
        { id: "other", type: "CNAME", name: "b.example.com", content: "elsewhere.example.net" },
      ],
    });
    const cf = new Cloudflare(env(), f.fetcher);
    await cf.sync([], ["a.example.com", "b.example.com"]);
    expect(f.records.map((r) => r.id)).toEqual(["other"]);
  });

  it("manages tunnel ingress when the tunnel is remotely managed", async () => {
    const f = fakeCf();
    const cf = new Cloudflare(env({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT }), f.fetcher);
    await cf.sync(["a.example.com"], []);
    expect(f.ingress().map((x) => x.hostname ?? "*")).toEqual(["drive.example.com", "a.example.com", "*"]);
    await cf.sync([], ["a.example.com"]);
    expect(f.ingress().map((x) => x.hostname ?? "*")).toEqual(["drive.example.com", "*"]);
  });

  it("leaves a locally-managed tunnel alone", async () => {
    const f = fakeCf({ source: "local" });
    const cf = new Cloudflare(env({ CLOUDFLARE_ACCOUNT_ID: ACCOUNT }), f.fetcher);
    const [r] = await cf.sync(["a.example.com"], []);
    expect(r.ok).toBe(true);
    expect(r.steps.join()).toMatch(/config\.yml lokal/);
    expect(f.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("registers domains from other accounts as custom hostnames (Cloudflare for SaaS)", async () => {
    const f = fakeCf();
    const cf = new Cloudflare(env({ CLOUDFLARE_SAAS_EDGE: "edge.example.com", CLOUDFLARE_ACCOUNT_ID: ACCOUNT }), f.fetcher);
    expect((await cf.status()).saasEdge).toBe("edge.example.com");
    const [r] = await cf.sync(["app.other.org"], []);
    expect(r.ok).toBe(true);
    expect(r.steps.join()).toMatch(/CNAME app\.other\.org → edge\.example\.com/);
    expect(f.records).toMatchObject([{ type: "CNAME", name: "edge.example.com", content: TARGET }]);
    expect(f.fallback()).toBe("edge.example.com");
    expect(f.custom.map((c) => c.hostname)).toEqual(["app.other.org"]);
    expect(f.ingress().map((x) => x.hostname ?? "*")).toContain("app.other.org");
    await cf.sync(["app.other.org"], []);
    expect(f.custom).toHaveLength(1);
    await cf.sync([], ["app.other.org"]);
    expect(f.custom).toHaveLength(0);
    expect(f.ingress().map((x) => x.hostname ?? "*")).not.toContain("app.other.org");
  });

  it("reports an active custom hostname", async () => {
    const f = fakeCf({ chActive: true });
    const cf = new Cloudflare(env({ CLOUDFLARE_SAAS_EDGE: "edge.example.com" }), f.fetcher);
    const [r] = await cf.sync(["app.other.org"], []);
    expect(r.steps.join()).toMatch(/aktif/);
  });

  it("reports API errors without leaking the token", async () => {
    const cf = new Cloudflare(env(), fakeCf({ deny: true }).fetcher);
    const [r] = await cf.sync(["a.example.com"], []);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Token Cloudflare ditolak/);
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
