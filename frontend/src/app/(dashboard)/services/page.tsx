"use client";

import { Info, Server } from "lucide-react";
import { Card, ErrorState, LoadingRows, PageHeader, ServiceBadge, UpdatedAt } from "@/components/ui";
import { dateTime, relative } from "@/lib/format";
import type { ServiceState, ServiceStatus } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";

const ORDER: ServiceState[] = ["failed", "inactive", "unknown", "active"];

export default function ServicesPage() {
  const svc = usePoll<ServiceStatus[]>("/services", 10_000);
  const list = svc.data ? [...svc.data].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state)) : [];
  const counts = ORDER.map((s) => [s, list.filter((x) => x.state === s).length] as const).filter(([, n]) => n > 0);

  return (
    <>
      <PageHeader title="Services" description="Status systemd untuk service yang ada di allowlist. Halaman ini hanya membaca, tidak mengubah service.">
        <UpdatedAt at={svc.updatedAt} error={svc.error} />
      </PageHeader>

      {svc.loading && !svc.data ? (
        <Card>
          <LoadingRows rows={5} />
        </Card>
      ) : svc.error && !svc.data ? (
        <ErrorState message={svc.error} onRetry={svc.refresh} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-2">
            {counts.map(([state, n]) => (
              <span key={state} className="inline-flex items-center gap-2 text-sm text-ink-2">
                <ServiceBadge state={state} /> <span className="font-mono">{n}</span>
              </span>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {list.map((s, i) => (
              <Card key={s.name} delay={i * 100} className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-2">
                      <Server className="size-5 text-muted" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <h2 className="truncate font-medium">{s.label}</h2>
                      <p className="truncate font-mono text-xs text-muted">{s.name}.service</p>
                    </div>
                  </div>
                  <ServiceBadge state={s.state} />
                </div>
                {s.description && <p className="text-sm text-ink-2">{s.description}</p>}
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <dt className="text-muted">Sub-state</dt>
                    <dd className="font-mono">{s.subState ?? "N/A"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Aktif sejak</dt>
                    <dd className="font-mono">{s.state === "active" ? dateTime(s.since) : "N/A"}</dd>
                  </div>
                  <div className="col-span-2">
                    <dt className="text-muted">Diperiksa</dt>
                    <dd className="font-mono">{relative(s.checkedAt)}</dd>
                  </div>
                </dl>
                {s.detail && (
                  <p className="flex items-start gap-1.5 rounded-lg bg-warn/10 px-3 py-2 text-xs text-ink">
                    <Info className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />
                    {s.detail}
                  </p>
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
