"use client";

import { Activity, AppWindow, ArrowRight, ArrowDown, ArrowUp, Cpu, HardDrive, MemoryStick, Server, Thermometer } from "lucide-react";
import Link from "next/link";
import { OnlinePill, useServerStatus } from "@/components/AppShell";
import { MetricChart } from "@/components/MetricChart";
import { Card, CardTitle, EmptyState, ErrorState, LoadingRows, PageHeader, UpdatedAt } from "@/components/ui";
import { AppLink, DiskSummary, ServiceList, StatCard } from "@/components/widgets";
import { bytes, celsius, clock, duration, num, percent, rate } from "@/lib/format";
import type { ApplicationStatus, ServiceStatus, SystemSummary } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";

export default function OverviewPage() {
  const { online } = useServerStatus();
  const sys = usePoll<SystemSummary>("/system/summary", 5_000);
  const svc = usePoll<ServiceStatus[]>("/services", 10_000);
  const apps = usePoll<ApplicationStatus[]>("/applications", 60_000);
  const s = sys.data;
  const loading = sys.loading && !s;

  const activeCount = svc.data?.filter((x) => x.state === "active").length ?? 0;

  return (
    <>
      <PageHeader
        title="Overview"
        description={
          s
            ? `${s.hostname} · aktif ${duration(s.uptimeSeconds)} · waktu sistem ${clock(s.systemTime)} (${s.timezone})`
            : "Ringkasan kesehatan server"
        }
      >
        <OnlinePill online={online} />
        <UpdatedAt at={sys.updatedAt} error={sys.error} />
      </PageHeader>

      {sys.error && !s && (
        <div className="mb-4">
          <ErrorState message={sys.error} onRetry={sys.refresh} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Cpu}
          title="CPU"
          loading={loading}
          value={percent(s?.cpu.usagePercent)}
          usage={s?.cpu.usagePercent ?? null}
          sub={
            <>
              Load <span className="font-mono">{s?.cpu.loadAverage ? s.cpu.loadAverage.map((n) => num(n)).join(" · ") : "N/A"}</span>
              {" "}· {s?.cpu.cores ?? "N/A"} core
            </>
          }
        />
        <StatCard
          icon={MemoryStick}
          title="RAM"
          delay={100}
          loading={loading}
          value={percent(s?.memory.usedPercent)}
          usage={s?.memory.usedPercent ?? null}
          sub={
            <span className="font-mono">
              {bytes(s?.memory.usedBytes)} / {bytes(s?.memory.totalBytes)} · swap {bytes(s?.swap.usedBytes)} /{" "}
              {bytes(s?.swap.totalBytes)}
            </span>
          }
        />
        <StatCard
          icon={Thermometer}
          title="Suhu CPU"
          delay={200}
          loading={loading}
          value={celsius(s?.temperature.packageCelsius)}
          usage={s?.temperature.packageCelsius ?? null}
          thresholds={[70, 85]}
          sub={
            s && s.temperature.cores.length > 0 ? (
              <span className="font-mono">{s.temperature.cores.map((c) => `${c.label.replace("Core ", "C")} ${celsius(c.celsius)}`).join(" · ")}</span>
            ) : (
              "Sensor per-core tidak tersedia"
            )
          }
        />
        <StatCard
          icon={HardDrive}
          title="Storage /"
          delay={300}
          loading={loading}
          value={percent(s?.disk.usedPercent)}
          usage={s?.disk.usedPercent ?? null}
          thresholds={[80, 90]}
          sub={
            <span className="font-mono">
              {bytes(s?.disk.usedBytes)} / {bytes(s?.disk.totalBytes)} · {bytes(s?.disk.availableBytes)} bebas
            </span>
          }
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MetricChart metric="cpu" range="15m" icon={Cpu} delay={150} height={180} />
        <MetricChart metric="memory" range="15m" icon={MemoryStick} delay={250} height={180} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card delay={200}>
          <CardTitle
            icon={Server}
            title={svc.data ? `Services · ${activeCount}/${svc.data.length} aktif` : "Services"}
            action={
              <Link href="/services" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                Detail <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            }
          />
          {svc.loading && !svc.data ? (
            <LoadingRows rows={5} />
          ) : svc.error && !svc.data ? (
            <ErrorState message={svc.error} onRetry={svc.refresh} />
          ) : (
            <ServiceList services={svc.data ?? []} compact />
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card delay={300}>
            <CardTitle icon={Activity} title="Jaringan" />
            <dl className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-surface-2/50 p-3">
                <dt className="flex items-center gap-1 text-xs text-muted">
                  <ArrowDown className="size-3.5" aria-hidden /> Masuk
                </dt>
                <dd className="mt-1 font-mono text-lg">{rate(s?.network.rxBytesPerSec)}</dd>
              </div>
              <div className="rounded-lg bg-surface-2/50 p-3">
                <dt className="flex items-center gap-1 text-xs text-muted">
                  <ArrowUp className="size-3.5" aria-hidden /> Keluar
                </dt>
                <dd className="mt-1 font-mono text-lg">{rate(s?.network.txBytesPerSec)}</dd>
              </div>
            </dl>
            {s && <div className="mt-4"><DiskSummary disk={s.disk} label="Root" /></div>}
          </Card>

          <Card delay={400}>
            <CardTitle
              icon={AppWindow}
              title="Shortcut"
              action={
                <Link href="/applications" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                  Semua <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              }
            />
            {apps.loading && !apps.data ? (
              <LoadingRows rows={2} />
            ) : apps.error && !apps.data ? (
              <ErrorState message={apps.error} onRetry={apps.refresh} />
            ) : apps.data && apps.data.length > 0 ? (
              <div className="space-y-2">
                {apps.data.slice(0, 4).map((a) => (
                  <AppLink key={a.id} app={a} />
                ))}
              </div>
            ) : (
              <EmptyState icon={AppWindow} title="Belum ada aplikasi">
                Tambahkan di <code className="font-mono">config/applications.json</code>.
              </EmptyState>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-6 flex justify-center">
        <Link
          href="/monitoring"
          className="inline-flex items-center gap-2 rounded-[0.75rem] border-[1.5px] border-line-strong px-4 py-2.5 text-sm font-semibold text-primary transition hover:bg-surface-2"
        >
          <Activity className="size-4" aria-hidden />
          Lihat monitoring detail
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </>
  );
}
