import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  CircleSlash,
  Inbox,
  RefreshCw,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { clock } from "@/lib/format";
import type { AppHealth, ServiceState } from "@/lib/types";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Card({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <section
      className={cx(
        "enter rounded-card border border-line bg-surface/85 p-4 shadow-card backdrop-blur-sm sm:p-5",
        className,
      )}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      {children}
    </section>
  );
}

export function CardTitle({
  icon: Icon,
  title,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium tracking-wide text-ink-2">
        {Icon && <Icon className="size-4 text-muted" aria-hidden />}
        {title}
      </h2>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-[2.25rem] sm:leading-tight">{title}</h1>
        {description && <p className="mt-1 max-w-[72ch] text-sm text-muted">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden />;
}

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" role="status" aria-label="Memuat">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-lg border border-bad/30 bg-bad/5 p-4 text-sm">
      <p className="flex items-center gap-2 text-ink">
        <AlertTriangle className="size-4 shrink-0 text-bad" aria-hidden />
        <span>
          <span className="font-medium">Gagal memuat.</span> {message}
        </span>
      </p>
      {onRetry && (
        <Button variant="ghost" onClick={onRetry} icon={RefreshCw}>
          Coba lagi
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ icon: Icon = Inbox, title, children }: { icon?: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-surface-2">
        <Icon className="size-6 text-muted" aria-hidden />
      </span>
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  icon: Icon,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost"; icon?: LucideIcon }) {
  return (
    <button
      {...props}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-[0.75rem] px-4 py-2.5 text-sm font-semibold transition duration-200 active:translate-y-px disabled:pointer-events-none disabled:opacity-50",
        variant === "primary"
          ? "bg-primary text-white hover:bg-primary-hover hover:shadow-lg hover:shadow-primary/20"
          : "border-[1.5px] border-line-strong text-primary hover:bg-surface-2",
        className,
      )}
    >
      {Icon && <Icon className="size-4" aria-hidden />}
      {children}
    </button>
  );
}

const SERVICE_STATE: Record<ServiceState, { label: string; icon: LucideIcon; tone: string }> = {
  active: { label: "Aktif", icon: CheckCircle2, tone: "text-ok bg-ok/10 border-ok/30" },
  inactive: { label: "Tidak aktif", icon: CircleSlash, tone: "text-warn bg-warn/10 border-warn/30" },
  failed: { label: "Gagal", icon: XCircle, tone: "text-bad bg-bad/10 border-bad/30" },
  unknown: { label: "Tidak diketahui", icon: CircleHelp, tone: "text-unknown bg-unknown/10 border-unknown/30" },
};

const APP_HEALTH: Record<AppHealth, { label: string; icon: LucideIcon; tone: string }> = {
  up: { label: "Online", icon: CheckCircle2, tone: SERVICE_STATE.active.tone },
  down: { label: "Offline", icon: XCircle, tone: SERVICE_STATE.failed.tone },
  unchecked: { label: "Tidak dicek", icon: CircleHelp, tone: SERVICE_STATE.unknown.tone },
};

function Badge({ label, icon: Icon, tone }: { label: string; icon: LucideIcon; tone: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", tone)}>
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

export const ServiceBadge = ({ state }: { state: ServiceState }) => <Badge {...SERVICE_STATE[state]} />;
export const HealthBadge = ({ health }: { health: AppHealth }) => <Badge {...APP_HEALTH[health]} />;

const BAR_TONE = { ok: "bg-primary", warn: "bg-warn", bad: "bg-bad", unknown: "bg-unknown" } as const;

/** Usage bar. Level is also conveyed in text next to it, never by color alone. */
export function UsageBar({ value, tone, label }: { value: number | null; tone: keyof typeof BAR_TONE; label: string }) {
  const width = value === null ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-2"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value ?? undefined}
      aria-valuetext={value === null ? "N/A" : `${value.toFixed(0)}%`}
    >
      <div className={cx("h-full rounded-full transition-[width] duration-500", BAR_TONE[tone])} style={{ width: `${width}%` }} />
    </div>
  );
}

export function UpdatedAt({ at, error }: { at: string | null; error?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      {error ? <AlertTriangle className="size-3.5 text-warn" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
      {error ? "Data terakhir " : "Diperbarui "}
      <time className="font-mono">{clock(at)}</time>
    </span>
  );
}

export function KeyValue({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 text-sm last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className={cx("text-right text-ink", mono && "font-mono")}>{value}</dd>
    </div>
  );
}

export { cx };
