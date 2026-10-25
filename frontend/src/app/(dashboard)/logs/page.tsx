"use client";

import { AlertTriangle, CircleAlert, Info, ScrollText, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Card, EmptyState, ErrorState, LoadingRows, PageHeader, UpdatedAt, cx } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { AppEvent } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";

const LEVEL: Record<AppEvent["level"], { icon: LucideIcon; label: string; tone: string }> = {
  info: { icon: Info, label: "Info", tone: "text-primary" },
  warning: { icon: AlertTriangle, label: "Peringatan", tone: "text-warn" },
  error: { icon: CircleAlert, label: "Error", tone: "text-bad" },
};

const FILTERS = [
  { key: "all", label: "Semua" },
  { key: "auth", label: "Auth" },
  { key: "service", label: "Service" },
  { key: "monitoring", label: "Monitoring" },
  { key: "system", label: "Sistem" },
  { key: "hosting", label: "Hosting" },
] as const;

export default function LogsPage() {
  const ev = usePoll<AppEvent[]>("/events?limit=200", 15_000);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const list = (ev.data ?? []).filter((e) => filter === "all" || e.category === filter);

  return (
    <>
      <PageHeader
        title="Logs"
        description="Ringkasan event aplikasi yang sudah disaring. Detail log lengkap tetap lewat journalctl di server."
      >
        <UpdatedAt at={ev.updatedAt} error={ev.error} />
      </PageHeader>

      <div role="tablist" aria-label="Filter kategori" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => setFilter(f.key)}
            className={cx(
              "rounded-full border px-3 py-1 text-xs font-medium transition",
              filter === f.key ? "border-primary bg-primary/15 text-ink" : "border-line text-ink-2 hover:bg-surface-2",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Card>
        {ev.loading && !ev.data ? (
          <LoadingRows rows={6} />
        ) : ev.error && !ev.data ? (
          <ErrorState message={ev.error} onRetry={ev.refresh} />
        ) : list.length === 0 ? (
          <EmptyState icon={ScrollText} title="Belum ada event">
            Event login, perubahan status service, dan ketersediaan Netdata akan muncul di sini.
          </EmptyState>
        ) : (
          <ol className="divide-y divide-line">
            {list.map((e) => {
              const L = LEVEL[e.level];
              return (
                <li key={e.id} className="flex items-start gap-3 py-2.5">
                  <L.icon className={cx("mt-0.5 size-4 shrink-0", L.tone)} aria-label={L.label} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{e.message}</p>
                    <p className="font-mono text-xs text-muted">
                      {dateTime(e.time)} · {e.category}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">Event disimpan di memori (maks. 200) dan direset saat backend restart.</p>
    </>
  );
}
