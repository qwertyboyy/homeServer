"use client";

import { AlertCircle, LogIn, Server, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui";
import { ApiError, api } from "@/lib/api";

/** Only same-origin relative paths are allowed as a post-login destination. */
function safeNext() {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

const inputCls =
  "w-full rounded-lg border border-line bg-surface-2/60 px-3 py-2.5 text-ink placeholder:text-muted transition focus:border-primary focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary aria-[invalid=true]:border-bad";

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api("/auth/login", {
        method: "POST",
        json: { username: String(form.get("username") ?? ""), password: String(form.get("password") ?? "") },
      });
      window.location.href = safeNext();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 401
          ? "Username atau password salah."
          : status === 429
            ? "Terlalu banyak percobaan. Coba lagi dalam 15 menit."
            : err instanceof Error
              ? err.message
              : "Gagal masuk.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="enter w-full max-w-sm">
      <div className="mb-8 flex flex-col items-center gap-3 text-center">
        <span className="grid size-14 place-items-center rounded-2xl border border-line bg-surface shadow-card">
          <Server className="size-7 text-tertiary" aria-hidden />
        </span>
        <h1 className="brand-gradient text-3xl font-bold tracking-tight">NIFSERVER</h1>
        <p className="text-sm text-muted">Masuk sebagai administrator untuk melihat dashboard.</p>
      </div>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-card border border-line bg-surface/85 p-6 shadow-card backdrop-blur-sm"
      >
        <div className="space-y-1.5">
          <label htmlFor="username" className="block text-sm font-medium text-ink-2">
            Username
          </label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            required
            maxLength={64}
            autoFocus
            aria-invalid={!!error}
            className={inputCls}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="password" className="block text-sm font-medium text-ink-2">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            aria-invalid={!!error}
            aria-describedby={error ? "login-error" : undefined}
            className={inputCls}
          />
          {error && (
            <p id="login-error" role="alert" className="flex items-center gap-1.5 pt-1 text-sm text-bad">
              <AlertCircle className="size-4 shrink-0" aria-hidden />
              {error}
            </p>
          )}
        </div>
        <Button type="submit" disabled={busy} icon={LogIn} className="w-full">
          {busy ? "Memeriksa…" : "Masuk"}
        </Button>
      </form>

      <p className="mt-6 flex items-center justify-center gap-1.5 text-xs text-muted">
        <ShieldCheck className="size-3.5" aria-hidden />
        Akses remote juga dilindungi Cloudflare Access.
      </p>
    </div>
  );
}
