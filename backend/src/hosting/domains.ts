import dns from "node:dns/promises";
import fs from "node:fs/promises";

export interface TunnelRule {
  hostname: string;
  service: string;
}

export type TunnelConfig =
  | { status: "ok"; rules: TunnelRule[] }
  | { status: "missing" | "unreadable"; rules: [] };

/**
 * Reads ingress rules from cloudflared's config.yml (read-only, never written).
 * A deliberately small line parser: we only need `hostname` / `service` pairs.
 */
export async function readTunnelConfig(file: string): Promise<TunnelConfig> {
  let raw: string;
  try {
    const st = await fs.stat(file);
    if (st.size > 256 * 1024) return { status: "unreadable", rules: [] };
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    return { status: (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable", rules: [] };
  }
  const rules: TunnelRule[] = [];
  let current: Partial<TunnelRule> | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const clean = line.replace(/\s+#.*$/, "");
    if (/^\s*#/.test(line)) continue;
    const item = clean.match(/^\s*-\s+(\w+):\s*(.*)$/);
    const field = item ?? clean.match(/^\s+(\w+):\s*(.*)$/);
    if (item) {
      if (current?.hostname && current.service) rules.push(current as TunnelRule);
      current = {};
    }
    if (!field || !current) continue;
    const value = field[2].trim().replace(/^["']|["']$/g, "");
    if (field[1] === "hostname") current.hostname = value.toLowerCase();
    if (field[1] === "service") current.service = value;
  }
  if (current?.hostname && current.service) rules.push(current as TunnelRule);
  return { status: "ok", rules };
}

export function hostMatches(rule: string, host: string) {
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1);
    return host.endsWith(suffix) && !host.slice(0, -suffix.length).includes(".");
  }
  return rule === host;
}

export interface DnsStatus {
  status: "tunnel" | "resolves" | "missing" | "error";
  detail: string | null;
}

async function withTimeout<T>(p: Promise<T>, ms: number) {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(Object.assign(new Error("timeout"), { code: "ETIMEOUT" })), ms).unref())]);
}

export async function dnsStatus(domain: string): Promise<DnsStatus> {
  try {
    const cname = await withTimeout(dns.resolveCname(domain), 3000);
    if (cname.some((c) => c.endsWith(".cfargotunnel.com"))) return { status: "tunnel", detail: cname[0] };
    return { status: "resolves", detail: `CNAME ${cname[0]}` };
  } catch {
    /* no CNAME (Cloudflare usually flattens proxied records) — try A/AAAA */
  }
  try {
    const a = await withTimeout(dns.lookup(domain, { all: true }), 3000);
    return a.length ? { status: "resolves", detail: a.map((x) => x.address).slice(0, 3).join(", ") } : { status: "missing", detail: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOTFOUND" || code === "ENODATA" ? { status: "missing", detail: null } : { status: "error", detail: code ?? null };
  }
}

export function tunnelSnippet(domains: string[], gatewayPort: number) {
  const rules = domains.map((d) => `  - hostname: ${d}\n    service: http://127.0.0.1:${gatewayPort}`).join("\n");
  return [
    "# /etc/cloudflared/config.yml — tambahkan DI ATAS rule `- service: http_status:404`.",
    "# Backup dulu. Jangan ubah rule drive.nifserver.cloud / panel.nifserver.cloud.",
    "ingress:",
    rules,
    "  - service: http_status:404",
  ].join("\n");
}

export function tunnelCommands(domains: string[]) {
  return [
    "sudo cp /etc/cloudflared/config.yml /etc/cloudflared/config.yml.bak-$(date +%F-%H%M)",
    "sudoedit /etc/cloudflared/config.yml   # tempel snippet di atas",
    "cloudflared tunnel ingress validate",
    ...domains.map((d) => `cloudflared tunnel route dns <nama-tunnel> ${d}`),
    "sudo systemctl restart cloudflared",
  ];
}
