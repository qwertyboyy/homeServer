"use client";

import {
  ChevronLeft,
  Database,
  ExternalLink,
  GitBranch,
  Globe,
  History,
  KeyRound,
  Lock,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Square,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog, CopyBlock, DeployBadge, Field, InlineError, StatusBadge, inputCls, useMutation } from "@/components/hosting";
import { Button, Card, CardTitle, EmptyState, ErrorState, HealthBadge, KeyValue, LoadingRows, PageHeader, UpdatedAt, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { hasIndexHtml, pick, uploadSite, type PickedFile, type Progress } from "@/lib/siteUpload";
import { bytes, dateTime, relative } from "@/lib/format";
import type { DomainStatus, DomainSyncResult, HostedAppDetail } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";

const TABS = [
  { key: "overview", label: "Ringkasan", icon: Play },
  { key: "deployments", label: "Deployment", icon: History },
  { key: "domains", label: "Domain", icon: Globe },
  { key: "env", label: "Environment", icon: KeyRound },
  { key: "database", label: "Database", icon: Database },
  { key: "settings", label: "Pengaturan", icon: Settings2 },
] as const;
type TabKey = (typeof TABS)[number]["key"];

type Props = { app: HostedAppDetail; refresh: () => void };

export function AppDetail() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<TabKey>("overview");
  const [fast, setFast] = useState(false);
  const detail = usePoll<HostedAppDetail>(`/hosting/apps/${encodeURIComponent(id)}`, fast ? 2_500 : 15_000);
  const app = detail.data;
  const active = app?.status === "deploying" || app?.deployments[0]?.status === "running";
  // Poll quickly only while a deployment is in progress.
  if (!!active !== fast) setFast(!!active);

  if (detail.loading && !app) {
    return (
      <Card>
        <LoadingRows rows={5} />
      </Card>
    );
  }
  if (!app) return <ErrorState message={detail.error ?? "Aplikasi tidak ditemukan"} onRetry={detail.refresh} />;

  return (
    <>
      <Link href="/hosting" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ChevronLeft className="size-4" aria-hidden /> Hosting
      </Link>
      <PageHeader title={app.name} description={`${app.runtimeLabel} · ${app.id}${app.port ? ` · 127.0.0.1:${app.port}` : " · disajikan gateway"}`}>
        <StatusBadge status={app.status} />
        <HealthBadge health={app.health.status} />
        <UpdatedAt at={detail.updatedAt} error={detail.error} />
      </PageHeader>

      <div role="tablist" aria-label="Bagian aplikasi" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cx(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition",
              tab === key ? "border-primary font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === "overview" && <Overview app={app} refresh={detail.refresh} />}
        {tab === "deployments" && <Deployments app={app} refresh={detail.refresh} />}
        {tab === "domains" && <Domains app={app} refresh={detail.refresh} />}
        {tab === "env" && <Environment app={app} refresh={detail.refresh} />}
        {tab === "database" && <DatabaseTab app={app} refresh={detail.refresh} />}
        {tab === "settings" && <SettingsTab app={app} refresh={detail.refresh} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- overview

function Overview({ app, refresh }: Props) {
  const deploy = useMutation();
  const action = useMutation();
  const [pending, setPending] = useState<"start" | "stop" | "restart" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<"files" | "folder" | "zip">("zip");
  const [picked, setPicked] = useState<{ files: PickedFile[]; ignored: number }>({ files: [], ignored: 0 });
  const [progress, setProgress] = useState<Progress | null>(null);
  const isStatic = app.runtime === "static" || app.runtime === "vite";
  const looseFiles = app.runtime === "static"; // file/folder upload is for Website statis only
  const activeMode = looseFiles ? mode : "zip";
  const busy = app.status === "deploying";
  const missingIndex = activeMode !== "zip" && picked.files.length > 0 && !hasIndexHtml(picked.files);
  const pickedBytes = picked.files.reduce((n, f) => n + f.file.size, 0);

  function reset() {
    setFile(null);
    setPicked({ files: [], ignored: 0 });
    setProgress(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  function chooseMode(next: "files" | "folder" | "zip") {
    setMode(next);
    reset();
    deploy.setError(null);
  }

  async function uploadZip(e: FormEvent) {
    e.preventDefault();
    if (activeMode === "zip" ? !file : !picked.files.length || missingIndex) return;
    const ok = await deploy.run(async () => {
      if (activeMode === "zip") {
        return api(`/hosting/apps/${app.id}/deploy/upload`, { method: "POST", body: file, headers: { "Content-Type": "application/zip" } });
      }
      try {
        return await uploadSite(app.id, picked.files, setProgress);
      } finally {
        setProgress(null);
      }
    });
    if (ok) {
      reset();
      refresh();
    }
  }

  async function runAction(kind: "start" | "stop" | "restart") {
    const ok = await action.run(() => api(`/hosting/apps/${app.id}/actions`, { method: "POST", json: { action: kind, confirm: app.id } }));
    if (ok) {
      setPending(null);
      refresh();
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardTitle icon={Upload} title="Deploy" />
          {busy && <p className="mb-3 rounded-lg bg-primary/10 px-3 py-2 text-sm">Deployment sedang berjalan… lihat tab Deployment untuk log.</p>}
          <form onSubmit={uploadZip} className="space-y-3">
            {looseFiles && (
              <div role="radiogroup" aria-label="Jenis upload" className="flex flex-wrap gap-2">
                {(
                  [
                    ["files", "File"],
                    ["folder", "Folder"],
                    ["zip", "ZIP"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={mode === key}
                    disabled={deploy.busy}
                    onClick={() => chooseMode(key)}
                    className={cx(
                      "rounded-lg border px-3 py-1.5 text-sm",
                      mode === key ? "border-primary bg-primary/10 text-ink" : "border-line text-ink-2 hover:bg-surface",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <Field
              label={activeMode === "zip" ? "Upload ZIP" : activeMode === "folder" ? "Pilih folder website" : "Pilih file website"}
              htmlFor="site-upload"
              hint={
                activeMode === "zip"
                  ? "Isi proyek (boleh dalam satu folder). .git, node_modules, dan .env dilewati otomatis."
                  : activeMode === "folder"
                    ? "Seluruh isi folder diunggah dengan struktur aslinya. Document root (root, dist, build, atau subfolder) dideteksi otomatis."
                    : "Satu index.html saja, atau beberapa file (HTML, CSS, JS, gambar, font)."
              }
            >
              <input
                key={activeMode}
                ref={fileRef}
                id="site-upload"
                type="file"
                {...(activeMode === "zip" ? { accept: ".zip,application/zip" } : {})}
                {...(activeMode === "files" ? { multiple: true } : {})}
                {...(activeMode === "folder" ? ({ webkitdirectory: "", multiple: true } as object) : {})}
                onChange={(e) => {
                  deploy.setError(null);
                  if (activeMode === "zip") setFile(e.target.files?.[0] ?? null);
                  else setPicked(pick(e.target.files));
                }}
                className={cx(inputCls, "file:mr-3 file:rounded-md file:border-0 file:bg-surface file:px-3 file:py-1 file:text-sm file:text-ink")}
              />
            </Field>
            {activeMode !== "zip" && picked.files.length > 0 && (
              <div className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-2">
                <p>
                  {picked.files.length} file · {bytes(pickedBytes)}
                  {picked.ignored > 0 && ` · ${picked.ignored} dilewati (.git, node_modules, .env)`}
                </p>
                <ul className="mt-1 max-h-24 overflow-auto font-mono">
                  {picked.files.slice(0, 50).map((f) => (
                    <li key={f.path} className="truncate">
                      {f.path}
                    </li>
                  ))}
                  {picked.files.length > 50 && <li>… dan {picked.files.length - 50} lainnya</li>}
                </ul>
              </div>
            )}
            {missingIndex && (
              <p role="alert" className="flex items-start gap-1.5 text-sm text-bad">
                index.html tidak ditemukan di pilihan Anda. Sertakan index.html (di root, dist, build, atau satu subfolder proyek).
              </p>
            )}
            {progress && (
              <div>
                <div
                  role="progressbar"
                  aria-label="Progres upload"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round((progress.bytes / Math.max(progress.totalBytes, 1)) * 100)}
                  className="h-2 overflow-hidden rounded-full bg-surface"
                >
                  <div className="h-full bg-primary transition-[width]" style={{ width: `${(progress.bytes / Math.max(progress.totalBytes, 1)) * 100}%` }} />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {progress.files}/{progress.totalFiles} file · {bytes(progress.bytes)} / {bytes(progress.totalBytes)}
                </p>
              </div>
            )}
            <Button
              type="submit"
              icon={Upload}
              disabled={(activeMode === "zip" ? !file : !picked.files.length || missingIndex) || deploy.busy || busy}
              aria-describedby="zip-why"
            >
              {deploy.busy
                ? progress && progress.files < progress.totalFiles
                  ? "Mengunggah…"
                  : "Memvalidasi…"
                : activeMode === "zip"
                  ? file
                    ? `Deploy ${file.name} (${bytes(file.size)})`
                    : "Deploy ZIP"
                  : picked.files.length
                    ? `Deploy ${picked.files.length} file (${bytes(pickedBytes)})`
                    : activeMode === "folder"
                      ? "Deploy folder"
                      : "Deploy file"}
            </Button>
            <p id="zip-why" className="text-xs text-muted">
              {deploy.busy
                ? "Sedang mengunggah dan memvalidasi…"
                : busy
                  ? "Tombol nonaktif: masih ada deployment yang berjalan untuk aplikasi ini."
                  : activeMode === "zip"
                    ? !file
                      ? "Tombol aktif setelah Anda memilih file .zip di atas."
                      : file.name.toLowerCase().endsWith(".zip")
                        ? "Siap di-deploy."
                        : "File ini bukan .zip; server akan menolaknya."
                    : !picked.files.length
                      ? "Tombol aktif setelah Anda memilih file atau folder di atas."
                      : missingIndex
                        ? "Tombol nonaktif: index.html tidak ditemukan."
                        : "Siap di-deploy. Rilis aktif baru diganti setelah validasi berhasil."}
            </p>
          </form>
          {app.repo && (
            <div className="mt-4 border-t border-line pt-4">
              <p className="mb-2 text-sm text-ink-2">
                <GitBranch className="mr-1 inline size-4 text-muted" aria-hidden />
                <span className="font-mono text-xs">{app.repo.url.replace(/^https:\/\//, "")}</span> · branch <span className="font-mono text-xs">{app.repo.branch}</span>
              </p>
              <Button
                variant="ghost"
                icon={GitBranch}
                disabled={deploy.busy || busy}
                onClick={async () => {
                  if (await deploy.run(() => api(`/hosting/apps/${app.id}/deploy/github`, { method: "POST", json: {} }))) refresh();
                }}
              >
                Deploy dari GitHub
              </Button>
            </div>
          )}
          <div className="mt-3">
            <InlineError message={deploy.error} />
          </div>
        </Card>

        <Card>
          <CardTitle icon={Play} title={isStatic ? "Publikasi" : "Service"} />
          <p className="mb-3 text-sm text-ink-2">
            {isStatic
              ? "Situs statis disajikan gateway. Stop = berhenti dipublikasikan (file tetap ada)."
              : `Unit systemd nifapp@${app.id}.service${app.unit ? ` — ${app.unit.activeState}${app.unit.subState ? ` (${app.unit.subState})` : ""}` : ""}.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" icon={Play} disabled={!app.activeRelease || busy} onClick={() => setPending("start")}>
              Start
            </Button>
            <Button variant="ghost" icon={RotateCcw} disabled={!app.activeRelease || busy} onClick={() => setPending("restart")}>
              Restart
            </Button>
            <Button variant="ghost" icon={Square} disabled={!app.activeRelease || busy} onClick={() => setPending("stop")}>
              Stop
            </Button>
          </div>
          <ConfirmDialog
            open={pending !== null}
            title={pending === "stop" ? `Hentikan ${app.name}?` : pending === "restart" ? `Restart ${app.name}?` : `Jalankan ${app.name}?`}
            confirmLabel={pending === "stop" ? "Stop" : pending === "restart" ? "Restart" : "Start"}
            danger={pending === "stop"}
            typeToConfirm={pending === "stop" ? app.id : undefined}
            busy={action.busy}
            error={action.error}
            onConfirm={() => pending && void runAction(pending)}
            onClose={() => {
              setPending(null);
              action.setError(null);
            }}
          >
            {pending === "stop" ? <p>Website tidak akan bisa diakses sampai dijalankan lagi.</p> : <p>Aplikasi akan tidak tersedia beberapa detik.</p>}
          </ConfirmDialog>
        </Card>
      </div>

      <Card>
        <CardTitle icon={Settings2} title="Detail" />
        <dl>
          <KeyValue label="Runtime" value={app.runtimeLabel} mono={false} />
          <KeyValue label="Rilis aktif" value={app.activeRelease?.id ?? "—"} />
          <KeyValue label="Commit" value={app.activeRelease?.commit?.slice(0, 10) ?? "—"} />
          <KeyValue label="Deploy terakhir" value={app.lastDeployment ? relative(app.lastDeployment.startedAt) : "—"} mono={false} />
          <KeyValue label="Health" value={`${app.healthPath}${app.health.httpStatus ? ` → HTTP ${app.health.httpStatus}` : ""}`} />
          <KeyValue label="Host internal" value={app.internalHost} />
          {app.port && <KeyValue label="Port" value={`127.0.0.1:${app.port}`} />}
          <KeyValue label="Diperbarui" value={dateTime(app.updatedAt)} mono={false} />
        </dl>
        {app.buildSteps.length > 0 && (
          <p className="mt-3 text-xs text-muted">
            Build (allowlist): <span className="font-mono">{app.buildSteps.join(" → ")}</span>
          </p>
        )}
        {app.urls.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {app.urls.map((u) => (
              <a key={u} href={u} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-[0.75rem] bg-primary px-3 py-2 text-xs font-semibold text-white transition hover:bg-primary-hover">
                {u.replace(/^https:\/\//, "")} <ExternalLink className="size-3.5" aria-hidden />
              </a>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- deployments

function Deployments({ app, refresh }: Props) {
  const [selected, setSelected] = useState<string | null>(app.deployments[0]?.id ?? null);
  const running = app.deployments.find((d) => d.id === selected)?.status === "running";
  const log = usePoll<{ log: string }>(selected ? `/hosting/apps/${app.id}/deployments/${selected}/log` : null, running ? 2_500 : 3_600_000);
  const rb = useMutation();
  const [target, setTarget] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log.data]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.3fr]">
      <div className="flex flex-col gap-4">
        <Card>
          <CardTitle icon={History} title="Riwayat deployment" />
          {app.deployments.length === 0 ? (
            <EmptyState icon={History} title="Belum ada deployment" />
          ) : (
            <ul className="divide-y divide-line">
              {app.deployments.map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(d.id)}
                    aria-pressed={selected === d.id}
                    className={cx("flex w-full items-start justify-between gap-3 rounded-md px-2 py-2.5 text-left transition hover:bg-surface-2/60", selected === d.id && "bg-primary/10")}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{d.message}</span>
                      <span className="block truncate font-mono text-xs text-muted">
                        {d.kind === "rollback" ? "rollback" : d.method} · {dateTime(d.startedAt)} · {d.releaseId}
                      </span>
                    </span>
                    <DeployBadge status={d.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle icon={RotateCcw} title="Rilis & rollback" />
          <ul className="divide-y divide-line">
            {app.releases.filter((r) => r.status === "ready").map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{r.id}</p>
                  <p className="text-xs text-muted">
                    {r.source === "github" ? `GitHub ${r.commit?.slice(0, 7) ?? ""}` : "ZIP"} · {bytes(r.sizeBytes)} · {relative(r.createdAt)}
                  </p>
                </div>
                {r.id === app.activeRelease?.id ? (
                  <span className="text-xs font-medium text-ok">Aktif</span>
                ) : (
                  <Button variant="ghost" icon={RotateCcw} onClick={() => setTarget(r.id)} disabled={app.status === "deploying"}>
                    Rollback
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Disimpan: rilis aktif + 4 rilis terakhir.</p>
          <ConfirmDialog
            open={target !== null}
            title="Rollback ke rilis ini?"
            confirmLabel="Rollback"
            busy={rb.busy}
            error={rb.error}
            onConfirm={async () => {
              if (target && (await rb.run(() => api(`/hosting/apps/${app.id}/rollback`, { method: "POST", json: { releaseId: target } })))) {
                setTarget(null);
                refresh();
              }
            }}
            onClose={() => {
              setTarget(null);
              rb.setError(null);
            }}
          >
            <p className="font-mono text-xs">{target}</p>
            <p>Health check dijalankan; jika gagal, rilis aktif saat ini dipulihkan.</p>
          </ConfirmDialog>
        </Card>
      </div>

      <Card>
        <CardTitle icon={History} title="Log deployment (disanitasi)" action={selected && <span className="font-mono text-xs text-muted">{selected}</span>} />
        {!selected ? (
          <p className="text-sm text-muted">Pilih deployment.</p>
        ) : log.error && !log.data ? (
          <ErrorState message={log.error} onRetry={log.refresh} />
        ) : (
          <pre ref={logRef} className="max-h-128 min-h-40 overflow-auto whitespace-pre-wrap wrap-break-word rounded-lg bg-surface-2/60 p-3 font-mono text-xs leading-relaxed text-ink-2">
            {log.data?.log || (log.loading ? "Memuat…" : "(log kosong)")}
          </pre>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- domains

const DNS_LABEL = { tunnel: "CNAME ke tunnel", resolves: "Ter-resolve", missing: "Belum ada record", error: "Gagal cek" } as const;
const TUNNEL_LABEL = { configured: "Ingress → gateway", missing: "Belum ada ingress", "wrong-target": "Ingress ke target lain", unreadable: "config.yml tidak terbaca" } as const;

function Domains({ app, refresh }: Props) {
  const [text, setText] = useState(app.domains.join("\n"));
  const save = useMutation();
  const resync = useMutation();
  const [sync, setSync] = useState<DomainSyncResult[] | null>(null);
  const status = usePoll<DomainStatus>(`/hosting/apps/${app.id}/domains/status`, 300_000);
  const cf = status.data?.cloudflare;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.3fr]">
      <Card>
        <CardTitle icon={Globe} title="Domain / subdomain" />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const domains = text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
            const res = await save.run(() => api<{ cloudflare: DomainSyncResult[] }>(`/hosting/apps/${app.id}/domains`, { method: "PUT", json: { domains } }));
            if (res) {
              setSync(res.data?.cloudflare ?? null);
              refresh();
              status.refresh();
            }
          }}
          className="space-y-3"
        >
          <Field
            label="Satu domain per baris (maks. 5)"
            htmlFor="domains"
            hint={
              cf?.configured
                ? `DNS di zona ${cf.zone ?? "Cloudflare"} dibuat/dihapus otomatis saat disimpan.${cf.saasEdge ? ` Domain dari akun lain: pemilik membuat CNAME ke ${cf.saasEdge}.` : ""} drive./panel.nifserver.cloud dicadangkan.`
                : "drive./panel.nifserver.cloud dicadangkan. Integrasi Cloudflare belum diaktifkan (lihat deploy/hosting/README.md)."
            }
          >
            <textarea id="domains" rows={4} value={text} onChange={(e) => setText(e.target.value)} className={cx(inputCls, "font-mono")} />
          </Field>
          <InlineError message={save.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" icon={Save} disabled={save.busy}>
              {save.busy ? "Menyimpan…" : "Simpan domain"}
            </Button>
            {cf?.configured && app.domains.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                icon={RefreshCw}
                disabled={resync.busy}
                onClick={async () => {
                  const res = await resync.run(() => api<DomainSyncResult[]>(`/hosting/apps/${app.id}/domains/sync`, { method: "POST", json: {} }));
                  if (res) {
                    setSync(res.data ?? null);
                    status.refresh();
                  }
                }}
              >
                {resync.busy ? "Menyinkronkan…" : "Sinkronkan ke Cloudflare"}
              </Button>
            )}
          </div>
          <InlineError message={resync.error} />
        </form>
        {sync && sync.length > 0 && (
          <ul className="mt-4 space-y-1.5 text-sm" aria-label="Hasil sinkronisasi Cloudflare">
            {sync.map((r) => (
              <li key={r.domain} className="rounded-lg bg-surface px-3 py-2">
                <p className="font-mono text-xs">{r.domain}</p>
                {r.error ? <p className="text-xs text-bad">{r.error}</p> : null}
                {r.steps.map((st) => (
                  <p key={st} className={cx("text-xs", r.ok ? "text-ok" : "text-muted")}>
                    {st}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-4 text-xs text-muted">
          Tanpa domain, aplikasi tetap bisa dicek lewat gateway dengan host internal <span className="font-mono">{app.internalHost}</span>.
        </p>
      </Card>

      <Card>
        <CardTitle
          icon={Globe}
          title="Status DNS & Cloudflare Tunnel"
          action={
            <Button variant="ghost" icon={RefreshCw} onClick={status.refresh} className="px-2 py-1 text-xs">
              Cek ulang
            </Button>
          }
        />
        {!status.data ? (
          status.error ? <ErrorState message={status.error} onRetry={status.refresh} /> : <LoadingRows rows={3} />
        ) : (
          <div className="space-y-4">
            {status.data.domains.length === 0 ? (
              <p className="text-sm text-muted">Belum ada domain.</p>
            ) : (
              <ul className="divide-y divide-line">
                {status.data.domains.map((d) => (
                  <li key={d.domain} className="py-2">
                    <p className="font-mono text-sm">{d.domain}</p>
                    <p className="text-xs text-muted">
                      DNS: <span className={d.dns.status === "missing" || d.dns.status === "error" ? "text-warn" : "text-ok"}>{DNS_LABEL[d.dns.status]}</span>
                      {d.dns.detail ? ` (${d.dns.detail})` : ""} · Tunnel:{" "}
                      <span className={d.tunnel === "configured" ? "text-ok" : "text-warn"}>{TUNNEL_LABEL[d.tunnel]}</span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <div className="space-y-2 text-sm text-ink-2">
              <p>
                {cf?.configured ? (
                  <>
                    Cloudflare <strong>otomatis</strong>: record DNS {cf.ingress ? "dan ingress tunnel " : ""}dikelola dashboard
                    {cf.ingress ? "." : "; ingress tunnel tetap dari config.yml (pakai rule wildcard, atau salin snippet di bawah)."}
                  </>
                ) : status.data.caddy.enabled ? (
                  <>
                    <strong>HTTPS otomatis lewat Caddy.</strong> Arahkan record DNS <span className="font-mono text-xs">A</span> (atau wildcard) domain ke IP publik server; sertifikat dibuat saat domain pertama kali dibuka.
                  </>
                ) : (
                  <>
                    Dashboard <strong>tidak mengubah</strong> DNS atau tunnel (Cloudflare belum diaktifkan).
                  </>
                )}{" "}
                Semua domain diarahkan ke gateway hosting <span className="font-mono text-xs">127.0.0.1:{status.data.gatewayPort}</span>; gateway memilih aplikasi berdasarkan Host.
              </p>
            </div>
            {status.data.snippet && !cf?.ingress && !(status.data.caddy.enabled && !cf?.configured) && (
              <>
                <CopyBlock text={status.data.snippet} label="Salin snippet ingress" />
                <p className="text-sm text-ink-2">Lalu jalankan di server (ganti &lt;nama-tunnel&gt;):</p>
                <CopyBlock text={(cf?.configured ? status.data.commands.filter((c) => !c.startsWith("cloudflared tunnel route dns")) : status.data.commands).join("\n")} label="Salin perintah" />
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- environment

interface Row {
  key: string;
  value: string;
  secret: boolean;
  stored: boolean; // existing secret: blank value keeps it
}

function Environment({ app, refresh }: Props) {
  const [rows, setRows] = useState<Row[]>(() => app.env.map((e) => ({ key: e.key, value: e.value ?? "", secret: e.secret, stored: e.secret && e.set })));
  const save = useMutation();
  const [note, setNote] = useState<string | null>(null);
  const isStatic = app.runtime === "static" || app.runtime === "vite";
  const update = (i: number, patch: Partial<Row>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setNote(null);
    const vars = rows
      .filter((r) => r.key.trim())
      .map((r) => (r.secret && r.stored && r.value === "" ? { key: r.key.trim(), secret: true } : { key: r.key.trim(), secret: r.secret, value: r.value }));
    const res = await save.run(() => api<{ restartRequired: boolean; rebuildRequired: boolean }>(`/hosting/apps/${app.id}/env`, { method: "PUT", json: { vars } }));
    if (res?.data) {
      setRows((r) => r.filter((x) => x.key.trim()).map((x) => (x.secret ? { ...x, value: "", stored: true } : x)));
      setNote(res.data.restartRequired ? "Tersimpan. Restart aplikasi agar nilai baru dipakai." : res.data.rebuildRequired ? "Tersimpan. Deploy ulang agar variabel build dipakai." : "Tersimpan.");
      refresh();
    }
  }

  return (
    <Card>
      <CardTitle icon={KeyRound} title="Environment variable" />
      <p className="mb-4 text-sm text-ink-2">
        Nilai <Lock className="inline size-3.5" aria-hidden /> secret disimpan di server (izin 0600), tidak pernah dikirim kembali ke browser, disensor dari log, dan hanya
        tersedia saat runtime. Variabel non-secret juga tersedia saat build (mis. <span className="font-mono text-xs">VITE_*</span>,{" "}
        <span className="font-mono text-xs">NEXT_PUBLIC_*</span>).
        {isStatic && " Situs statis tidak punya runtime: hanya variabel non-secret yang berpengaruh."}
      </p>
      <form onSubmit={submit} className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[minmax(8rem,1fr)_2fr_auto_auto] sm:items-center">
            <input aria-label="Nama variabel" value={r.key} onChange={(e) => update(i, { key: e.target.value.toUpperCase() })} placeholder="NAMA_VARIABEL" className={cx(inputCls, "font-mono")} />
            <input
              aria-label={`Nilai ${r.key}`}
              type={r.secret ? "password" : "text"}
              autoComplete="off"
              value={r.value}
              onChange={(e) => update(i, { value: e.target.value })}
              placeholder={r.secret && r.stored ? "•••••• tersimpan (kosongkan untuk mempertahankan)" : "nilai"}
              className={cx(inputCls, "order-3 col-span-2 font-mono sm:order-0 sm:col-span-1")}
            />
            <label className="flex items-center gap-1.5 text-xs text-ink-2">
              <input type="checkbox" checked={r.secret} onChange={(e) => update(i, { secret: e.target.checked, stored: e.target.checked && r.stored })} />
              Secret
            </label>
            <button type="button" aria-label={`Hapus ${r.key || "baris"}`} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="grid size-9 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-bad">
              <Trash2 className="size-4" aria-hidden />
            </button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <Button type="button" variant="ghost" icon={Plus} onClick={() => setRows((r) => [...r, { key: "", value: "", secret: false, stored: false }])}>
            Tambah
          </Button>
          <Button type="submit" icon={Save} disabled={save.busy}>
            Simpan
          </Button>
        </div>
        <InlineError message={save.error} />
        {note && <p className="text-sm text-ok">{note}</p>}
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- database

function DatabaseTab({ app, refresh }: Props) {
  const db = app.database;
  const [selectedType, setType] = useState(db.type);
  const type = db.managed ? db.type : selectedType;
  const [createName, setCreateName] = useState(app.id.replace(/-/g, "_"));
  const [notice, setNotice] = useState<string | null>(null);
  const save = useMutation();
  const server = type === "mysql" || type === "postgresql";
  const name = db.name ?? app.id.replace(/-/g, "_");
  const user = db.user ?? name;
  const sql =
    type === "mysql"
      ? `sudo mysql <<'SQL'\nCREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\nCREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '<PASSWORD-KUAT>';\nGRANT ALL PRIVILEGES ON \`${name}\`.* TO '${user}'@'localhost';\nSQL`
      : `sudo -u postgres psql <<'SQL'\nCREATE ROLE ${user} LOGIN PASSWORD '<PASSWORD-KUAT>';\nCREATE DATABASE ${name} OWNER ${user};\nSQL`;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    const str = (k: string) => String(f.get(k) ?? "").trim();
    const body: Record<string, unknown> = { type, autoMigrate: f.get("autoMigrate") === "on" };
    if (server) {
      body.host = str("host") || "127.0.0.1";
      if (str("port")) body.port = Number(str("port"));
      body.name = str("name");
      body.user = str("user");
      if (str("password")) body.password = str("password");
    }
    if (await save.run(() => api(`/hosting/apps/${app.id}/database`, { method: "PUT", json: body }))) {
      const password = form.elements.namedItem("password");
      if (password instanceof HTMLInputElement) password.value = "";
      refresh();
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1fr]">
      <Card>
        <CardTitle icon={Database} title="Database aplikasi" />
        {db.type === "none" && (
          <form className="mt-3 space-y-3" onSubmit={async e => {
            e.preventDefault();
            setNotice(null);
            const result = await save.run(() => api<HostedAppDetail>(`/hosting/apps/${app.id}/database/create`, { method: "POST", json: { name: createName.trim() } }));
            if (result?.data) {
              setType("mysql");
              setNotice(`Database ${result.data.database.name} berhasil dibuat. Buka phpMyAdmin untuk melihat tabel atau mengimpor SQL.`);
              refresh();
            }
          }}>
            <Field label="Nama database baru" htmlFor="db-create-name" hint="1–64 karakter a-z, 0-9, dan _. Diawali huruf. Nama harus belum digunakan.">
              <input id="db-create-name" value={createName} onChange={e => setCreateName(e.target.value)} required maxLength={64} pattern="[a-z][a-z0-9_]{0,63}" disabled={save.busy} className={cx(inputCls, "font-mono")} />
            </Field>
            <Button type="submit" disabled={save.busy}>Buat database MySQL</Button>
          </form>
        )}
        {notice && <p role="status" className="mt-3 text-sm text-ok">{notice}</p>}
        {db.managed && <p className="mt-3 text-sm text-ink-2">Database aktif: <strong className="font-mono">{db.name}</strong>. Koneksi dikelola dashboard. Nama ditentukan saat pembuatan; user dan password dibuat otomatis.</p>}
        <div className="my-3 flex flex-wrap gap-2">
          {app.phpMyAdminAvailable && <a href={`/phpmyadmin/nifhost-signon.php?app=${encodeURIComponent(app.id)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white">Buka phpMyAdmin</a>}

          {db.managed && (["reset", "delete"] as const).map(operation => <Button key={operation} disabled={save.busy} onClick={async () => {
            const confirm = window.prompt(`${operation === "delete" ? "Hapus permanen database beserta seluruh isinya" : "Reset password database; restart aplikasi setelah selesai"}. Ketik ID aplikasi: ${app.id}`);
            if (confirm !== app.id) return;
            if (await save.run(() => api(`/hosting/apps/${app.id}/database/${operation}`, { method: "POST", json: { confirm } }))) {
              if (operation === "delete") setType("none");
              setNotice(operation === "delete" ? "Database berhasil dihapus." : "Password database berhasil direset. Restart aplikasi agar password baru dipakai.");
              refresh();
            }
          }}>{operation === "delete" ? "Hapus database" : "Reset password"}</Button>)}
          {app.runtime === "laravel" && db.type !== "none" && <Button disabled={save.busy} onClick={async () => {
            const confirm = window.prompt(`Migrasi mengubah schema database. Ketik ID aplikasi: ${app.id}`);
            if (confirm !== app.id) return;
            if (await save.run(() => api(`/hosting/apps/${app.id}/database/migrate`, { method: "POST", json: { confirm } }))) refresh();
          }}>Migrate Laravel</Button>}
        </div>

        {db.type === "mysql" && !app.phpMyAdminAvailable && <p className="mb-3 text-sm text-muted">{db.managed ? "Akses phpMyAdmin belum diaktifkan di server." : "Akses phpMyAdmin dari dashboard tersedia untuk database MySQL yang dibuat dashboard."}</p>}
        <form key={`${db.type}:${db.name}:${db.user}`} onSubmit={submit} className="space-y-3">
          <Field label="Jenis" htmlFor="db-type">
            <select id="db-type" value={type} disabled={db.managed || save.busy} onChange={(e) => setType(e.target.value as typeof type)} className={inputCls}>
              <option value="none">Tidak ada</option>
              <option value="sqlite">SQLite (file per aplikasi, tanpa server)</option>
              <option value="mysql">MySQL / MariaDB (localhost)</option>
              <option value="postgresql">PostgreSQL (localhost)</option>
            </select>
          </Field>
          {server && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Host" htmlFor="db-host" hint="Hanya localhost — sandbox aplikasi memblokir jaringan LAN.">
                <select id="db-host" name="host" disabled={db.managed} defaultValue={db.host ?? "127.0.0.1"} className={inputCls}>
                  <option>127.0.0.1</option>
                  <option>localhost</option>
                  <option>::1</option>
                </select>
              </Field>
              <Field label="Port" htmlFor="db-port">
                <input id="db-port" name="port" readOnly={db.managed} inputMode="numeric" defaultValue={db.port ?? ""} placeholder={type === "mysql" ? "3306" : "5432"} className={inputCls} />
              </Field>
              <Field label="Nama database" htmlFor="db-name">
                <input id="db-name" name="name" readOnly={db.managed} required defaultValue={db.name ?? name} className={cx(inputCls, "font-mono")} />
              </Field>
              <Field label="User" htmlFor="db-user">
                <input id="db-user" name="user" readOnly={db.managed} required defaultValue={db.user ?? user} className={cx(inputCls, "font-mono")} />
              </Field>
              <Field label="Password" htmlFor="db-pass" hint={db.passwordSet ? "Tersimpan. Kosongkan untuk mempertahankan." : "Disimpan sebagai secret."}>
                <input id="db-pass" name="password" disabled={db.managed} type="password" autoComplete="new-password" placeholder={db.passwordSet ? "••••••" : ""} className={inputCls} />
              </Field>
            </div>
          )}
          {app.runtime === "laravel" && <label className="flex gap-2 text-sm"><input type="checkbox" name="autoMigrate" defaultChecked={db.autoMigrate} />Jalankan migrasi otomatis sebelum setiap deploy. Perubahan schema tidak dibatalkan saat rollback.</label>}
          <InlineError message={save.error} />
          <Button type="submit" icon={Save} disabled={save.busy || (db.managed && app.runtime !== "laravel")}>
            Simpan
          </Button>
        </form>
      </Card>
      <Card>
        <CardTitle icon={Database} title="Yang diberikan ke aplikasi" />
        {type === "none" ? (
          <p className="text-sm text-muted">Tidak ada variabel database.</p>
        ) : type === "sqlite" ? (
          <p className="text-sm text-ink-2">
            <span className="font-mono text-xs">DB_CONNECTION=sqlite</span>, <span className="font-mono text-xs">DB_DATABASE</span> dan{" "}
            <span className="font-mono text-xs">DATABASE_URL</span> → <span className="font-mono text-xs">/var/lib/nifhost/{app.id}/database.sqlite</span> (persisten antar rilis).
          </p>
        ) : (
          <div className="space-y-3 text-sm text-ink-2">
            <p>
              Variabel <span className="font-mono text-xs">DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME, DB_PASSWORD, DATABASE_URL</span> disuntikkan saat runtime. Server database
              harus tersedia di server. {db.managed ? "Database ini sudah dibuat dan dikelola dashboard. Gunakan phpMyAdmin atau migrasi project untuk mengisi tabel." : "Untuk koneksi manual, buat database dan user di server sebelum menyimpan konfigurasinya:"}
            </p>
            {!db.managed && <CopyBlock text={sql} label="Salin SQL" />}
          </div>
        )}
        <p className="mt-3 text-xs text-muted">Perubahan berlaku setelah restart aplikasi.</p>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- settings

function SettingsTab({ app, refresh }: Props) {
  const router = useRouter();
  const save = useMutation();
  const token = useMutation();
  const del = useMutation();
  const [method, setMethod] = useState(app.deployMethod);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteDatabase, setDeleteDatabase] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "").trim();
    const options: Record<string, string> = {};
    for (const k of ["outputDir", "entry", "docroot"]) if (str(k)) options[k] = str(k);
    const body = {
      name: str("name"),
      deployMethod: method,
      healthPath: str("healthPath"),
      repo: str("repoUrl") ? { url: str("repoUrl"), branch: str("branch") || "main" } : null,
      options,
    };
    if (await save.run(() => api(`/hosting/apps/${app.id}`, { method: "PATCH", json: body }))) refresh();
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.3fr_1fr]">
      <Card>
        <CardTitle icon={Settings2} title="Konfigurasi" />
        <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Nama" htmlFor="s-name">
            <input id="s-name" name="name" required defaultValue={app.name} className={inputCls} />
          </Field>
          <Field label="Metode deploy utama" htmlFor="s-method">
            <select id="s-method" value={method} onChange={(e) => setMethod(e.target.value as typeof method)} className={inputCls}>
              <option value="upload">Upload (file, folder, atau ZIP)</option>
              <option value="github">GitHub</option>
            </select>
          </Field>
          <Field label="URL repository" htmlFor="s-repo" hint="Kosongkan untuk menghapus">
            <input id="s-repo" name="repoUrl" defaultValue={app.repo?.url ?? ""} placeholder="https://github.com/owner/repo" className={cx(inputCls, "font-mono")} />
          </Field>
          <Field label="Branch rilis" htmlFor="s-branch">
            <input id="s-branch" name="branch" defaultValue={app.repo?.branch ?? "main"} className={cx(inputCls, "font-mono")} />
          </Field>
          <Field label="Health check path" htmlFor="s-health">
            <input id="s-health" name="healthPath" defaultValue={app.healthPath} className={cx(inputCls, "font-mono")} />
          </Field>
          {(app.runtime === "static" || app.runtime === "vite") && (
            <Field label="Folder output" htmlFor="s-out">
              <input id="s-out" name="outputDir" defaultValue={app.options.outputDir ?? ""} className={cx(inputCls, "font-mono")} />
            </Field>
          )}
          {app.runtime === "node" && (
            <Field label="File entry" htmlFor="s-entry">
              <input id="s-entry" name="entry" defaultValue={app.options.entry ?? ""} className={cx(inputCls, "font-mono")} />
            </Field>
          )}
          {app.runtime === "php" && (
            <Field label="Document root" htmlFor="s-docroot">
              <input id="s-docroot" name="docroot" defaultValue={app.options.docroot ?? ""} className={cx(inputCls, "font-mono")} />
            </Field>
          )}
          <div className="flex flex-col gap-2 sm:col-span-2">
            <InlineError message={save.error} />
            <Button type="submit" icon={Save} disabled={save.busy} className="self-start">
              Simpan
            </Button>
          </div>
        </form>
      </Card>

      <div className="flex flex-col gap-4">
        <Card>
          <CardTitle icon={Lock} title="Token deploy GitHub" />
          <p className="mb-3 text-sm text-ink-2">
            Untuk repo privat: fine-grained token dengan akses <em>Contents: read-only</em> ke satu repo. Disimpan di server, hanya dibaca sandbox build.{" "}
            {app.gitTokenSet ? <span className="text-ok">Token tersimpan.</span> : "Belum ada token."}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const value = String(new FormData(form).get("token") ?? "").trim();
              if (value && (await token.run(() => api(`/hosting/apps/${app.id}/git-token`, { method: "PUT", json: { token: value } })))) {
                form.reset();
                refresh();
              }
            }}
            className="flex flex-col gap-2 sm:flex-row"
          >
            <input name="token" type="password" autoComplete="off" aria-label="Token GitHub" placeholder="github_pat_…" className={cx(inputCls, "font-mono")} />
            <Button type="submit" icon={Save} disabled={token.busy}>
              Simpan
            </Button>
          </form>
          {app.gitTokenSet && (
            <Button
              variant="ghost"
              icon={Trash2}
              className="mt-2"
              disabled={token.busy}
              onClick={async () => {
                if (await token.run(() => api(`/hosting/apps/${app.id}/git-token`, { method: "PUT", json: { token: null } }))) refresh();
              }}
            >
              Hapus token
            </Button>
          )}
          <div className="mt-2">
            <InlineError message={token.error} />
          </div>
        </Card>

        <Card className="border-bad/30">
          <CardTitle icon={Trash2} title="Hapus aplikasi" />
          <p className="mb-3 text-sm text-ink-2">Menghentikan service, menghapus route gateway, semua rilis, log, dan secret aplikasi ini. Tidak bisa dibatalkan.</p>
          {app.database.managed && <label className="mb-3 flex gap-2 text-sm"><input type="checkbox" checked={deleteDatabase} onChange={e => setDeleteDatabase(e.target.checked)} />Hapus juga database MySQL beserta seluruh isinya</label>}
          <Button icon={Trash2} onClick={() => setConfirmDelete(true)} className="bg-bad hover:bg-bad/90">
            Hapus…
          </Button>
          <ConfirmDialog
            open={confirmDelete}
            title={`Hapus ${app.name}?`}
            confirmLabel="Hapus permanen"
            danger
            typeToConfirm={app.id}
            busy={del.busy}
            error={del.error}
            onConfirm={async (typed) => {
              if (await del.run(() => api(`/hosting/apps/${app.id}`, { method: "DELETE", json: { confirm: typed, deleteDatabase } }))) router.push("/hosting");
            }}
            onClose={() => {
              setConfirmDelete(false);
              del.setError(null);
            }}
          >
            <p>Domain di Cloudflare tidak diubah; hapus record/ingress-nya secara manual bila perlu.</p>
          </ConfirmDialog>
        </Card>
      </div>
    </div>
  );
}
