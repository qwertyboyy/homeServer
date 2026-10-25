"use client";

import { FolderLock, FolderOpen, HardDrive, Link2, Lock, Server } from "lucide-react";
import { Card, CardTitle, EmptyState, ErrorState, LoadingRows, PageHeader, UpdatedAt } from "@/components/ui";
import { AppLink, DiskSummary, ServiceList } from "@/components/widgets";
import type { StorageInfo } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";

export default function StoragePage() {
  const st = usePoll<StorageInfo>("/storage", 30_000);
  const d = st.data;

  return (
    <>
      <PageHeader title="Storage" description="Kapasitas disk dan status layanan berbagi file. Isi folder dan kredensial tidak ditampilkan.">
        <UpdatedAt at={st.updatedAt} error={st.error} />
      </PageHeader>

      {st.loading && !d ? (
        <Card>
          <LoadingRows rows={4} />
        </Card>
      ) : st.error && !d ? (
        <ErrorState message={st.error} onRetry={st.refresh} />
      ) : d ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col gap-4">
            {d.volumes.map((v, i) => (
              <Card key={v.path} delay={i * 100}>
                <CardTitle icon={v.path === "/" ? HardDrive : v.readable ? FolderOpen : FolderLock} title={v.label} />
                {v.readable ? (
                  <DiskSummary disk={v} />
                ) : (
                  <p className="flex items-center gap-2 text-sm text-muted">
                    <Lock className="size-4" aria-hidden />
                    <span className="font-mono">{v.path}</span> tidak dapat dibaca oleh service dashboard (N/A).
                  </p>
                )}
              </Card>
            ))}
          </div>
          <div className="flex flex-col gap-4">
            <Card delay={150}>
              <CardTitle icon={Server} title="Layanan file" />
              {d.fileServices.length > 0 ? (
                <ServiceList services={d.fileServices} />
              ) : (
                <p className="text-sm text-muted">apache2 / smbd tidak ada di allowlist.</p>
              )}
            </Card>
            <Card delay={250}>
              <CardTitle icon={Link2} title="Pintasan" />
              {d.shortcuts.length > 0 ? (
                <div className="space-y-2">
                  {d.shortcuts.map((a) => (
                    <AppLink key={a.id} app={a} />
                  ))}
                </div>
              ) : (
                <EmptyState icon={Link2} title="Belum ada pintasan">
                  Tambahkan aplikasi dengan <code className="font-mono">&quot;category&quot;: &quot;storage&quot;</code>.
                </EmptyState>
              )}
            </Card>
          </div>
        </div>
      ) : null}
    </>
  );
}
