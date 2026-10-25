"use client";

import { Info, LogOut, Monitor, Moon, Palette, Sun, UserRound } from "lucide-react";
import { Button, Card, CardTitle, KeyValue, PageHeader, Skeleton, cx } from "@/components/ui";
import { logout } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { setTheme, useTheme } from "@/lib/theme";
import type { SystemSummary } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";

export default function SettingsPage() {
  const me = usePoll<{ username: string; expiresAt: string }>("/auth/me", 60_000);
  const sys = usePoll<SystemSummary>("/system/summary", 60_000);
  const theme = useTheme();

  return (
    <>
      <PageHeader title="Settings" description="Preferensi tampilan dan informasi sesi. Konfigurasi server diubah lewat file di server." />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="flex flex-col gap-4">
          <Card>
            <CardTitle icon={Palette} title="Tema" />
            <div role="radiogroup" aria-label="Tema" className="grid grid-cols-2 gap-2">
              {(
                [
                  { key: "dark", label: "Gelap", icon: Moon },
                  { key: "light", label: "Terang", icon: Sun },
                ] as const
              ).map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={theme === key}
                  onClick={() => setTheme(key)}
                  className={cx(
                    "flex items-center gap-2 rounded-lg border px-3 py-3 text-sm transition",
                    theme === key ? "border-primary bg-primary/10 font-medium" : "border-line hover:bg-surface-2",
                  )}
                >
                  <Icon className="size-4" aria-hidden />
                  {label}
                </button>
              ))}
            </div>
          </Card>

          <Card delay={100}>
            <CardTitle icon={Monitor} title="Server" />
            {sys.data ? (
              <dl>
                <KeyValue label="Hostname" value={sys.data.hostname} />
                <KeyValue label="Sistem" value={sys.data.platform} />
                <KeyValue label="CPU" value={sys.data.cpu.model ?? "N/A"} />
                <KeyValue label="Zona waktu" value={sys.data.timezone} />
                <KeyValue label="Interface" value={sys.data.network.interfaces.join(", ") || "N/A"} />
              </dl>
            ) : (
              <Skeleton className="h-40 w-full" />
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4">
          <Card delay={150}>
            <CardTitle icon={UserRound} title="Sesi" />
            {me.data ? (
              <dl className="mb-4">
                <KeyValue label="Administrator" value={me.data.username} />
                <KeyValue label="Berakhir" value={dateTime(me.data.expiresAt)} />
              </dl>
            ) : (
              <Skeleton className="mb-4 h-20 w-full" />
            )}
            <Button variant="ghost" icon={LogOut} onClick={() => void logout()} className="w-full">
              Keluar
            </Button>
          </Card>

          <Card delay={200}>
            <CardTitle icon={Info} title="Konfigurasi" />
            <ul className="space-y-2 text-sm text-ink-2">
              <li>
                Service dipantau: <code className="font-mono text-xs">config/services.json</code>
              </li>
              <li>
                Aplikasi: <code className="font-mono text-xs">config/applications.json</code>
              </li>
              <li>
                Rahasia & port: <code className="font-mono text-xs">.env</code> (tidak pernah dikirim ke browser)
              </li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
