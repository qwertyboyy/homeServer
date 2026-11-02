import type { Env } from "../config/env.js";

/**
 * Optional Cloudflare automation: a proxied CNAME to the tunnel for each hosted
 * domain and, when the tunnel is remotely managed, its ingress rule too.
 * The API token never leaves this module — it is not logged or put in errors.
 */

const API = "https://api.cloudflare.com/client/v4";
const COMMENT = "nifhost";

export interface DomainSyncResult {
  domain: string;
  ok: boolean;
  /** Human-readable steps that were taken (or skipped). */
  steps: string[];
  error: string | null;
}

export interface CloudflareStatus {
  configured: boolean;
  /** DNS records are managed (needs token + zone + tunnel). */
  dns: boolean;
  /** Tunnel ingress is managed through the API (additionally needs the account id). */
  ingress: boolean;
  zone: string | null;
  tunnelTarget: string | null;
}

export interface CloudflareClient {
  status(): Promise<CloudflareStatus>;
  /** Make `add` reachable and withdraw `remove`. Never throws for per-domain problems. */
  sync(add: string[], remove: string[]): Promise<DomainSyncResult[]>;
}

interface Envelope<T> {
  success: boolean;
  errors?: { code?: number; message?: string }[];
  result: T;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
}

interface IngressRule {
  hostname?: string;
  service: string;
  [k: string]: unknown;
}

interface TunnelConfigResult {
  source?: string;
  config?: { ingress?: IngressRule[]; [k: string]: unknown } | null;
}

class CloudflareError extends Error {}

/** Adds rules for `hostnames` before the catch-all (the last rule without a hostname), leaving every other rule untouched. */
export function addIngress(ingress: IngressRule[], hostnames: string[], service: string): { ingress: IngressRule[]; added: string[] } {
  const last = ingress[ingress.length - 1];
  const catchAll: IngressRule = last && last.hostname === undefined ? last : { service: "http_status:404" };
  const body = last && last.hostname === undefined ? ingress.slice(0, -1) : [...ingress];
  const added: string[] = [];
  for (const h of hostnames) {
    if (body.some((r) => r.hostname === h)) continue;
    body.push({ hostname: h, service });
    added.push(h);
  }
  return { ingress: [...body, catchAll], added };
}

/** Removes only rules that point at our gateway for exactly these hostnames. */
export function removeIngress(ingress: IngressRule[], hostnames: string[], service: string): { ingress: IngressRule[]; removed: string[] } {
  const removed: string[] = [];
  const kept = ingress.filter((r) => {
    if (r.hostname && hostnames.includes(r.hostname) && r.service === service) {
      removed.push(r.hostname);
      return false;
    }
    return true;
  });
  return { ingress: kept, removed };
}

export class Cloudflare implements CloudflareClient {
  private zoneName: string | null = null;

