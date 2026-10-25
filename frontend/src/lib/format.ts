export const NA = "N/A";

const isNum = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export function bytes(n: number | null | undefined, digits = 1): string {
  if (!isNum(n)) return NA;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function rate(n: number | null | undefined): string {
  return isNum(n) ? `${bytes(n)}/s` : NA;
}

export function percent(n: number | null | undefined, digits = 0): string {
  return isNum(n) ? `${n.toFixed(digits)}%` : NA;
}

export function celsius(n: number | null | undefined): string {
  return isNum(n) ? `${n.toFixed(0)}°C` : NA;
}

export function num(n: number | null | undefined, digits = 2): string {
  return isNum(n) ? n.toFixed(digits) : NA;
}

export function duration(seconds: number | null | undefined): string {
  if (!isNum(seconds)) return NA;
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} hari ${h} jam`;
  if (h > 0) return `${h} jam ${m} mnt`;
  return `${m} mnt`;
}

export function clock(iso: string | number | null | undefined, withSeconds = true): string {
  if (iso === null || iso === undefined) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NA;
  return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NA;
  return d.toLocaleString("id-ID", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function relative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return NA;
  const diff = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(diff)) return NA;
  if (diff < 10) return "baru saja";
  if (diff < 60) return `${diff} dtk lalu`;
  if (diff < 3600) return `${Math.floor(diff / 60)} mnt lalu`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} jam lalu`;
  return `${Math.floor(diff / 86400)} hari lalu`;
}

/** Threshold level for a usage percentage. */
export function level(p: number | null | undefined, warn = 75, bad = 90): "ok" | "warn" | "bad" | "unknown" {
  if (!isNum(p)) return "unknown";
  return p >= bad ? "bad" : p >= warn ? "warn" : "ok";
}
