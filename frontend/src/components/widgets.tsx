"use client";

import { ArrowUpRight, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { bytes, level, percent, relative } from "@/lib/format";
import type { ApplicationStatus, DiskUsage, ServiceStatus } from "@/lib/types";
import { Card, HealthBadge, ServiceBadge, Skeleton, UsageBar } from "./ui";

const LEVEL_TEXT = { ok: "Normal", warn: "Tinggi", bad: "Kritis", unknown: "N/A" } as const;
const LEVEL_TONE = { ok: "text-ok", warn: "text-warn", bad: "text-bad", unknown: "text-muted" } as const;

export function StatCard({
  icon: Icon,
  title,
  value,
  sub,
  usage,
  thresholds,
  delay,
  loading,
}: {
  icon: LucideIcon;
  title: string;
  value: string;
  sub?: ReactNode;
  usage?: number | null;
  thresholds?: [number, number];
  delay?: number;
  loading?: boolean;
}) {
  const lvl = usage !== undefined ? level(usage, ...(thresholds ?? [75, 90])) : null;
  return (
    <Card delay={delay} className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-medium text-ink-2">
          <Icon className="size-4 text-muted" aria-hidden />
          {title}
        </h2>
        {lvl && !loading && <span className={`text-xs font-medium ${LEVEL_TONE[lvl]}`}>{LEVEL_TEXT[lvl]}</span>}
      </div>
      {loading ? (
        <>
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-4 w-full" />
        </>
      ) : (
        <>
          <p className="font-mono text-3xl font-semibold tracking-tight">{value}</p>
          {usage !== undefined && lvl && <UsageBar value={usage} tone={lvl} label={`${title} terpakai`} />}
          {sub && <div className="text-xs text-muted">{sub}</div>}
        </>
      )}
    </Card>
  );
}

export function ServiceList({ services, compact }: { services: ServiceStatus[]; compact?: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {services.map((s) => (
        <li key={s.name} className="flex items-center justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{s.label}</p>
            <p className="truncate font-mono text-xs text-muted">
              {s.name}
              {!compact && s.subState ? ` · ${s.subState}` : ""}
              {!compact && s.state === "active" && s.since ? ` · sejak ${relative(s.since)}` : ""}
            </p>
            {s.detail && <p className="truncate text-xs text-warn">{s.detail}</p>}
          </div>
          <ServiceBadge state={s.state} />
        </li>
      ))}
    </ul>
  );
}

export function DiskSummary({ disk, label }: { disk: DiskUsage; label?: string }) {
  const lvl = level(disk.usedPercent, 80, 90);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm">
          {label} <span className="font-mono text-xs text-muted">{disk.path}</span>
        </p>
        <p className="font-mono text-sm">{percent(disk.usedPercent)}</p>
      </div>
      <UsageBar value={disk.usedPercent} tone={lvl} label={`${label ?? disk.path} terpakai`} />
      <p className="flex justify-between gap-2 font-mono text-xs text-muted">
        <span>
          {bytes(disk.usedBytes)} / {bytes(disk.totalBytes)}
        </span>
        <span>{bytes(disk.availableBytes)} tersedia</span>
      </p>
    </div>
  );
}

export function AppLink({ app }: { app: ApplicationStatus }) {
  return (
    <a
      href={app.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2/40 px-3 py-2.5 transition duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-card"
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{app.name}</span>
        <span className="block truncate font-mono text-xs text-muted">{app.hostname}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <HealthBadge health={app.health} />
        <ArrowUpRight className="size-4 text-muted transition group-hover:text-primary" aria-label="Buka di tab baru" />
      </span>
    </a>
  );
}
