import type { AppDef } from "../config/files.js";

export type AppHealth = "up" | "down" | "unchecked";

export interface ApplicationStatus {
  id: string;
  name: string;
  url: string;
  hostname: string;
  description: string;
  category: AppDef["category"];
  health: AppHealth;
  httpStatus: number | null;
  checkedAt: string | null;
}

/**
 * Optional health probes for allowlisted application URLs only. One request per
 * app, cached for 60 s — never a port scan.
 */
export class ApplicationMonitor {
  private cache = new Map<string, { at: number; health: AppHealth; httpStatus: number | null }>();

  constructor(private readonly apps: AppDef[]) {}

  async list(): Promise<ApplicationStatus[]> {
    return Promise.all(
      this.apps.map(async (app) => {
        const probe = app.healthCheck ? await this.probe(app) : null;
        return {
          id: app.id,
          name: app.name,
          url: app.url,
          hostname: new URL(app.url).host,
          description: app.description,
          category: app.category,
          health: probe?.health ?? "unchecked",
          httpStatus: probe?.httpStatus ?? null,
          checkedAt: probe ? new Date(probe.at).toISOString() : null,
        };
      }),
    );
  }

  private async probe(app: AppDef) {
    const cached = this.cache.get(app.id);
    if (cached && Date.now() - cached.at < 60_000) return cached;

    let entry: { at: number; health: AppHealth; httpStatus: number | null };
    try {
      const res = await fetch(app.url, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(3000),
      });
      // Any response below 500 (including auth redirects/401s) means the app answers.
      entry = { at: Date.now(), health: res.status < 500 ? "up" : "down", httpStatus: res.status };
    } catch {
      entry = { at: Date.now(), health: "down", httpStatus: null };
    }
    this.cache.set(app.id, entry);
    return entry;
  }
}
