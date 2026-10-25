import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSystemctlShow } from "../system/services.js";
import { writeFileAtomic } from "./fsutil.js";
import { APP_ID_RE } from "./model.js";
import type { HostingPaths } from "./paths.js";

export type UnitAction = "start" | "stop" | "restart";
export type UnitActiveState = "active" | "activating" | "deactivating" | "inactive" | "failed" | "unknown";

export interface UnitState {
  activeState: UnitActiveState;
  subState: string | null;
  since: string | null;
}

export const GATEWAY_UNIT = "nifhost-gateway.service";

// The only units the Hosting Manager may ever address. Matches the polkit rule in deploy/hosting.
const MANAGED_UNIT = /^(?:(?:nifapp|nifbuild)@[a-z][a-z0-9-]{1,30}[a-z0-9]\.service|nifhost-gateway\.service)$/;

export function unitName(kind: "app" | "build", appId: string) {
  if (!APP_ID_RE.test(appId)) throw new Error("invalid app id");
  return `${kind === "app" ? "nifapp" : "nifbuild"}@${appId}.service`;
}

export function assertManagedUnit(name: string) {
  if (!MANAGED_UNIT.test(name)) throw new Error(`refusing to touch unmanaged unit`);
  return name;
}

/**
 * Everything that crosses the privilege boundary. The real implementation only
 * runs `systemctl` with fixed verbs on template units whose instance name is a
 * validated app id; the builder reads its instructions from plan.json.
 */
export interface HostExecutor {
  readonly kind: "systemd" | "simulated";
  /** Runs nifbuild@<id> (plan.json already written). Resolves once it exits. */
  runBuilder(appId: string): Promise<{ started: boolean; detail: string | null }>;
  unitAction(appId: string, action: UnitAction): Promise<void>;
  unitStates(appIds: string[]): Promise<Map<string, UnitState>>;
  gatewayState(): Promise<UnitState>;
}

type Exec = (file: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultExec: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024, env: { LANG: "C", PATH: "/usr/bin:/bin" } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

function toState(p: Record<string, string> | undefined): UnitState {
  const raw = p?.ActiveState;
  const known: UnitActiveState[] = ["active", "activating", "deactivating", "inactive", "failed"];
  const since = p?.ActiveEnterTimestamp ? new Date(p.ActiveEnterTimestamp) : null;
  return {
    activeState: known.includes(raw as UnitActiveState) ? (raw as UnitActiveState) : "unknown",
    subState: p?.SubState || null,
    since: since && !Number.isNaN(since.getTime()) ? since.toISOString() : null,
  };
}

export class SystemdExecutor implements HostExecutor {
  readonly kind = "systemd" as const;
  /** Every argv passed to systemctl, for auditing in tests. */
  readonly calls: string[][] = [];

  constructor(private readonly exec: Exec = defaultExec) {}

  private systemctl(args: string[], unit: string, timeoutMs: number) {
    const argv = ["--no-ask-password", ...args, "--", assertManagedUnit(unit)];
    this.calls.push(argv);
    return this.exec("systemctl", argv, timeoutMs);
  }

  async runBuilder(appId: string) {
    // Type=oneshot: `start` blocks until the build finishes (RuntimeMaxSec bounds it).
    const r = await this.systemctl(["start"], unitName("build", appId), 35 * 60_000);
    return { started: true, detail: r.code === 0 ? null : r.stderr.trim().slice(0, 300) || `exit ${r.code}` };
  }

  async unitAction(appId: string, action: UnitAction) {
    const r = await this.systemctl([action], unitName("app", appId), 60_000);
    if (r.code !== 0) throw new Error(`systemctl ${action} gagal: ${r.stderr.trim().slice(0, 200) || `exit ${r.code}`}`);
  }

  private async show(units: string[]) {
    if (units.length === 0) return new Map<string, Record<string, string>>();
    units.forEach(assertManagedUnit);
    const argv = ["show", "--no-pager", "--property=Id,ActiveState,SubState,ActiveEnterTimestamp", "--", ...units];
    this.calls.push(argv);
    const r = await this.exec("systemctl", argv, 5000);
    return parseSystemctlShow(r.stdout);
  }

  async unitStates(appIds: string[]) {
    const props = await this.show(appIds.map((id) => unitName("app", id)));
    return new Map(appIds.map((id) => [id, toState(props.get(`nifapp@${id}`))]));
  }

  async gatewayState() {
    return toState((await this.show([GATEWAY_UNIT])).get("nifhost-gateway"));
  }
}

/**
 * Development stand-in (MOCK_MODE / Windows): runs nothing, fabricates the
 * minimal build output for each runtime so the UI flow can be exercised.
 */
export class SimulatedExecutor implements HostExecutor {
  readonly kind = "simulated" as const;
  private states = new Map<string, UnitState>();

  constructor(private readonly paths: HostingPaths) {}

  async runBuilder(appId: string) {
    const plan = JSON.parse(await fs.readFile(this.paths.plan(appId), "utf8"));
    const rel = this.paths.release(appId, plan.releaseId);
    const out: Record<string, string> = {};
    if (plan.phase === "fetch") {
      out["index.html"] = "<!doctype html><title>Simulated</title><h1>Simulated clone</h1>";
      out["package.json"] = JSON.stringify({ name: "simulated", scripts: { build: "true" } });
    } else if (plan.phase === "build") {
      const outDir = plan.options?.outputDir && plan.options.outputDir !== "." ? plan.options.outputDir : "dist";
      const files: Record<string, string> = {
        vite: `${outDir}/index.html`,
        nextjs: ".next/BUILD_ID",
        node: plan.options?.entry ?? "server.js",
        laravel: "vendor/autoload.php",
      };
      if (files[plan.runtime]) out[files[plan.runtime]] = "simulated";
    } else if (plan.phase === "clean") {
      await fs.rm(rel, { recursive: true, force: true });
    }
    for (const [name, body] of Object.entries(out)) {
      const file = path.join(rel, ...name.split("/"));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, body);
    }
    await fs.writeFile(this.paths.buildLog(appId), `[simulated] phase ${plan.phase}: nothing was executed\n`);
    await writeFileAtomic(this.paths.result(appId), JSON.stringify({ ok: true, phase: plan.phase, commit: plan.phase === "fetch" ? "0000000" : null }));
    return { started: true, detail: null };
  }

  async unitAction(appId: string, action: UnitAction) {
    unitName("app", appId);
    this.states.set(appId, {
      activeState: action === "stop" ? "inactive" : "active",
      subState: action === "stop" ? "dead" : "running",
      since: new Date().toISOString(),
    });
  }

  async unitStates(appIds: string[]) {
    return new Map(appIds.map((id) => [id, this.states.get(id) ?? { activeState: "inactive" as const, subState: "dead", since: null }]));
  }

  async gatewayState(): Promise<UnitState> {
    return { activeState: "active", subState: "running (simulated)", since: null };
  }
}
