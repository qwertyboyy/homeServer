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
import { bytes, dateTime, relative } from "@/lib/format";
import type { DomainStatus, HostedAppDetail } from "@/lib/types";
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
  const isStatic = app.runtime === "static" || app.runtime === "vite";
  const busy = app.status === "deploying";

  async function uploadZip(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    const ok = await deploy.run(() =>
      api(`/hosting/apps/${app.id}/deploy/upload`, { method: "POST", body: file, headers: { "Content-Type": "application/zip" } }),
    );
    if (ok) {
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
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
            <Field label="Upload ZIP" htmlFor="zip" hint="Isi proyek (boleh dalam satu folder). .git, node_modules, dan .env dilewati otomatis.">
              <input
                ref={fileRef}
                id="zip"
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className={cx(inputCls, "file:mr-3 file:rounded-md file:border-0 file:bg-surface file:px-3 file:py-1 file:text-sm file:text-ink")}
              />
            </Field>
            <Button type="submit" icon={Upload} disabled={!file || deploy.busy || busy}>
              {deploy.busy ? "Mengunggah…" : file ? `Deploy ${file.name} (${bytes(file.size)})` : "Deploy ZIP"}
            </Button>
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
  const status = usePoll<DomainStatus>(`/hosting/apps/${app.id}/domains/status`, 300_000);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_1.3fr]">
      <Card>
        <CardTitle icon={Globe} title="Domain / subdomain" />
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const domains = text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);
            if (await save.run(() => api(`/hosting/apps/${app.id}/domains`, { method: "PUT", json: { domains } }))) {
              refresh();
              status.refresh();
            }
          }}
          className="space-y-3"
        >
          <Field label="Satu domain per baris (maks. 5)" htmlFor="domains" hint="drive./panel.nifserver.cloud dicadangkan. Wildcard DNS tidak diasumsikan.">
            <textarea id="domains" rows={4} value={text} onChange={(e) => setText(e.target.value)} className={cx(inputCls, "font-mono")} />
          </Field>
          <InlineError message={save.error} />
          <Button type="submit" icon={Save} disabled={save.busy}>
            Simpan domain
          </Button>
        </form>
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
                Dashboard <strong>tidak mengubah</strong> konfigurasi cloudflared, DNS, atau Nginx. Semua domain diarahkan ke gateway hosting{" "}
                <span className="font-mono text-xs">127.0.0.1:{status.data.gatewayPort}</span>; gateway memilih aplikasi berdasarkan Host.
              </p>
            </div>
            {status.data.snippet && (
              <>
                <CopyBlock text={status.data.snippet} label="Salin snippet ingress" />
                <p className="text-sm text-ink-2">Lalu jalankan di server (ganti &lt;nama-tunnel&gt;):</p>
                <CopyBlock text={status.data.commands.join("\n")} label="Salin perintah" />
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
  const [type, setType] = useState(db.type);
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
    const body: Record<string, unknown> = { type };
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
        <form onSubmit={submit} className="space-y-3">
          <Field label="Jenis" htmlFor="db-type">
            <select id="db-type" value={type} onChange={(e) => setType(e.target.value as typeof type)} className={inputCls}>
              <option value="none">Tidak ada</option>
              <option value="sqlite">SQLite (file per aplikasi, tanpa server)</option>
              <option value="mysql">MySQL / MariaDB (localhost)</option>
              <option value="postgresql">PostgreSQL (localhost)</option>
            </select>
          </Field>
          {server && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Host" htmlFor="db-host" hint="Hanya localhost — sandbox aplikasi memblokir jaringan LAN.">
                <select id="db-host" name="host" defaultValue={db.host ?? "127.0.0.1"} className={inputCls}>
                  <option>127.0.0.1</option>
                  <option>localhost</option>
                  <option>::1</option>
                </select>
              </Field>
              <Field label="Port" htmlFor="db-port">
                <input id="db-port" name="port" inputMode="numeric" defaultValue={db.port ?? ""} placeholder={type === "mysql" ? "3306" : "5432"} className={inputCls} />
              </Field>
              <Field label="Nama database" htmlFor="db-name">
                <input id="db-name" name="name" required defaultValue={db.name ?? name} className={cx(inputCls, "font-mono")} />
              </Field>
              <Field label="User" htmlFor="db-user">
                <input id="db-user" name="user" required defaultValue={db.user ?? user} className={cx(inputCls, "font-mono")} />
              </Field>
              <Field label="Password" htmlFor="db-pass" hint={db.passwordSet ? "Tersimpan. Kosongkan untuk mempertahankan." : "Disimpan sebagai secret."}>
                <input id="db-pass" name="password" type="password" autoComplete="new-password" placeholder={db.passwordSet ? "••••••" : ""} className={inputCls} />
              </Field>
            </div>
          )}
          <InlineError message={save.error} />
          <Button type="submit" icon={Save} disabled={save.busy}>
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
              tidak dibuat otomatis; cek status di Prasyarat. Buat database & user sekali di server:
            </p>
            <CopyBlock text={sql} label="Salin SQL" />
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
              <option value="upload">Upload ZIP</option>
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
              if (await del.run(() => api(`/hosting/apps/${app.id}`, { method: "DELETE", json: { confirm: typed } }))) router.push("/hosting");
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
