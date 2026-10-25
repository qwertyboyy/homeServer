import fs from "node:fs/promises";
import { ApplicationMonitor, type ApplicationStatus } from "./apps/applications.js";
import type { AppDef, ServiceDef } from "./config/files.js";
import type { EventLog } from "./lib/events.js";
import { NetdataClient, type MetricName } from "./netdata/client.js";
import { ServiceMonitor } from "./system/services.js";
import { SystemCollector, diskUsage } from "./system/summary.js";
import type { DiskUsage, MetricSeries, ServiceStatus, SystemSummary } from "./system/types.js";

export interface StorageVolume extends DiskUsage {
  label: string;
  readable: boolean;
}

/** Everything the routes read from. Swappable for mock data and tests. */
export interface DataSources {
  mock: boolean;
  summary(): Promise<SystemSummary>;
  services(): Promise<ServiceStatus[]>;
  metric(name: MetricName, rangeSeconds: number, points: number): Promise<MetricSeries>;
  volumes(): Promise<StorageVolume[]>;
  applications(): Promise<ApplicationStatus[]>;
}

export function realSources(opts: {
  services: ServiceDef[];
  apps: AppDef[];
  netdataUrl: string;
  netdataTimeoutMs: number;
  sharedPath: string;
  events: EventLog;
}): DataSources {
  const system = new SystemCollector();
  const services = new ServiceMonitor(opts.services, opts.events);
  const netdata = new NetdataClient(opts.netdataUrl, opts.netdataTimeoutMs, opts.events);
  const apps = new ApplicationMonitor(opts.apps);

  return {
    mock: false,
    summary: () => system.summary(),
    services: () => services.status(),
    metric: (name, range, points) => netdata.series(name, range, points),
    applications: () => apps.list(),
    async volumes() {
      const root = { ...(await diskUsage("/")), label: "Root filesystem", readable: true };
      let readable = false;
      try {
        await fs.access(opts.sharedPath, fs.constants.R_OK);
        readable = true;
      } catch {
        /* missing or not permitted */
      }
      const shared = readable
        ? await diskUsage(opts.sharedPath)
        : { path: opts.sharedPath, totalBytes: null, usedBytes: null, availableBytes: null, usedPercent: null };
      return [root, { ...shared, label: "Shared folder", readable }];
    },
  };
}
