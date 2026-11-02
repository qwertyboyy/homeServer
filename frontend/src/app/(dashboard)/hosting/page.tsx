"use client";

import { ChevronRight, GitBranch, Plus, Rocket, ShieldAlert, ShieldCheck, Upload, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { CheckBadge, Field, InlineError, StatusBadge, inputCls, useMutation } from "@/components/hosting";
import { Button, Card, CardTitle, EmptyState, ErrorState, HealthBadge, LoadingRows, PageHeader, UpdatedAt, cx } from "@/components/ui";
import { api } from "@/lib/api";
import { bytes, relative } from "@/lib/format";
import { hasIndexHtml, pick, uploadSite, type PickedFile, type Progress } from "@/lib/siteUpload";
import type { HostedApp, HostedAppDetail, HostingOverview, PrereqCheck, Prerequisites, RuntimeInfo, RuntimeKind } from "@/lib/types";
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

function CreateForm({ runtimes, overview, onClose }: { runtimes: RuntimeInfo[]; overview: HostingOverview | null; onClose: () => void }) {
  const router = useRouter();
  const m = useMutation();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeKind>("static");
  const [method, setMethod] = useState<"upload" | "github">("upload");
  const [sub, setSub] = useState("");
  const [subTouched, setSubTouched] = useState(false);
  const [source, setSource] = useState<"zip" | "folder" | "files">("zip");
  const [zip, setZip] = useState<File | null>(null);
  const [picked, setPicked] = useState<{ files: PickedFile[]; ignored: number }>({ files: [], ignored: 0 });
  const [progress, setProgress] = useState<Progress | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const base = overview?.baseDomain ?? null;
  const looseFiles = runtime === "static"; // file/folder upload is for Website statis only
  const activeSource = looseFiles ? source : "zip";
  const hasFiles = method === "upload" && (activeSource === "zip" ? !!zip : picked.files.length > 0);
  const missingIndex = method === "upload" && activeSource !== "zip" && picked.files.length > 0 && !hasIndexHtml(picked.files);

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
      domains: [...(base && sub ? [`${sub}.${base}`] : []), ...(str("domains") ? str("domains").split(/[\s,]+/).filter(Boolean) : [])],
      healthPath: str("healthPath") || "/",
      options,
    };
    if (missingIndex) return;
    // One click: create (DNS sync) -> upload -> deploy. A failed upload leaves the app created, so it can be retried on its page.
    const res = await m.run(async () => {
      setStage("Membuat aplikasi…");
      const created = await api<HostedAppDetail & { cloudflare?: { ok: boolean; error: string | null }[] }>("/hosting/apps", { method: "POST", json: body });
      const failedDns = created.data?.cloudflare?.find((r) => !r.ok);
      if (failedDns) setNotice(`Aplikasi dibuat, tetapi DNS Cloudflare belum beres: ${failedDns.error}. Coba lagi dari tab Domain.`);
      if (hasFiles) {
        setStage("Mengunggah & deploy…");
        try {
          if (activeSource === "zip") {
            await api(`/hosting/apps/${id}/deploy/upload`, { method: "POST", body: zip, headers: { "Content-Type": "application/zip" } });
          } else {
            await uploadSite(id, picked.files, setProgress);
          }
        } catch (e) {
          router.push(`/hosting/${id}`);
          throw e;
        } finally {
          setProgress(null);
        }
      }
      return created;
    });
    setStage(null);
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
              if (!idTouched) {
                const next = slug(e.target.value);
                setId(next);
                if (!subTouched) setSub(next);
              }
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
              if (!subTouched) setSub(e.target.value);
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
                { key: "upload", label: "Upload (ZIP/Folder/File)", icon: Upload },
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
        {base && (
          <Field
            label="Subdomain"
            htmlFor="h-sub"
            hint={
              overview?.cloudflare.configured
                ? `DNS & HTTPS dibuat otomatis di Cloudflare → ${sub || "nama"}.${base}`
                : overview?.caddy.enabled
                  ? `HTTPS otomatis lewat Caddy → ${sub || "nama"}.${base}. Pastikan DNS (record A atau wildcard *.${base}) mengarah ke IP server.`
                  : `Alamat: ${sub || "nama"}.${base}. Cloudflare/Caddy otomatis belum aktif — DNS & HTTPS diatur manual (tab Domain).`
            }
          >
            <div className="flex items-center gap-2">
              <input
                id="h-sub"
                value={sub}
                pattern="[a-z0-9]([a-z0-9\-]{0,61}[a-z0-9])?"
                placeholder={id || "nama"}
                onChange={(e) => {
                  setSubTouched(true);
                  setSub(e.target.value.toLowerCase());
                }}
                className={cx(inputCls, "font-mono")}
              />
              <span className="shrink-0 font-mono text-sm text-muted">.{base}</span>
            </div>
          </Field>
        )}
        <Field label={base ? "Domain lain (opsional)" : "Domain (opsional)"} htmlFor="h-domains" hint="Pisahkan dengan koma. Domain di luar zona Cloudflare harus diatur DNS-nya manual.">
          <input id="h-domains" name="domains" placeholder="app.example.com" className={cx(inputCls, "font-mono")} />
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
        {method === "upload" && (
          <div className="space-y-3 md:col-span-2">
            {looseFiles && (
              <div role="radiogroup" aria-label="Jenis upload" className="flex flex-wrap gap-2">
                {(
                  [
                    ["zip", "ZIP"],
                    ["folder", "Folder"],
                    ["files", "File"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    role="radio"
                    aria-checked={source === key}
                    disabled={m.busy}
                    onClick={() => {
                      setSource(key);
                      setZip(null);
                      setPicked({ files: [], ignored: 0 });
                      if (fileRef.current) fileRef.current.value = "";
                    }}
                    className={cx("rounded-lg border px-3 py-1.5 text-sm", source === key ? "border-primary bg-primary/10 text-ink" : "border-line text-ink-2 hover:bg-surface")}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            <Field
              label={activeSource === "zip" ? "File ZIP (opsional — bisa diunggah nanti)" : activeSource === "folder" ? "Folder website" : "File website"}
              htmlFor="h-upload"
              hint={runtime === "static" ? "Jika dipilih, situs langsung online setelah dibuat." : "Isi proyek dalam ZIP; build berjalan otomatis di sandbox."}
            >
              <input
                key={activeSource}
                ref={fileRef}
                id="h-upload"
                type="file"
                {...(activeSource === "zip" ? { accept: ".zip,application/zip" } : {})}
                {...(activeSource === "files" ? { multiple: true } : {})}
                {...(activeSource === "folder" ? ({ webkitdirectory: "", multiple: true } as object) : {})}
                onChange={(e) => {
                  if (activeSource === "zip") setZip(e.target.files?.[0] ?? null);
                  else setPicked(pick(e.target.files));
                }}
                className={cx(inputCls, "file:mr-3 file:rounded-md file:border-0 file:bg-surface file:px-3 file:py-1 file:text-sm file:text-ink")}
              />
            </Field>
            {activeSource !== "zip" && picked.files.length > 0 && (
              <p className="text-xs text-ink-2">
                {picked.files.length} file · {bytes(picked.files.reduce((n, f) => n + f.file.size, 0))}
                {picked.ignored > 0 && ` · ${picked.ignored} dilewati (.git, node_modules, .env)`}
              </p>
            )}
            {missingIndex && (
              <p role="alert" className="text-sm text-bad">
                index.html tidak ditemukan di pilihan Anda.
              </p>
            )}
            {progress && (
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
            )}
          </div>
        )}
        {notice && <p className="rounded-lg bg-warn/10 px-3 py-2 text-sm md:col-span-2">{notice}</p>}
        <div className="flex flex-col gap-3 md:col-span-2 md:flex-row md:items-center md:justify-between">
          <InlineError message={m.error} />
          <div className="flex gap-2 md:ml-auto">
            <Button type="button" variant="ghost" onClick={onClose}>
              Batal
            </Button>
            <Button type="submit" icon={hasFiles ? Rocket : Plus} disabled={m.busy || !id || !name || missingIndex}>
              {m.busy ? (stage ?? "Memproses…") : hasFiles ? "Buat & deploy" : "Buat aplikasi"}
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
  const overview = usePoll<HostingOverview>("/hosting/overview", 300_000);
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
      {creating && runtimes.data && <CreateForm runtimes={runtimes.data} overview={overview.data} onClose={() => setCreating(false)} />}

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
