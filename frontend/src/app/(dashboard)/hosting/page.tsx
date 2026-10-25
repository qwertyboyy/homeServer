"use client";

import { ChevronRight, GitBranch, Plus, Rocket, ShieldAlert, ShieldCheck, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { CheckBadge, Field, InlineError, StatusBadge, inputCls, useMutation } from "@/components/hosting";
import { Button, Card, CardTitle, EmptyState, ErrorState, HealthBadge, LoadingRows, PageHeader, UpdatedAt, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { relative } from "@/lib/format";
import type { HostedApp, HostedAppDetail, PrereqCheck, Prerequisites, RuntimeInfo, RuntimeKind } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";

const GROUPS: { key: PrereqCheck["group"]; label: string }[] = [
  { key: "core", label: "Inti" },
  { key: "runtime", label: "Runtime" },
  { key: "database", label: "Database" },
  { key: "network", label: "Jaringan & domain" },
];

function PrereqPanel({ pre }: { pre: Prerequisites }) {
  const problems = pre.checks.filter((c) => c.status === "missing" || c.status === "warning");
  const [open, setOpen] = useState(!pre.ready);
  return (
    <Card className="mb-4">
      <CardTitle
        icon={pre.ready ? ShieldCheck : ShieldAlert}
        title="Prasyarat server"
        action={
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-xs font-medium text-primary hover:underline">
            {open ? "Sembunyikan" : `Lihat detail (${problems.length} catatan)`}
          </button>
        }
      />
      <p className="text-sm text-ink-2">
        {pre.executor === "simulated"
          ? "Mode simulasi: build dan service tidak benar-benar dijalankan. Cocok untuk mencoba alur UI."
          : pre.ready
            ? "Komponen inti terpasang. Build berjalan di sandbox nifbuild@, aplikasi di nifapp@ dengan user terpisah."
            : "Komponen inti belum lengkap; deploy akan gagal sampai item merah dipasang."}
      </p>
      {open && (
        <div className="mt-4 space-y-4">
          {GROUPS.map((g) => (
            <div key={g.key}>
              <h3 className="mb-1 text-xs font-medium uppercase tracking-wider text-muted">{g.label}</h3>
              <ul className="divide-y divide-line">
                {pre.checks
                  .filter((c) => c.group === g.key)
                  .map((c) => (
                    <li key={c.key} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                      <div className="min-w-0">
                        <p className="text-sm">{c.label}</p>
                        {c.detail && <p className="text-xs text-muted">{c.detail}</p>}
                        {c.fix && <p className="wrap-break-word font-mono text-xs text-ink-2">{c.fix}</p>}
                      </div>
                      <CheckBadge status={c.status} />
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");

function CreateForm({ runtimes, onClose }: { runtimes: RuntimeInfo[]; onClose: () => void }) {
  const router = useRouter();
  const m = useMutation();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeKind>("static");
  const [method, setMethod] = useState<"upload" | "github">("upload");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const str = (k: string) => String(f.get(k) ?? "").trim();
    const options: Record<string, string> = {};
    if ((runtime === "static" || runtime === "vite") && str("outputDir")) options.outputDir = str("outputDir");
    if (runtime === "node" && str("entry")) options.entry = str("entry");
    if (runtime === "php" && str("docroot")) options.docroot = str("docroot");
    const body = {
      id,
      name,
      runtime,
      deployMethod: method,
      ...(method === "github" ? { repo: { url: str("repoUrl"), branch: str("branch") || "main" } } : {}),
      domains: str("domains") ? str("domains").split(/[\s,]+/).filter(Boolean) : [],
      healthPath: str("healthPath") || "/",
      options,
    };
    const res = await m.run(() => api<HostedAppDetail>("/hosting/apps", { method: "POST", json: body }));
    if (res?.data) router.push(`/hosting/${res.data.id}`);
  }

  const info = runtimes.find((r) => r.kind === runtime);
  return (
    <Card className="mb-4">
      <CardTitle
        icon={Plus}
        title="Aplikasi baru"
        action={
          <button type="button" onClick={onClose} aria-label="Tutup" className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2">
            <X className="size-4" aria-hidden />
          </button>
        }
      />
      <form onSubmit={submit} className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Nama" htmlFor="h-name">
          <input
            id="h-name"
            required
            maxLength={64}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!idTouched) setId(slug(e.target.value));
            }}
            className={inputCls}
          />
        </Field>
        <Field label="ID" htmlFor="h-id" hint="Dipakai untuk folder, unit nifapp@<id>, dan host internal. a-z, 0-9, '-' (3–32).">
          <input
            id="h-id"
            required
            pattern="[a-z][a-z0-9\-]{1,30}[a-z0-9]"
            value={id}
            onChange={(e) => {
              setIdTouched(true);
              setId(e.target.value);
            }}
            className={cx(inputCls, "font-mono")}
          />
        </Field>
        <Field label="Runtime" htmlFor="h-runtime" hint={info?.buildSteps.length ? `Build: ${info.buildSteps.join(" → ")}` : "Tanpa build; file disajikan langsung oleh gateway."}>
          <select id="h-runtime" value={runtime} onChange={(e) => setRuntime(e.target.value as RuntimeKind)} className={inputCls}>
            {runtimes.map((r) => (
              <option key={r.kind} value={r.kind}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium text-ink-2">Metode deploy</legend>
          <div className="grid grid-cols-2 gap-2">
            {(
              [
                { key: "upload", label: "Upload ZIP", icon: Upload },
                { key: "github", label: "GitHub", icon: GitBranch },
              ] as const
            ).map(({ key, label, icon: Icon }) => (
              <label
                key={key}
                className={cx(
                  "flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition",
                  method === key ? "border-primary bg-primary/10 font-medium" : "border-line hover:bg-surface-2",
                )}
              >
                <input type="radio" name="method" value={key} checked={method === key} onChange={() => setMethod(key)} className="sr-only" />
                <Icon className="size-4" aria-hidden />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
        {method === "github" && (
          <>
            <Field label="URL repository" htmlFor="h-repo" hint="HTTPS saja, mis. https://github.com/owner/repo. Repo privat: simpan token deploy di halaman aplikasi.">
              <input id="h-repo" name="repoUrl" required placeholder="https://github.com/owner/repo" className={cx(inputCls, "font-mono")} />
            </Field>
            <Field label="Branch" htmlFor="h-branch">
              <input id="h-branch" name="branch" defaultValue="main" className={cx(inputCls, "font-mono")} />
            </Field>
          </>
        )}
        <Field label="Domain (opsional)" htmlFor="h-domains" hint="Pisahkan dengan koma. DNS & tunnel diatur terpisah — lihat tab Domain.">
          <input id="h-domains" name="domains" placeholder="app.nifserver.cloud" className={cx(inputCls, "font-mono")} />
        </Field>
        <Field label="Health check path" htmlFor="h-health">
          <input id="h-health" name="healthPath" defaultValue="/" className={cx(inputCls, "font-mono")} />
        </Field>
        {(runtime === "static" || runtime === "vite") && (
          <Field label="Folder output" htmlFor="h-out" hint={runtime === "vite" ? "Default dist" : "Default . (root arsip)"}>
            <input id="h-out" name="outputDir" placeholder={runtime === "vite" ? "dist" : "."} className={cx(inputCls, "font-mono")} />
          </Field>
        )}
        {runtime === "node" && (
          <Field label="File entry" htmlFor="h-entry" hint="Default: field main di package.json, lalu server.js / index.js">
            <input id="h-entry" name="entry" placeholder="dist/server.js" className={cx(inputCls, "font-mono")} />
          </Field>
        )}
        {runtime === "php" && (
          <Field label="Document root" htmlFor="h-docroot" hint="Default . — file sensitif (.env, composer.json, vendor/) tetap diblokir">
            <input id="h-docroot" name="docroot" placeholder="public" className={cx(inputCls, "font-mono")} />
          </Field>
        )}
        <div className="flex flex-col gap-3 md:col-span-2 md:flex-row md:items-center md:justify-between">
          <InlineError message={m.error} />
          <div className="flex gap-2 md:ml-auto">
            <Button type="button" variant="ghost" onClick={onClose}>
              Batal
            </Button>
            <Button type="submit" icon={Plus} disabled={m.busy || !id || !name}>
              {m.busy ? "Membuat…" : "Buat aplikasi"}
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

export default function HostingPage() {
  const apps = usePoll<HostedApp[]>("/hosting/apps", 10_000);
  const pre = usePoll<Prerequisites>("/hosting/prerequisites", 120_000);
  const runtimes = usePoll<RuntimeInfo[]>("/hosting/runtimes", 3_600_000);
  const [creating, setCreating] = useState(false);

  return (
    <>
      <PageHeader title="Hosting" description="Deploy website dan aplikasi dari ZIP atau GitHub. Build berjalan di sandbox terpisah; rilis gagal tidak menyentuh rilis aktif.">
        <UpdatedAt at={apps.updatedAt} error={apps.error} />
        {!creating && (
          <Button icon={Plus} onClick={() => setCreating(true)} disabled={!runtimes.data}>
            Aplikasi baru
          </Button>
        )}
      </PageHeader>

      {pre.data && <PrereqPanel pre={pre.data} />}
      {creating && runtimes.data && <CreateForm runtimes={runtimes.data} onClose={() => setCreating(false)} />}

      {apps.loading && !apps.data ? (
        <Card>
          <LoadingRows rows={4} />
        </Card>
      ) : apps.error && !apps.data ? (
        <ErrorState message={apps.error} onRetry={apps.refresh} />
      ) : apps.data && apps.data.length > 0 ? (
        <Card className="p-0 sm:p-0">
          <ul className="divide-y divide-line">
            {apps.data.map((a) => (
              <li key={a.id}>
                <Link href={`/hosting/${a.id}`} className="group grid grid-cols-1 gap-2 px-4 py-3 transition hover:bg-surface-2/50 sm:px-5 md:grid-cols-[1.6fr_1fr_1.4fr_auto_auto] md:items-center md:gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{a.name}</p>
                    <p className="truncate font-mono text-xs text-muted">
                      {a.id} · {a.deployMethod === "github" ? "GitHub" : "ZIP"}
                      {a.port ? ` · :${a.port}` : ""}
                    </p>
                  </div>
                  <p className="truncate text-sm text-ink-2">{a.runtimeLabel}</p>
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs">{a.domains[0] ?? <span className="text-muted">tanpa domain</span>}</p>
                    <p className="text-xs text-muted">
                      {a.lastDeployment ? `deploy ${relative(a.lastDeployment.startedAt)}` : "belum pernah deploy"}
                      {a.activeRelease ? ` · ${a.activeRelease.id}` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={a.status} />
                    <HealthBadge health={a.health.status} />
                  </div>
                  <ChevronRight className="hidden size-4 text-muted transition group-hover:text-primary md:block" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        !creating && (
          <Card>
            <EmptyState icon={Rocket} title="Belum ada aplikasi">
              Buat konfigurasi aplikasi, lalu deploy lewat upload ZIP atau repository GitHub.
              <div className="mt-4">
                <Button icon={Plus} onClick={() => setCreating(true)} disabled={!runtimes.data}>
                  Aplikasi baru
                </Button>
              </div>
            </EmptyState>
          </Card>
        )
      )}
    </>
  );
}
