import fs from "node:fs/promises";
import { Mutex, writeFileAtomic } from "./fsutil.js";
import { RegistryFile, type AppRecord } from "./model.js";

const MAX_DEPLOYMENTS = 30;

/** Insert collided with an existing id or port (message is safe to show). */
export class RegistryConflict extends Error {}

/**
 * App metadata in a single JSON file (no secrets). Reads are served from memory;
 * every change is validated against the schema and written atomically.
 */
export class Registry {
  private data: RegistryFile = { version: 1, apps: [] };
  private mutex = new Mutex();

  constructor(private readonly file: string) {}

  async load() {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return this.save(this.data);
      throw err;
    }
    const parsed = RegistryFile.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const where = parsed.error.issues.slice(0, 3).map((i) => i.path.join(".")).join(", ");
      throw new Error(`registry.json tidak valid (${where}); perbaiki atau pulihkan dari backup`);
    }
    this.data = parsed.data;
  }

  list(): AppRecord[] {
    return this.data.apps.map((a) => structuredClone(a));
  }

  get(id: string): AppRecord | null {
    const app = this.data.apps.find((a) => a.id === id);
    return app ? structuredClone(app) : null;
  }

  private async save(next: RegistryFile) {
    const valid = RegistryFile.parse(next);
    await writeFileAtomic(this.file, JSON.stringify(valid, null, 2) + "\n", 0o640);
    this.data = valid;
  }

  /** Read-modify-write under a lock. Return null from `fn` to delete the app. */
  update(id: string, fn: (app: AppRecord) => AppRecord | null): Promise<AppRecord | null> {
    return this.mutex.run(async () => {
      const idx = this.data.apps.findIndex((a) => a.id === id);
      if (idx < 0) throw new Error("app not found");
      const changed = fn(structuredClone(this.data.apps[idx]));
      const apps = [...this.data.apps];
      if (changed) {
        changed.updatedAt = new Date().toISOString();
        changed.deployments = changed.deployments.slice(-MAX_DEPLOYMENTS);
        apps[idx] = changed;
      } else apps.splice(idx, 1);
      await this.save({ ...this.data, apps });
      return changed ? structuredClone(changed) : null;
    });
  }

  insert(app: AppRecord): Promise<void> {
    return this.mutex.run(async () => {
      if (this.data.apps.some((a) => a.id === app.id)) throw new RegistryConflict("ID aplikasi sudah dipakai");
      // Ports are allocated before this lock is taken; re-check so two creates cannot share one.
      if (app.port !== null && this.data.apps.some((a) => a.port === app.port)) throw new RegistryConflict("Port sedang dialokasikan; coba lagi");
      await this.save({ ...this.data, apps: [...this.data.apps, app] });
    });
  }
}
