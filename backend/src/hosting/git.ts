import dns from "node:dns/promises";
import net from "node:net";

/** Thrown with a message that is safe to show to the administrator. */
export class SourceError extends Error {}

// Loopback, private, link-local (incl. cloud metadata 169.254.169.254), CGNAT,
// documentation, benchmarking, multicast, and reserved ranges.
const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net4, prefix, "ipv4");
for (const [net6, prefix] of [
  ["::", 128], ["::1", 128], ["::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10],
  ["fec0::", 10], ["ff00::", 8],
] as const) blocked.addSubnet(net6, prefix, "ipv6");

function embeddedV4(ip: string): string | null {
  // ::ffff:a.b.c.d (mapped), 64:ff9b::a.b.c.d (NAT64), 2002:AABB:CCDD:: (6to4)
  const lower = ip.toLowerCase();
  const dotted = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const hex = lower.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  const m = hex ?? sixToFour;
  if (!m) return null;
  const a = parseInt(m[1], 16);
  const b = parseInt(m[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return !blocked.check(ip, "ipv4");
  if (family === 6) {
    const v4 = embeddedV4(ip);
    if (v4) return isPublicAddress(v4);
    return !blocked.check(ip, "ipv6");
  }
  return false;
}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const res = await Promise.race([
    dns.lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000).unref()),
  ]);
  return res.map((r) => r.address);
};

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Accepts only `https://<allowed-host>/<owner>/<repo>[.git]` and returns a
 * normalized clone URL. No credentials, ports, query strings, or other schemes
 * (ssh, git://, file://, ext::) are accepted.
 */
export function normalizeRepoUrl(raw: string, allowedHosts: string[]): { url: string; host: string; slug: string } {
  const s = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > 300 || /[\s\x00-\x1f\x7f\\]/.test(s) || s.startsWith("-") || s.includes("::")) {
    throw new SourceError("URL repository tidak valid");
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new SourceError("URL repository tidak valid");
  }
  if (u.protocol !== "https:") throw new SourceError("Hanya URL https:// yang diizinkan");
  if (u.username || u.password) throw new SourceError("Jangan menaruh kredensial di URL; gunakan token deploy");
  if (u.port && u.port !== "443") throw new SourceError("Port kustom tidak diizinkan");
  if (u.search || u.hash) throw new SourceError("URL repository tidak boleh berisi query atau fragment");
  const host = u.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) throw new SourceError(`Host tidak diizinkan. Host yang diizinkan: ${allowedHosts.join(", ")}`);

  const parts = u.pathname.replace(/\/+$/, "").split("/").slice(1);
  if (parts.length !== 2) throw new SourceError("Format: https://github.com/<owner>/<repo>");
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/, "");
  if (!OWNER.test(owner) || !REPO.test(repo) || repo === "." || repo === "..") {
    throw new SourceError("Nama owner/repository tidak valid");
  }
  return { url: `https://${host}/${owner}/${repo}.git`, host, slug: `${owner}/${repo}` };
}

/**
 * Validates the URL and checks that the host currently resolves only to public
 * addresses. The clone itself also runs with redirects disabled and inside a
 * sandbox that blocks private networks (DNS rebinding defense in depth).
 */
export async function checkRepoSource(raw: string, allowedHosts: string[], resolve: Resolver = systemResolver) {
  const repo = normalizeRepoUrl(raw, allowedHosts);
  let addresses: string[];
  try {
    addresses = await resolve(repo.host);
  } catch {
    throw new SourceError(`Gagal resolve DNS untuk ${repo.host}`);
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
    throw new SourceError(`${repo.host} mengarah ke alamat jaringan internal; ditolak`);
  }
  return repo;
}
