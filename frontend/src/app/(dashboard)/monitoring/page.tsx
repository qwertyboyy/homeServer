"use client";

import { Activity, ArrowLeftRight, Cpu, HardDrive, MemoryStick, Repeat, Thermometer } from "lucide-react";
import { useState } from "react";
import { MetricChart, RangePicker, type Range } from "@/components/MetricChart";
import { Card, CardTitle, KeyValue, PageHeader, Skeleton } from "@/components/ui";
import { celsius } from "@/lib/format";
import type { SystemSummary } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";

export default function MonitoringPage() {
  const [range, setRange] = useState<Range>("15m");
  const sys = usePoll<SystemSummary>("/system/summary", 10_000);

  const t = sys.data?.temperature;

  return (
    <>
      <PageHeader title="Monitoring" description="Grafik historis dari Netdata. Polling berhenti saat tab tidak aktif.">
        <RangePicker value={range} onChange={setRange} />
      </PageHeader>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <MetricChart metric="cpu" range={range} icon={Cpu} />
        <MetricChart metric="memory" range={range} icon={MemoryStick} delay={100} />
        <MetricChart metric="network" range={range} icon={ArrowLeftRight} delay={150} />
        <MetricChart metric="disk" range={range} icon={HardDrive} delay={200} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <MetricChart metric="swap" range={range} icon={Repeat} delay={250} />
        <Card delay={300}>
          <CardTitle icon={Thermometer} title="Suhu (saat ini)" />
          {sys.loading && !sys.data ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <>
              <p className="font-mono text-4xl font-semibold">{celsius(t?.packageCelsius)}</p>
              <p className="mb-3 text-xs text-muted">CPU package</p>
              <dl>
                {t && t.cores.length > 0 ? (
                  t.cores.map((c) => <KeyValue key={c.label} label={c.label} value={celsius(c.celsius)} />)
                ) : (
                  <KeyValue label="Per-core" value="N/A" />
                )}
              </dl>
              <p className="mt-3 flex items-center gap-1.5 text-xs text-muted">
                <Activity className="size-3.5" aria-hidden />
                Dibaca dari sensor hwmon tiap 10 detik.
              </p>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
