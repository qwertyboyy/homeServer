import type { ApiEnvelope } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let redirecting = false;

/** Clears the (expired) cookie, then sends the user to the login page. */
async function toLogin() {
  if (redirecting) return;
  redirecting = true;
  try {
    await fetch("/api/v1/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  } catch {
    /* ignore */
  }
  const next = window.location.pathname + window.location.search;
  window.location.href = next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}

export async function api<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<ApiEnvelope<T>> {
  const { json, headers, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      ...rest,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(headers as Record<string, string> | undefined),
      },
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
  } catch {
    throw new ApiError("Tidak dapat terhubung ke server", 0);
  }

  let body: ApiEnvelope<T> | null = null;
  try {
    body = (await res.json()) as ApiEnvelope<T>;
  } catch {
    /* non-JSON (e.g. proxy error page) */
  }

  if (res.status === 401 && !path.startsWith("/auth/login")) {
    void toLogin();
    throw new ApiError("Sesi berakhir", 401);
  }
  if (!res.ok || !body) {
    throw new ApiError(body?.error ?? (res.status >= 502 ? "API tidak merespons" : `HTTP ${res.status}`), res.status);
  }
  return body;
}

export async function logout() {
  try {
    await api("/auth/logout", { method: "POST", json: {} });
  } finally {
    window.location.href = "/login";
  }
}
