import type { EventLog } from "../lib/events.js";
import type { MetricSeries } from "../system/types.js";

/** Public metric name → Netdata chart. Only these charts can ever be requested. */
export const METRIC_CHARTS = {
  cpu: { chart: "system.cpu", unit: "%" },
  memory: { chart: "system.ram", unit: "MiB" },
  swap: { chart: "mem.swap", unit: "MiB" },
  network: { chart: "system.net", unit: "kbit/s" },
  disk: { chart: "system.io", unit: "KiB/s" },
} as const;

export type MetricName = keyof typeof METRIC_CHARTS;

export class NetdataUnavailableError extends Error {}

interface NetdataData {
  labels: string[];
  data: (number | null)[][];
}

export class NetdataClient {
  private available: boolean | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly events: EventLog,
  ) {}

  async series(name: MetricName, rangeSeconds: number, points: number): Promise<MetricSeries> {
    const { chart, unit } = METRIC_CHARTS[name];
    const url = new URL("/api/v1/data", this.baseUrl);
    url.search = new URLSearchParams({
      chart,
      after: String(-rangeSeconds),
      points: String(points),
      group: "average",
      format: "json",
      options: "seconds",
    }).toString();

    let body: NetdataData;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = (await res.json()) as NetdataData;
      if (!Array.isArray(body.labels) || !Array.isArray(body.data)) throw new Error("bad shape");
    } catch {
      this.mark(false);
      throw new NetdataUnavailableError("Netdata is not reachable");
    }
    this.mark(true);
    return normalize(name, chart, unit, body);
  }

  private mark(up: boolean) {
    if (this.available === up) return;
    if (up) this.events.add("info", "monitoring", "Netdata data source is reachable");
    else this.events.add("error", "monitoring", "Netdata data source is unreachable");
    this.available = up;
  }
}

function normalize(name: MetricName, chart: string, unit: string, body: NetdataData): MetricSeries {
  const dims = body.labels.slice(1);
  const rows = [...body.data].sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  const val = (row: (number | null)[], dim: string) => {
    const i = dims.indexOf(dim);
    return i >= 0 ? (row[i + 1] ?? null) : null;
  };

  if (name === "cpu") {
    // Netdata reports each CPU state separately; total utilisation is their sum.
    return {
      chart,
      unit,
      dimensions: ["usage"],
      points: rows.map((r) => ({
        t: r[0]! * 1000,
        values: { usage: round(r.slice(1).reduce<number>((s, v) => s + (v ?? 0), 0)) },
      })),
    };
  }

  // Netdata stores outbound directions as negative numbers; flip them for display.
  const pick: Record<Exclude<MetricName, "cpu">, string[]> = {
    memory: ["used", "cached", "free"],
    swap: ["used", "free"],
    network: ["received", "sent"],
    disk: ["in", "out"],
  };
  const keep = pick[name].filter((d) => dims.includes(d));
  return {
    chart,
    unit,
    dimensions: keep,
    points: rows.map((r) => ({
      t: r[0]! * 1000,
      values: Object.fromEntries(keep.map((d) => {
        const v = val(r, d);
        return [d, v === null ? null : round(Math.abs(v))];
      })),
    })),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
