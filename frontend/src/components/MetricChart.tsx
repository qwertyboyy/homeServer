"use client";

import { Table2, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { bytes } from "@/lib/format";
import type { MetricSeries } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";
import { ChartTable, LineChart, type Series } from "./LineChart";
import { Card, CardTitle, ErrorState, Skeleton, UpdatedAt, cx } from "./ui";

export type MetricName = "cpu" | "memory" | "swap" | "network" | "disk";
export type Range = "5m" | "15m" | "1h" | "6h";

const S1 = "var(--series-1)";
const S2 = "var(--series-2)";
const S3 = "var(--series-3)";

const kbit = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} Mbit/s` : `${v.toFixed(0)} kbit/s`);

export const METRICS: Record<MetricName, { title: string; series: Series[]; format: (v: number) => string; max?: number }> = {
  cpu: { title: "CPU", series: [{ key: "usage", label: "Utilisasi", color: S1 }], format: (v) => `${v.toFixed(0)}%`, max: 100 },
  memory: {
    title: "RAM",
    series: [
      { key: "used", label: "Terpakai", color: S1 },
      { key: "cached", label: "Cache", color: S2 },
      { key: "free", label: "Bebas", color: S3 },
    ],
    format: (v) => bytes(v * 1024 * 1024, 1),
  },
  swap: {
    title: "Swap",
    series: [
      { key: "used", label: "Terpakai", color: S1 },
      { key: "free", label: "Bebas", color: S2 },
    ],
    format: (v) => bytes(v * 1024 * 1024, 1),
  },
  network: {
    title: "Jaringan",
    series: [
      { key: "received", label: "Masuk", color: S1 },
      { key: "sent", label: "Keluar", color: S2 },
    ],
    format: kbit,
  },
  disk: {
    title: "Disk I/O",
    series: [
      { key: "in", label: "Baca", color: S1 },
      { key: "out", label: "Tulis", color: S2 },
    ],
    format: (v) => `${bytes(v * 1024, 1)}/s`,
  },
};

const POLL: Record<Range, number> = { "5m": 10_000, "15m": 20_000, "1h": 60_000, "6h": 120_000 };

export function MetricChart({
  metric,
  range,
  icon,
  delay,
  height,
}: {
  metric: MetricName;
  range: Range;
  icon?: LucideIcon;
  delay?: number;
  height?: number;
}) {
  const cfg = METRICS[metric];
  const { data, error, loading, updatedAt, refresh } = usePoll<MetricSeries>(`/metrics/${metric}?range=${range}`, POLL[range]);
  const [table, setTable] = useState(false);

  return (
    <Card delay={delay}>
      <CardTitle
        icon={icon}
        title={cfg.title}
        action={
          <button
            type="button"
            onClick={() => setTable((t) => !t)}
            aria-pressed={table}
            className={cx(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs transition hover:bg-surface-2",
              table ? "text-primary" : "text-muted",
            )}
          >
            <Table2 className="size-3.5" aria-hidden />
            Tabel
          </button>
        }
      />
      {loading && !data ? (
        <div style={{ height: height ?? 200 }}>
          <Skeleton className="h-full w-full" />
        </div>
      ) : error && !data ? (
        <ErrorState
          message={error === "Netdata is not available" ? "Sumber data Netdata tidak tersedia. Metrik lain tetap berjalan." : error}
          onRetry={refresh}
        />
      ) : data && data.points.length > 0 ? (
        table ? (
          <ChartTable points={data.points} series={cfg.series} format={cfg.format} />
        ) : (
          <LineChart
            points={data.points}
            series={cfg.series.filter((s) => data.dimensions.includes(s.key))}
            format={cfg.format}
            max={cfg.max}
            height={height}
            label={`Grafik ${cfg.title}, ${range} terakhir`}
          />
        )
      ) : (
        <p className="py-8 text-center text-sm text-muted">Belum ada data.</p>
      )}
      <div className="mt-2 flex justify-end">
        <UpdatedAt at={updatedAt} error={error} />
      </div>
    </Card>
  );
}

export function RangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  return (
    <div role="radiogroup" aria-label="Rentang waktu" className="inline-flex rounded-[0.75rem] border border-line bg-surface p-1">
      {(["5m", "15m", "1h", "6h"] as Range[]).map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={value === r}
          onClick={() => onChange(r)}
          className={cx(
            "rounded-lg px-3 py-1.5 font-mono text-xs transition",
            value === r ? "bg-primary text-white" : "text-ink-2 hover:bg-surface-2",
          )}
        >
          {r}
        </button>
      ))}
    </div>
  );
}
