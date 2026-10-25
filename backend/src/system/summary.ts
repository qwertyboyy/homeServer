import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiskUsage, SystemSummary } from "./types.js";

const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
const pct = (part: number, total: number) => (total > 0 ? round((part / total) * 100) : null);

async function readText(file: string): Promise<string | null> {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

export async function diskUsage(target: string): Promise<DiskUsage> {
  try {
    const s = await fs.statfs(target);
    const total = s.blocks * s.bsize;
    const available = s.bavail * s.bsize;
    const used = (s.blocks - s.bfree) * s.bsize;
    // Same formula as `df`: used / (used + available to unprivileged users).
    return {
      path: target,
      totalBytes: total,
      usedBytes: used,
      availableBytes: available,
      usedPercent: pct(used, used + available),
    };
  } catch {
    return { path: target, totalBytes: null, usedBytes: null, availableBytes: null, usedPercent: null };
  }
}

async function readMemInfo() {
  const text = await readText("/proc/meminfo");
  if (!text) return null;
  const kb = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
    return m ? Number(m[1]) * 1024 : null;
  };
  return {
    total: kb("MemTotal"),
    available: kb("MemAvailable"),
    swapTotal: kb("SwapTotal"),
    swapFree: kb("SwapFree"),
  };
}

async function readTemperatures(): Promise<SystemSummary["temperature"]> {
  const result: SystemSummary["temperature"] = { packageCelsius: null, cores: [] };
  const base = "/sys/class/hwmon";
  let entries: string[] = [];
  try {
    entries = await fs.readdir(base);
  } catch {
    return result;
  }

  for (const entry of entries) {
    const dir = path.join(base, entry);
    const name = await readText(path.join(dir, "name"));
    if (name !== "coretemp" && name !== "k10temp") continue;

    let files: string[] = [];
    try {
      files = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files.filter((f) => /^temp\d+_input$/.test(f)).sort()) {
      const raw = await readText(path.join(dir, f));
      const label = (await readText(path.join(dir, f.replace("_input", "_label")))) ?? f;
      const celsius = raw ? Number(raw) / 1000 : NaN;
      if (!Number.isFinite(celsius)) continue;
      if (/^(Package id|Tctl|Tdie)/i.test(label)) result.packageCelsius ??= round(celsius);
      else if (/^Core/i.test(label)) result.cores.push({ label, celsius: round(celsius) });
    }
  }

  if (result.packageCelsius === null) {
    // Fallback: ACPI thermal zone exposed by the Intel package sensor.
    try {
      for (const zone of await fs.readdir("/sys/class/thermal")) {
        if (!zone.startsWith("thermal_zone")) continue;
        const type = await readText(`/sys/class/thermal/${zone}/type`);
        if (type !== "x86_pkg_temp") continue;
        const raw = await readText(`/sys/class/thermal/${zone}/temp`);
        if (raw && Number.isFinite(Number(raw))) result.packageCelsius = round(Number(raw) / 1000);
      }
    } catch {
      /* not available */
    }
  }
  return result;
}

const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|tun|tap)/;

async function readNetDev(): Promise<{ rx: number; tx: number; interfaces: string[] } | null> {
  const text = await readText("/proc/net/dev");
  if (!text) return null;
  let rx = 0;
  let tx = 0;
  const interfaces: string[] = [];
  for (const line of text.split("\n").slice(2)) {
    const [iface, rest] = line.split(":");
    if (!rest) continue;
    const name = iface.trim();
    if (VIRTUAL_IFACE.test(name)) continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    rx += cols[0];
    tx += cols[8];
    interfaces.push(name);
  }
  return { rx, tx, interfaces };
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total, at: Date.now() };
}

/**
 * Collects host metrics from Node's `os` module, `/proc` and `/sys` — no shell
 * commands. Rates (CPU %, network) are derived from the previous sample, so
 * calling it on a polling interval keeps overhead minimal.
 */
export class SystemCollector {
  private lastCpu = cpuTimes();
  private lastNet: { rx: number; tx: number; at: number } | null = null;
  private cache: { at: number; value: SystemSummary } | null = null;

  async summary(): Promise<SystemSummary> {
    // Several open tabs share one sample.
    if (this.cache && Date.now() - this.cache.at < 2000) return this.cache.value;

    const [mem, disk, temperature, net] = await Promise.all([
      readMemInfo(),
      diskUsage("/"),
      readTemperatures(),
      readNetDev(),
    ]);

    const cpu = await this.cpuUsage();
    const isLinux = process.platform === "linux";

    const memTotal = mem?.total ?? os.totalmem();
    const memAvailable = mem?.available ?? os.freemem();
    const memUsed = memTotal - memAvailable;

    const swapTotal = mem?.swapTotal ?? null;
    const swapUsed = mem && mem.swapTotal !== null && mem.swapFree !== null ? mem.swapTotal - mem.swapFree : null;

    const network: SystemSummary["network"] = { rxBytesPerSec: null, txBytesPerSec: null, interfaces: [] };
    if (net) {
      const now = Date.now();
      network.interfaces = net.interfaces;
      if (this.lastNet) {
        const secs = (now - this.lastNet.at) / 1000;
        if (secs > 0) {
          network.rxBytesPerSec = Math.max(0, Math.round((net.rx - this.lastNet.rx) / secs));
          network.txBytesPerSec = Math.max(0, Math.round((net.tx - this.lastNet.tx) / secs));
        }
      }
      this.lastNet = { rx: net.rx, tx: net.tx, at: now };
    }

    const cpus = os.cpus();
    const value: SystemSummary = {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      uptimeSeconds: Math.round(os.uptime()),
      systemTime: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cpu: {
        usagePercent: cpu,
        cores: cpus.length,
        model: cpus[0]?.model?.trim() || null,
        loadAverage: isLinux ? (os.loadavg().map((n) => round(n, 2)) as [number, number, number]) : null,
      },
      memory: {
        totalBytes: memTotal,
        usedBytes: memUsed,
        availableBytes: memAvailable,
        usedPercent: pct(memUsed, memTotal),
      },
      swap: {
        totalBytes: swapTotal,
        usedBytes: swapUsed,
        usedPercent: swapTotal === null || swapUsed === null ? null : swapTotal === 0 ? 0 : pct(swapUsed, swapTotal),
      },
      disk,
      temperature,
      network,
    };
    this.cache = { at: Date.now(), value };
    return value;
  }

  private async cpuUsage(): Promise<number | null> {
    let prev = this.lastCpu;
    // Sample is too old to be meaningful (or too fresh to be accurate): take a short one.
    if (Date.now() - prev.at > 60_000 || Date.now() - prev.at < 200) {
      prev = cpuTimes();
      await new Promise((r) => setTimeout(r, 250));
    }
    const now = cpuTimes();
    this.lastCpu = now;
    const total = now.total - prev.total;
    if (total <= 0) return null;
    return round(100 * (1 - (now.idle - prev.idle) / total));
  }
}
