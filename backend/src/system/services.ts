import { execFile } from "node:child_process";
import type { ServiceDef } from "../config/files.js";
import type { EventLog } from "../lib/events.js";
import type { ServiceState, ServiceStatus } from "./types.js";

const PROPS = ["Id", "ActiveState", "SubState", "Result", "ActiveEnterTimestamp"];

function systemctlShow(names: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // Fixed binary + fixed arguments; unit names come from the validated allowlist only.
    execFile(
      "systemctl",
      ["show", "--no-pager", `--property=${PROPS.join(",")}`, "--", ...names.map((n) => `${n}.service`)],
      { timeout: 4000, maxBuffer: 64 * 1024, env: { LANG: "C", PATH: "/usr/bin:/bin" } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

function mapState(active: string | undefined): ServiceState {
  if (active === "active" || active === "reloading") return "active";
  if (active === "inactive") return "inactive";
  if (active === "failed") return "failed";
  return "unknown";
}

export function parseSystemctlShow(output: string): Map<string, Record<string, string>> {
  const units = new Map<string, Record<string, string>>();
  for (const block of output.trim().split(/\n\s*\n/)) {
    const props: Record<string, string> = {};
    for (const line of block.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    if (props.Id) units.set(props.Id.replace(/\.service$/, ""), props);
  }
  return units;
}

/** Read-only service health for the configured allowlist. Cached for a few seconds. */
export class ServiceMonitor {
  private cache: { at: number; value: ServiceStatus[] } | null = null;
  private lastStates = new Map<string, ServiceState>();

  constructor(
    private readonly services: ServiceDef[],
    private readonly events: EventLog,
  ) {}

  async status(): Promise<ServiceStatus[]> {
    if (this.cache && Date.now() - this.cache.at < 4000) return this.cache.value;

    const checkedAt = new Date().toISOString();
    let units = new Map<string, Record<string, string>>();
    let globalError: string | null = null;
    try {
      units = parseSystemctlShow(await systemctlShow(this.services.map((s) => s.name)));
    } catch {
      globalError = "systemctl not available";
    }

    const value = this.services.map<ServiceStatus>((svc) => {
      const p = units.get(svc.name);
      const state = mapState(p?.ActiveState);
      const since = p?.ActiveEnterTimestamp ? new Date(p.ActiveEnterTimestamp) : null;
      let detail = globalError;
      if (p && p.Result && p.Result !== "success") detail = `Last result: ${p.Result}`;
      else if (p && p.ActiveState && state === "unknown") detail = `State: ${p.ActiveState}`;
      return {
        name: svc.name,
        label: svc.label,
        description: svc.description,
        state,
        subState: p?.SubState || null,
        since: since && !Number.isNaN(since.getTime()) ? since.toISOString() : null,
        detail,
        checkedAt,
      };
    });

    this.recordTransitions(value);
    this.cache = { at: Date.now(), value };
    return value;
  }

  recordTransitions(statuses: ServiceStatus[]) {
    for (const s of statuses) {
      const prev = this.lastStates.get(s.name);
      if (prev && prev !== s.state) {
        const level = s.state === "active" ? "info" : s.state === "failed" ? "error" : "warning";
        this.events.add(level, "service", `${s.label} changed from ${prev} to ${s.state}`);
      } else if (!prev && s.state !== "active") {
        this.events.add("warning", "service", `${s.label} is ${s.state}`);
      }
      this.lastStates.set(s.name, s.state);
    }
  }
}
