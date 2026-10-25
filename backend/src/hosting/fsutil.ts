import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Write-then-rename so readers (gateway, systemd) never see a half-written file. */
export async function writeFileAtomic(file: string, data: string, mode = 0o644) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const fh = await fs.open(tmp, "w", mode);
  try {
    await fh.writeFile(data, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.chmod(tmp, mode); // open() mode is masked by umask
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Serializes async critical sections (registry read-modify-write). */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface TreeStats {
  files: number;
  dirs: number;
  bytes: number;
  symlinks: string[];
}

/** Walks a tree without following symlinks. Stops early past `maxEntries`. */
export async function treeStats(root: string, maxEntries = 200_000): Promise<TreeStats> {
  const stats: TreeStats = { files: 0, dirs: 0, bytes: 0, symlinks: [] };
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) stats.symlinks.push(path.relative(root, full).split(path.sep).join("/"));
      else if (ent.isDirectory()) {
        stats.dirs++;
        stack.push(full);
      } else if (ent.isFile()) {
        stats.files++;
        stats.bytes += (await fs.lstat(full)).size;
      }
      if (stats.files + stats.dirs > maxEntries) throw new Error("Terlalu banyak file");
    }
  }
  return stats;
}

/** Makes a release tree group-writable (shared with the build user) and world-readable. */
export async function normalizeModes(root: string) {
  if (process.platform === "win32") return;
  const stack = [root];
  await fs.chmod(root, 0o2775);
  while (stack.length) {
    const dir = stack.pop()!;
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await fs.chmod(full, 0o2775);
        stack.push(full);
      } else if (ent.isFile()) {
        const { mode } = await fs.lstat(full);
        await fs.chmod(full, mode & 0o111 ? 0o775 : 0o664);
      }
    }
  }
}
