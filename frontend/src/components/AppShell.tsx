"use client";

import {
  Activity,
  AppWindow,
  Bot,
  FlaskConical,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Menu,
  Rocket,
  ScrollText,
  Server,
  Settings,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, Suspense, use, useEffect, useState, type ReactNode } from "react";
import { logout } from "@/lib/api";
import { usePoll } from "@/lib/usePoll";
import { cx } from "./ui";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  soon?: boolean;
}

const NAV: NavItem[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/monitoring", label: "Monitoring", icon: Activity },
  { href: "/services", label: "Services", icon: Server },
  { href: "/storage", label: "Storage", icon: HardDrive },
  { href: "/applications", label: "Applications", icon: AppWindow },
  { href: "/hosting", label: "Hosting", icon: Rocket },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/ai", label: "AI & Automation", icon: Bot, soon: true },
  { href: "/settings", label: "Settings", icon: Settings },
];

interface ServerStatus {
  online: boolean | null;
  mock: boolean;
}

const StatusContext = createContext<ServerStatus>({ online: null, mock: false });
export const useServerStatus = () => use(StatusContext);

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-lg">
      <span className="grid size-9 place-items-center rounded-[0.6rem] border border-line bg-surface-2">
        <Server className="size-5 text-tertiary" aria-hidden />
      </span>
      <span className="brand-gradient text-lg font-bold tracking-tight">NIFSERVER</span>
    </Link>
  );
}

export function OnlinePill({ online }: { online: boolean | null }) {
  const Icon = online === false ? WifiOff : Wifi;
  const label = online === null ? "Memeriksa…" : online ? "Online" : "Offline";
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        online === null && "border-line text-muted",
        online === true && "border-ok/30 bg-ok/10 text-ok",
        online === false && "border-bad/30 bg-bad/10 text-bad",
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {label}
    </span>
  );
}

/**
 * usePathname() suspends while the static shell of a dynamic route (e.g.
 * /hosting/[id]) is prerendered, so the read lives in its own Suspense leaf;
 * the fallback is the same nav without the active highlight.
 */
function NavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Suspense fallback={<NavItems pathname={null} onNavigate={onNavigate} />}>
      <CurrentNavItems onNavigate={onNavigate} />
    </Suspense>
  );
}

function CurrentNavItems({ onNavigate }: { onNavigate?: () => void }) {
  return <NavItems pathname={usePathname()} onNavigate={onNavigate} />;
}

function NavItems({ pathname, onNavigate }: { pathname: string | null; onNavigate?: () => void }) {
  return (
    <nav aria-label="Navigasi utama">
      <ul className="space-y-1">
        {NAV.map(({ href, label, icon: Icon, soon }) => {
          const active = pathname !== null && (href === "/" ? pathname === "/" : pathname.startsWith(href));
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  active ? "bg-primary/12 font-medium text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                  soon && !active && "text-muted",
                )}
              >
                {active && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary" aria-hidden />}
                <Icon className={cx("size-4", active ? "text-primary" : "")} aria-hidden />
                <span className="flex-1">{label}</span>
                {soon && (
                  <span className="rounded-full border border-line px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-muted">
                    Segera
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function LogoutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void logout();
      }}
      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-50"
    >
      <LogOut className="size-4" aria-hidden />
      Keluar
    </button>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const health = usePoll<{ status: string; mock: boolean }>("/health", 15_000);
  const status: ServerStatus = {
    online: health.loading && !health.data && !health.error ? null : !health.error && health.data?.status === "ok",
    mock: health.data?.mock ?? false,
  };
  // Nav links close the drawer themselves; Escape closes it too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <StatusContext value={status}>
      <div className="min-h-[100dvh] lg:grid lg:grid-cols-[256px_1fr]">
        {/* Desktop sidebar */}
        <aside className="sticky top-0 z-[100] hidden h-[100dvh] flex-col border-r border-line bg-surface/70 p-4 backdrop-blur-md lg:flex">
          <div className="mb-6 px-1">
            <Brand />
          </div>
          <NavList />
          <div className="mt-auto space-y-3 border-t border-line pt-4">
            <div className="px-3">
              <OnlinePill online={status.online} />
            </div>
            <LogoutButton />
          </div>
        </aside>

        {/* Mobile top bar */}
        <header className="sticky top-0 z-[100] flex items-center justify-between gap-3 border-b border-line bg-surface/80 px-4 py-3 backdrop-blur-md lg:hidden">
          <Brand />
          <div className="flex items-center gap-2">
            <OnlinePill online={status.online} />
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Buka menu"
              aria-expanded={open}
              aria-controls="mobile-nav"
              className="grid size-10 place-items-center rounded-lg text-ink-2 hover:bg-surface-2"
            >
              <Menu className="size-5" aria-hidden />
            </button>
          </div>
        </header>

        {/* Mobile drawer */}
        {open && (
          <div className="fixed inset-0 z-[200] lg:hidden">
            <button type="button" aria-label="Tutup menu" className="absolute inset-0 bg-[#05070f]/60" onClick={() => setOpen(false)} />
            <div
              id="mobile-nav"
              role="dialog"
              aria-modal="true"
              aria-label="Menu"
              className="enter absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-line bg-surface p-4"
            >
              <div className="mb-6 flex items-center justify-between">
                <Brand />
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Tutup menu"
                  className="grid size-10 place-items-center rounded-lg text-ink-2 hover:bg-surface-2"
                >
                  <X className="size-5" aria-hidden />
                </button>
              </div>
              <NavList onNavigate={() => setOpen(false)} />
              <div className="mt-auto border-t border-line pt-4">
                <LogoutButton />
              </div>
            </div>
          </div>
        )}

        <main className="mx-auto w-full min-w-0 max-w-[1280px] px-4 py-6 sm:px-6 lg:py-8">
          {status.mock && (
            <div className="mb-5 flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-sm text-ink">
              <FlaskConical className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
              <p>
                <span className="font-semibold">Mode data contoh (mock).</span> Angka di bawah ini bukan data server
                sungguhan. Set <code className="font-mono text-xs">MOCK_MODE=false</code> di server.
              </p>
            </div>
          )}
          {children}
        </main>
      </div>
    </StatusContext>
  );
}
