"use client";

import { AppWindow, ExternalLink, Globe } from "lucide-react";
import { Card, EmptyState, ErrorState, HealthBadge, LoadingRows, PageHeader, UpdatedAt } from "@/components/ui";
import { relative } from "@/lib/format";
import type { ApplicationStatus } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";

const CATEGORY = { app: "Aplikasi", storage: "Storage", monitoring: "Monitoring" } as const;

export default function ApplicationsPage() {
  const apps = usePoll<ApplicationStatus[]>("/applications", 60_000);

  return (
    <>
      <PageHeader
        title="Applications"
        description="Aplikasi dan website dari config/applications.json. Health check hanya untuk URL yang diizinkan."
      >
        <UpdatedAt at={apps.updatedAt} error={apps.error} />
      </PageHeader>

      {apps.loading && !apps.data ? (
        <Card>
          <LoadingRows rows={3} />
        </Card>
      ) : apps.error && !apps.data ? (
        <ErrorState message={apps.error} onRetry={apps.refresh} />
      ) : apps.data && apps.data.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {apps.data.map((a, i) => (
            <Card key={a.id} delay={i * 100} className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-2">
                    <Globe className="size-5 text-muted" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <h2 className="truncate font-medium">{a.name}</h2>
                    <p className="truncate font-mono text-xs text-muted">{a.hostname}</p>
                  </div>
                </div>
                <HealthBadge health={a.health} />
              </div>
              {a.description && <p className="text-sm text-ink-2">{a.description}</p>}
              <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
                <p className="text-xs text-muted">
                  {CATEGORY[a.category]}
                  {a.checkedAt && (
                    <>
                      {" "}· dicek {relative(a.checkedAt)}
                      {a.httpStatus !== null && <span className="font-mono"> · HTTP {a.httpStatus}</span>}
                    </>
                  )}
                </p>
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-[0.75rem] bg-primary px-3 py-2 text-xs font-semibold text-white transition hover:bg-primary-hover active:translate-y-px"
                >
                  Buka <ExternalLink className="size-3.5" aria-hidden />
                </a>
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState icon={AppWindow} title="Belum ada aplikasi">
            Salin <code className="font-mono">config/applications.example.json</code> menjadi{" "}
            <code className="font-mono">applications.json</code>, lalu restart backend.
          </EmptyState>
        </Card>
      )}
    </>
  );
}
