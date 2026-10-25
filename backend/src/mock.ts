import type { ApplicationStatus } from "./apps/applications.js";
import type { AppDef, ServiceDef } from "./config/files.js";
import { METRIC_CHARTS, type MetricName } from "./netdata/client.js";
import type { DataSources } from "./sources.js";
import type { ServiceStatus, SystemSummary } from "./system/types.js";

const GiB = 1024 ** 3;
const bootAt = Date.now() - 3 * 86400_000 - 5 * 3600_000;

/** Smooth pseudo-random value in [min, max] that drifts over time. */
function wave(t: number, min: number, max: number, seed: number) {
  const x = Math.sin(t / 47_000 + seed) * 0.6 + Math.sin(t / 13_000 + seed * 3) * 0.3 + Math.sin(t / 5_000 + seed * 7) * 0.1;
  return min + ((x + 1) / 2) * (max - min);
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Sample data for developing the UI away from the Ubuntu host. Every response
 * from this source is flagged `mock: true` via /health so the UI can label it.
 */
export function mockSources(services: ServiceDef[], apps: AppDef[]): DataSources {
  return {
    mock: true,
    async summary(): Promise<SystemSummary> {
      const t = Date.now();
      const memTotal = 3.7 * GiB;
      const memUsed = wave(t, 1.4, 2.3, 1) * GiB;
      const swapTotal = 2 * GiB;
      const swapUsed = wave(t, 0.1, 0.35, 2) * GiB;
      const diskTotal = 457 * GiB;
      const diskUsed = 182.4 * GiB;
      const cpu = wave(t, 4, 38, 3);
      return {
        hostname: "nifserver",
        platform: "Linux 6.8.0-generic (mock)",
        uptimeSeconds: Math.round((t - bootAt) / 1000),
        systemTime: new Date(t).toISOString(),
        timezone: "Asia/Jakarta",
        cpu: {
          usagePercent: r1(cpu),
          cores: 4,
          model: "Intel(R) Core(TM) i3 (mock)",
          loadAverage: [r1(cpu / 25), r1(cpu / 28), r1(cpu / 30)],
        },
        memory: {
          totalBytes: memTotal,
          usedBytes: memUsed,
          availableBytes: memTotal - memUsed,
          usedPercent: r1((memUsed / memTotal) * 100),
        },
        swap: { totalBytes: swapTotal, usedBytes: swapUsed, usedPercent: r1((swapUsed / swapTotal) * 100) },
        disk: {
          path: "/",
          totalBytes: diskTotal,
          usedBytes: diskUsed,
          availableBytes: diskTotal - diskUsed,
          usedPercent: r1((diskUsed / diskTotal) * 100),
        },
        temperature: {
          packageCelsius: r1(wave(t, 44, 61, 4)),
          cores: [0, 1].map((i) => ({ label: `Core ${i}`, celsius: r1(wave(t, 42, 58, 5 + i)) })),
        },
        network: {
          rxBytesPerSec: Math.round(wave(t, 2_000, 480_000, 6)),
          txBytesPerSec: Math.round(wave(t, 1_000, 120_000, 7)),
          interfaces: ["enp2s0"],
        },
      };
    },

    async services(): Promise<ServiceStatus[]> {
      const checkedAt = new Date().toISOString();
      return services.map((s) => ({
        name: s.name,
        label: s.label,
        description: s.description,
        state: "active",
        subState: "running",
        since: new Date(bootAt + 30_000).toISOString(),
        detail: null,
        checkedAt,
      }));
    },

    async metric(name: MetricName, rangeSeconds: number, points: number) {
      const { chart, unit } = METRIC_CHARTS[name];
      const now = Date.now();
      const step = (rangeSeconds * 1000) / points;
      const gen: Record<MetricName, [string, number, number][]> = {
        cpu: [["usage", 4, 38]],
        memory: [["used", 1400, 2300], ["cached", 700, 1100], ["free", 300, 700]],
        swap: [["used", 100, 350], ["free", 1700, 1950]],
        network: [["received", 20, 3800], ["sent", 10, 950]],
        disk: [["in", 0, 900], ["out", 0, 2200]],
      };
      return {
        chart,
        unit,
        dimensions: gen[name].map(([d]) => d),
        points: Array.from({ length: points }, (_, i) => {
          const t = now - (points - 1 - i) * step;
          return {
            t,
            values: Object.fromEntries(gen[name].map(([d, min, max], k) => [d, r1(wave(t, min, max, k + 3))])),
          };
        }),
      };
    },

    async volumes() {
      const s = await this.summary();
      return [
        { ...s.disk, label: "Root filesystem", readable: true },
        { ...s.disk, path: "/srv/shared", label: "Shared folder", readable: true },
      ];
    },

    async applications(): Promise<ApplicationStatus[]> {
      return apps.map((a) => ({
        id: a.id,
        name: a.name,
        url: a.url,
        hostname: new URL(a.url).host,
        description: a.description,
        category: a.category,
        health: a.healthCheck ? "up" : "unchecked",
        httpStatus: a.healthCheck ? 200 : null,
        checkedAt: a.healthCheck ? new Date().toISOString() : null,
      }));
    },
  };
}