  constructor(
    private readonly env: Env,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private get token() {
    return this.env.CLOUDFLARE_API_TOKEN;
  }
  private get zoneId() {
    return this.env.CLOUDFLARE_ZONE_ID;
  }
  private get tunnelId() {
    return this.env.CLOUDFLARE_TUNNEL_ID;
  }
  private get accountId() {
    return this.env.CLOUDFLARE_ACCOUNT_ID;
  }
  private get dnsEnabled() {
    return !!(this.token && this.zoneId && this.tunnelId);
  }
  private get ingressEnabled() {
    return this.dnsEnabled && !!this.accountId;
  }
  private get target() {
    return this.tunnelId ? `${this.tunnelId}.cfargotunnel.com` : null;
  }
  private get gatewayService() {
    return `http://127.0.0.1:${this.env.HOSTING_GATEWAY_PORT}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new CloudflareError("Tidak dapat terhubung ke API Cloudflare");
    }
    let json: Envelope<T> | null = null;
    try {
      json = (await res.json()) as Envelope<T>;
    } catch {
      /* non-JSON */
    }
    if (!res.ok || !json?.success) {
      const msg = json?.errors?.[0]?.message;
      if (res.status === 401 || res.status === 403) throw new CloudflareError(`Token Cloudflare ditolak${msg ? ` (${msg})` : ""} — periksa izin token`);
      throw new CloudflareError(msg ? `Cloudflare: ${msg}` : `Cloudflare HTTP ${res.status}`);
    }
    return json.result;
  }

  private async zone() {
    if (!this.zoneName) this.zoneName = (await this.call<{ name: string }>("GET", `/zones/${this.zoneId}`)).name.toLowerCase();
    return this.zoneName;
  }

  async status(): Promise<CloudflareStatus> {
    let zone: string | null = null;
    if (this.dnsEnabled) {
      try {
        zone = await this.zone();
      } catch {
        /* surfaced when syncing */
      }
    }
    return { configured: this.dnsEnabled, dns: this.dnsEnabled, ingress: this.ingressEnabled, zone, tunnelTarget: this.target };
  }

  async sync(add: string[], remove: string[]): Promise<DomainSyncResult[]> {
    if (!this.dnsEnabled) return [];
    const results = new Map<string, DomainSyncResult>();
    const entry = (domain: string) => {
      let r = results.get(domain);
      if (!r) results.set(domain, (r = { domain, ok: true, steps: [], error: null }));
      return r;
    };
    const fail = (domain: string, err: unknown) => {
      const r = entry(domain);
      r.ok = false;
      r.error = err instanceof Error ? err.message : "Kesalahan tidak dikenal";
    };

    let zone: string;
    try {
      zone = await this.zone();
    } catch (err) {
      for (const d of [...add, ...remove]) fail(d, err);
      return [...results.values()];
    }
    const inZone = (d: string) => d === zone || d.endsWith(`.${zone}`);
    const eligible = (list: string[]) =>
      list.filter((d) => {
        if (inZone(d)) return true;
        entry(d).steps.push(`DNS dilewati: di luar zona ${zone} (atur manual)`);
        return false;
      });
    const toAdd = eligible(add);
    const toRemove = eligible(remove);

    for (const d of toAdd) {
      try {
        const found = await this.call<DnsRecord[]>("GET", `/zones/${this.zoneId}/dns_records?name=${encodeURIComponent(d)}&per_page=5`);
        const own = found.find((r) => r.type === "CNAME" && r.content.toLowerCase() === this.target);
        if (own) entry(d).steps.push("DNS sudah mengarah ke tunnel");
        else if (found.length) throw new CloudflareError(`Sudah ada record DNS ${found[0].type} untuk ${d}; hapus dulu di Cloudflare agar tidak menimpa`);
        else {
          await this.call("POST", `/zones/${this.zoneId}/dns_records`, { type: "CNAME", name: d, content: this.target, proxied: true, ttl: 1, comment: COMMENT });
          entry(d).steps.push("Record CNAME dibuat (proxied)");
        }
      } catch (err) {
        fail(d, err);
      }
    }

    for (const d of toRemove) {
      try {
        const found = await this.call<DnsRecord[]>("GET", `/zones/${this.zoneId}/dns_records?name=${encodeURIComponent(d)}&type=CNAME&per_page=5`);
        // Only ever delete a record that points at our tunnel.
        const own = found.find((r) => r.content.toLowerCase() === this.target);
        if (own) {
          await this.call("DELETE", `/zones/${this.zoneId}/dns_records/${own.id}`);
          entry(d).steps.push("Record CNAME dihapus");
        } else entry(d).steps.push("Tidak ada record tunnel untuk dihapus");
      } catch (err) {
        fail(d, err);
      }
    }

    if (this.ingressEnabled && (toAdd.length || toRemove.length)) await this.syncIngress(toAdd, toRemove, entry, fail);
    return [...results.values()];
  }

  private async syncIngress(add: string[], remove: string[], entry: (d: string) => DomainSyncResult, fail: (d: string, e: unknown) => void) {
    const path = `/accounts/${this.accountId}/cfd_tunnel/${this.tunnelId}/configurations`;
    try {
      const current = await this.call<TunnelConfigResult>("GET", path);
      if (current.source && current.source !== "cloudflare") {
        for (const d of [...add, ...remove]) entry(d).steps.push("Ingress dilewati: tunnel dikelola lewat config.yml lokal");
        return;
      }
      const config = current.config ?? {};
      let ingress = config.ingress?.length ? config.ingress : [{ service: "http_status:404" }];
      const added = addIngress(ingress, add, this.gatewayService);
      ingress = added.ingress;
      const removed = removeIngress(ingress, remove, this.gatewayService);
      ingress = removed.ingress;
      if (added.added.length || removed.removed.length) {
        await this.call("PUT", path, { config: { ...config, ingress } });
      }
      for (const d of added.added) entry(d).steps.push("Ingress tunnel ditambahkan");
      for (const d of removed.removed) entry(d).steps.push("Ingress tunnel dihapus");
      for (const d of add) if (!added.added.includes(d)) entry(d).steps.push("Ingress tunnel sudah ada");
    } catch (err) {
      for (const d of [...add, ...remove]) fail(d, err);
    }
  }
}
