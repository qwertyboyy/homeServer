// `null` always means "not available" — the UI renders it as N/A.

export interface SystemSummary {
  hostname: string;
  platform: string;
  uptimeSeconds: number;
  systemTime: string;
  timezone: string;
  cpu: {
    usagePercent: number | null;
    cores: number;
    model: string | null;
    loadAverage: [number, number, number] | null;
  };
  memory: {
    totalBytes: number | null;
    usedBytes: number | null;
    availableBytes: number | null;
    usedPercent: number | null;
  };
  swap: {
    totalBytes: number | null;
    usedBytes: number | null;
    usedPercent: number | null;
  };
  disk: DiskUsage;
  temperature: {
    packageCelsius: number | null;
    cores: { label: string; celsius: number }[];
  };
  network: {
    rxBytesPerSec: number | null;
    txBytesPerSec: number | null;
    interfaces: string[];
  };
}

export interface DiskUsage {
  path: string;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usedPercent: number | null;
}

export type ServiceState = "active" | "inactive" | "failed" | "unknown";

export interface ServiceStatus {
  name: string;
  label: string;
  description: string;
  state: ServiceState;
  subState: string | null;
  since: string | null;
  detail: string | null;
  checkedAt: string;
}

export interface MetricSeries {
  chart: string;
  unit: string;
  dimensions: string[];
  points: { t: number; values: Record<string, number | null> }[];
}
