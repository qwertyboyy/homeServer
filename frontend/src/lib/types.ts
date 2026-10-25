// Mirrors backend/src/system/types.ts. `null` = not available → shown as N/A.

export interface ApiEnvelope<T> {
  data: T | null;
  timestamp: string;
  error: string | null;
}

export interface DiskUsage {
  path: string;
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  usedPercent: number | null;
}

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
  swap: { totalBytes: number | null; usedBytes: number | null; usedPercent: number | null };
  disk: DiskUsage;
  temperature: { packageCelsius: number | null; cores: { label: string; celsius: number }[] };
  network: { rxBytesPerSec: number | null; txBytesPerSec: number | null; interfaces: string[] };
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

export type AppHealth = "up" | "down" | "unchecked";

export interface ApplicationStatus {
  id: string;
  name: string;
  url: string;
  hostname: string;
  description: string;
  category: "app" | "storage" | "monitoring";
  health: AppHealth;
  httpStatus: number | null;
  checkedAt: string | null;
}

export interface StorageVolume extends DiskUsage {
  label: string;
  readable: boolean;
}

export interface StorageInfo {
  volumes: StorageVolume[];
  fileServices: ServiceStatus[];
  shortcuts: ApplicationStatus[];
}

export interface AppEvent {
  id: number;
  time: string;
  level: "info" | "warning" | "error";
  category: "auth" | "service" | "monitoring" | "system" | "hosting";
  message: string;
}

// ---------- Hosting Manager (mirrors backend/src/hosting) ----------

export type RuntimeKind = "static" | "vite" | "nextjs" | "node" | "laravel" | "php";
export type HostedStatus = "running" | "starting" | "stopped" | "failed" | "deploying" | "not_deployed" | "unknown";

export interface RuntimeInfo {
  kind: RuntimeKind;
  label: string;
  static: boolean;
  buildSteps: string[];
  requires: string[];
}

export interface ReleaseRecord {
  id: string;
  createdAt: string;
  source: "upload" | "github";
  commit: string | null;
  sizeBytes: number | null;
  status: "ready" | "failed" | "removed";
}

export interface DeploymentRecord {
  id: string;
  kind: "deploy" | "rollback";
  method: "upload" | "github" | "rollback";
  releaseId: string;
  status: "running" | "succeeded" | "failed" | "rolled_back";
  startedAt: string;
  finishedAt: string | null;
  message: string;
}

export interface HostedApp {
  id: string;
  name: string;
  runtime: RuntimeKind;
  runtimeLabel: string;
  deployMethod: "upload" | "github";
  repo: { url: string; branch: string } | null;
  domains: string[];
  urls: string[];
  port: number | null;
  healthPath: string;
  options: { outputDir?: string; entry?: string; docroot?: string };
  desiredState: "running" | "stopped";
  status: HostedStatus;
  unit: { activeState: string; subState: string | null; since: string | null } | null;
  health: { status: AppHealth; httpStatus: number | null; checkedAt: string | null };
  activeRelease: ReleaseRecord | null;
  lastDeployment: DeploymentRecord | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostedAppDetail extends HostedApp {
  internalHost: string;
  buildSteps: string[];
  releases: ReleaseRecord[];
  deployments: DeploymentRecord[];
  env: { key: string; secret: boolean; value: string | null; set: boolean }[];
  database: { type: "none" | "sqlite" | "mysql" | "postgresql"; host: string | null; port: number | null; name: string | null; user: string | null; passwordSet: boolean };
  gitTokenSet: boolean;
}

export interface PrereqCheck {
  key: string;
  group: "core" | "runtime" | "database" | "network";
  label: string;
  status: "ok" | "missing" | "warning" | "unknown";
  detail: string | null;
  fix: string | null;
}

export interface Prerequisites {
  executor: "systemd" | "simulated";
  ready: boolean;
  checks: PrereqCheck[];
  binaries: Record<string, boolean>;
  checkedAt: string;
}

export interface DomainStatus {
  gatewayPort: number;
  internalHost: string;
  baseDomain: string | null;
  tunnelConfig: "ok" | "missing" | "unreadable";
  domains: {
    domain: string;
    dns: { status: "tunnel" | "resolves" | "missing" | "error"; detail: string | null };
    tunnel: "configured" | "missing" | "wrong-target" | "unreadable";
    tunnelService: string | null;
  }[];
  snippet: string | null;
  commands: string[];
}

export interface AuditEntry {
  time: string;
  actor: string;
  action: string;
  app: string | null;
  level: "info" | "warning" | "error";
  message: string;
}
