import fs from "node:fs/promises";
import type { EventLevel, EventLog } from "../lib/events.js";

export interface AuditEntry {
  time: string;
  actor: string;
  action: string;
  app: string | null;
  level: EventLevel;
  message: string;
}

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Append-only audit trail (apps changes, deploys, rollbacks, domains, service
 * actions). Callers pass fixed messages built from validated fields only —
 * never request bodies or secret values. Rotates once at 5 MB.
 */
export class AuditLog {
  constructor(
    private readonly file: string,
    private readonly events: EventLog,
  ) {}

  async record(actor: string, action: string, app: string | null, message: string, level: EventLevel = "info") {
    const entry: AuditEntry = { time: new Date().toISOString(), actor, action, app, level, message };
    this.events.add(level, "hosting", app ? `[${app}] ${message}` : message);
    try {
      const st = await fs.stat(this.file).catch(() => null);
      if (st && st.size > MAX_BYTES) await fs.rename(this.file, `${this.file}.1`);
      await fs.appendFile(this.file, JSON.stringify(entry) + "\n", { mode: 0o640 });
    } catch {
      console.error("[hosting] audit log write failed");
    }
  }

  async list(limit = 100): Promise<AuditEntry[]> {
    let raw = "";
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return [];
    }
    return raw
      .trim()
      .split("\n")
      .slice(-limit)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as AuditEntry];
        } catch {
          return [];
        }
      })
      .reverse();
  }
}
