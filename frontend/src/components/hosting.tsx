"use client";

import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleDot,
  CircleHelp,
  CircleSlash,
  Copy,
  Loader,
  PackageCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import type { DeploymentRecord, HostedStatus, PrereqCheck } from "@/lib/types";
import { Button, cx } from "./ui";

export const inputCls =
  "w-full rounded-lg border border-line bg-surface-2/60 px-3 py-2 text-sm text-ink placeholder:text-muted transition focus:border-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary aria-[invalid=true]:border-bad disabled:opacity-60";

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

type Tone = { label: string; icon: LucideIcon; tone: string };
const OK = "text-ok bg-ok/10 border-ok/30";
const WARN = "text-warn bg-warn/10 border-warn/30";
const BAD = "text-bad bg-bad/10 border-bad/30";
const UNKNOWN = "text-unknown bg-unknown/10 border-unknown/30";
const INFO = "text-primary bg-primary/10 border-primary/30";

const STATUS: Record<HostedStatus, Tone> = {
  running: { label: "Berjalan", icon: CheckCircle2, tone: OK },
  starting: { label: "Memulai", icon: Loader, tone: INFO },
  stopped: { label: "Berhenti", icon: CircleSlash, tone: WARN },
  failed: { label: "Gagal", icon: XCircle, tone: BAD },
  deploying: { label: "Deploy…", icon: Loader, tone: INFO },
  not_deployed: { label: "Belum deploy", icon: CircleDot, tone: UNKNOWN },
  unknown: { label: "Tidak diketahui", icon: CircleHelp, tone: UNKNOWN },
};

const DEPLOY: Record<DeploymentRecord["status"], Tone> = {
  running: { label: "Berjalan", icon: Loader, tone: INFO },
  succeeded: { label: "Berhasil", icon: PackageCheck, tone: OK },
  failed: { label: "Gagal", icon: XCircle, tone: BAD },
  rolled_back: { label: "Dikembalikan", icon: AlertTriangle, tone: WARN },
};

const CHECK: Record<PrereqCheck["status"], Tone> = {
  ok: { label: "OK", icon: CheckCircle2, tone: OK },
  missing: { label: "Belum ada", icon: XCircle, tone: BAD },
  warning: { label: "Perhatian", icon: AlertTriangle, tone: WARN },
  unknown: { label: "Tidak diketahui", icon: CircleHelp, tone: UNKNOWN },
};

function Pill({ label, icon: Icon, tone }: Tone) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", tone)}>
      <Icon className={cx("size-3.5", Icon === Loader && "animate-spin motion-reduce:animate-none")} aria-hidden />
      {label}
    </span>
  );
}

export const StatusBadge = ({ status }: { status: HostedStatus }) => <Pill {...STATUS[status]} />;
export const DeployBadge = ({ status }: { status: DeploymentRecord["status"] }) => <Pill {...DEPLOY[status]} />;
export const CheckBadge = ({ status }: { status: PrereqCheck["status"] }) => <Pill {...CHECK[status]} />;

export function errorText(e: unknown) {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : "Terjadi kesalahan";
}

/** Runs one async mutation at a time with busy / error state. */
export function useMutation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 text-sm text-bad">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

export function CopyBlock({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-line bg-surface-2/60 p-3 pr-12 font-mono text-xs leading-relaxed text-ink-2">{text}</pre>
      <button
        type="button"
        aria-label={label ?? "Salin"}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
        className="absolute right-2 top-2 grid size-8 place-items-center rounded-md text-muted hover:bg-surface hover:text-ink"
      >
        {copied ? <Check className="size-4 text-ok" aria-hidden /> : <Copy className="size-4" aria-hidden />}
      </button>
    </div>
  );
}

/**
 * Modal confirmation. With `typeToConfirm`, the action stays disabled until the
 * user types that exact value (used for delete / stop).
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  typeToConfirm,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: (typed: string) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  const inputId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      setTyped("");
      d.showModal();
    } else if (!open && d.open) d.close();
  }, [open]);

  const ready = !typeToConfirm || typed === typeToConfirm;
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      className="z-[300] m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-line bg-surface p-5 text-ink shadow-card backdrop:bg-[#05070f]/60"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !busy) onConfirm(typed);
        }}
        className="space-y-4"
      >
        <h2 className="text-lg font-semibold">{title}</h2>
        {children && <div className="space-y-2 text-sm text-ink-2">{children}</div>}
        {typeToConfirm && (
          <Field label={`Ketik "${typeToConfirm}" untuk konfirmasi`} htmlFor={inputId}>
            <input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className={inputCls} />
          </Field>
        )}
        <InlineError message={error ?? null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Batal
          </Button>
          <Button type="submit" disabled={!ready || busy} className={danger ? "bg-bad hover:bg-bad/90 hover:shadow-bad/20" : undefined}>
            {busy ? "Memproses…" : confirmLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
