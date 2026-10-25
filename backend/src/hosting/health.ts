import http from "node:http";

export interface ProbeTarget {
  port: number;
  path: string;
  /** Host header; used to address a static site through the gateway. */
  host?: string;
  /** Static sites: only healthy if the gateway reports serving this release. */
  expectRelease?: string;
}

export interface ProbeResult {
  ok: boolean;
  status: number | null;
  checkedAt: string;
}

export const RELEASE_HEADER = "x-nifhost-release";

export type HealthProbe = (t: ProbeTarget) => Promise<ProbeResult>;

/**
 * Healthy = 2xx/3xx, or 401/403 for apps behind their own login. A 404 is a
 * failure: it usually means the route (or the gateway entry) is not live yet.
 */
export const isHealthyStatus = (status: number | null) =>
  status !== null && ((status >= 200 && status < 400) || status === 401 || status === 403);

/** One GET to 127.0.0.1 only — targets are platform-assigned ports, never user URLs. */
export const httpProbe: HealthProbe = (t) =>
  new Promise((resolve) => {
    const done = (status: number | null, releaseOk = true) =>
      resolve({ ok: releaseOk && isHealthyStatus(status), status, checkedAt: new Date().toISOString() });
    const req = http.request(
      { host: "127.0.0.1", port: t.port, path: t.path, method: "GET", headers: { Host: t.host ?? `127.0.0.1:${t.port}`, "User-Agent": "nifserver-health" }, timeout: 3000 },
      (res) => {
        res.resume();
        // The gateway reloads routes.json on a short poll; until it does, it is still serving the old release.
        done(res.statusCode ?? null, !t.expectRelease || res.headers[RELEASE_HEADER] === t.expectRelease);
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => done(null));
    req.end();
  });

/** Polls until healthy or the deadline passes (apps need a moment to bind their port). */
export async function waitHealthy(probe: HealthProbe, t: ProbeTarget, timeoutMs: number, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last: ProbeResult = { ok: false, status: null, checkedAt: new Date().toISOString() };
  while (Date.now() < deadline) {
    last = await probe(t);
    if (last.ok) return last;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  return last;
}
