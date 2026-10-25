import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

/** Thrown with a message that is safe to show to the administrator. */
export class ArchiveError extends Error {}

export interface ArchiveLimits {
  maxEntries: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  /** Max uncompressed/compressed ratio for entries over 1 MiB (zip-bomb guard). */
  maxRatio: number;
}

export const defaultLimits = (maxTotalBytes: number): ArchiveLimits => ({
  maxEntries: 20_000,
  maxTotalBytes,
  maxFileBytes: Math.min(maxTotalBytes, 100 * 1024 * 1024),
  maxRatio: 200,
});

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

/** Paths never extracted: VCS data, dependencies (installed fresh), local secrets, OS junk. */
export function isSkippedPath(rel: string): boolean {
  const parts = rel.split("/");
  const base = parts[parts.length - 1];
  if (parts.some((p) => p === ".git" || p === "node_modules" || p === "__MACOSX")) return true;
  if (base === ".DS_Store" || base === "Thumbs.db") return true;
  return /^\.env(\..*)?$/.test(base) && base !== ".env.example";
}

interface PlannedEntry {
  name: string; // relative path inside the release, after prefix stripping
  dir: boolean;
}

interface Inspection {
  entries: PlannedEntry[];
  totalBytes: number;
  strip: string | null;
  skipped: number;
}

function checkName(raw: string) {
  const name = raw.replace(/\/+$/, "");
  // eslint-disable-next-line no-control-regex
  if (!name || /[\x00-\x1f\x7f]/.test(name)) throw new ArchiveError("Nama file di arsip tidak valid");
  if (name.length > 1024 || name.split("/").some((s) => s.length > 255)) throw new ArchiveError("Nama file di arsip terlalu panjang");
  if (name.split("/").some((s) => s === "" || s === "." || s === "..")) throw new ArchiveError(`Path tidak aman di arsip: ${name.slice(0, 120)}`);
  if (/^[A-Za-z]:/.test(name)) throw new ArchiveError("Arsip berisi path absolut");
  return name;
}

async function open(file: string) {
  try {
    // strictFileNames rejects backslashes; yauzl itself rejects absolute paths and "..".
    return await yauzl.openPromise(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, decodeStrings: true });
  } catch (err) {
    throw new ArchiveError(`Arsip ZIP tidak valid: ${err instanceof Error ? err.message.slice(0, 160) : "unknown"}`);
  }
}

/** Reads only the central directory: names, types, declared sizes. Nothing is decompressed. */
export async function inspectZip(file: string, limits: ArchiveLimits): Promise<Inspection> {
  const zip = await open(file);
  if (zip.entryCount > limits.maxEntries) {
    zip.close();
    throw new ArchiveError(`Arsip berisi lebih dari ${limits.maxEntries} entri`);
  }

  const seen = new Set<string>();
  const files = new Set<string>();
  const all: PlannedEntry[] = [];
  let totalBytes = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      const name = checkName(entry.fileName);
      const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const type = unixMode & S_IFMT;
      const isDir = entry.fileName.endsWith("/") || type === S_IFDIR;

      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) {
        throw new ArchiveError(`Arsip berisi symlink atau file khusus: ${name.slice(0, 120)}`);
      }
      if (entry.isEncrypted()) throw new ArchiveError("Arsip terenkripsi tidak didukung");
      if (!isDir && entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        throw new ArchiveError("Metode kompresi ZIP tidak didukung");
      }

      const key = name.toLowerCase();
      if (seen.has(key)) throw new ArchiveError(`File duplikat di arsip: ${name.slice(0, 120)}`);
      seen.add(key);

      if (!isDir) {
        const size = entry.uncompressedSize;
        if (size > limits.maxFileBytes) throw new ArchiveError(`File terlalu besar di arsip: ${name.slice(0, 120)}`);
        if (size > 0 && entry.compressedSize === 0) throw new ArchiveError("Arsip rusak (ukuran tidak konsisten)");
        if (size > 1024 * 1024 && size / entry.compressedSize > limits.maxRatio) {
          throw new ArchiveError("Rasio kompresi mencurigakan (kemungkinan zip bomb)");
        }
        totalBytes += size;
        if (totalBytes > limits.maxTotalBytes) {
          throw new ArchiveError(`Total ukuran setelah ekstrak melebihi ${Math.round(limits.maxTotalBytes / 1048576)} MB`);
        }
        files.add(key);
      }
      all.push({ name, dir: isDir });
    }
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    // yauzl's own checks (absolute path, "..", backslash, truncated archive) land here.
    throw new ArchiveError(`Arsip ZIP ditolak: ${err instanceof Error ? err.message.slice(0, 160) : "unknown"}`);
  } finally {
    zip.close();
  }

  // A path used both as a file and as a directory would make extraction ambiguous.
  for (const e of all) {
    const parts = e.name.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) {
      if (files.has(parts.slice(0, i).join("/"))) throw new ArchiveError(`Konflik file/folder di arsip: ${e.name.slice(0, 120)}`);
    }
  }

  // Common case: the whole project was zipped as one folder — strip it.
  const tops = new Set(all.map((e) => e.name.split("/")[0]));
  const onlyTop = tops.size === 1 ? [...tops][0] : null;
  const strip = onlyTop && !files.has(onlyTop.toLowerCase()) && all.some((e) => e.name.includes("/")) ? `${onlyTop}/` : null;

  let skipped = 0;
  const entries: PlannedEntry[] = [];
  for (const e of all) {
    const rel = strip ? (e.name === onlyTop ? "" : e.name.slice(strip.length)) : e.name;
    if (!rel) continue;
    if (isSkippedPath(rel)) {
      skipped++;
      continue;
    }
    entries.push({ name: rel, dir: e.dir });
  }
  if (!entries.some((e) => !e.dir)) throw new ArchiveError("Arsip tidak berisi file");
  return { entries, totalBytes, strip, skipped };
}

/**
 * Extracts a ZIP that already passed {@link inspectZip}. Every write is re-checked
 * to stay inside `dest`, uses exclusive create (no overwrite), and yauzl enforces
 * the declared sizes while inflating.
 */
export async function extractZip(file: string, dest: string, limits: ArchiveLimits) {
  const plan = await inspectZip(file, limits);
  const wanted = new Map(plan.entries.map((e) => [e.name, e]));
  const root = path.resolve(dest);
  await fs.mkdir(root, { recursive: true });

  const zip = await open(file);
  let written = 0;
  let files = 0;
  try {
    for await (const entry of zip.eachEntry()) {
      const name = checkName(entry.fileName);
      const rel = plan.strip ? name.slice(plan.strip.length) : name;
      const planned = wanted.get(rel);
      if (!planned) continue;

      const target = path.resolve(root, ...rel.split("/"));
      if (!target.startsWith(root + path.sep)) throw new ArchiveError("Path keluar dari folder rilis");

      if (planned.dir) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(stream, createWriteStream(target, { flags: "wx", mode: 0o664 }));
      written += entry.uncompressedSize;
      files++;
      if (written > limits.maxTotalBytes) throw new ArchiveError("Total ukuran ekstrak melebihi batas");
    }
  } catch (err) {
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError(`Gagal mengekstrak arsip: ${err instanceof Error ? err.message.slice(0, 160) : "unknown"}`);
  } finally {
    zip.close();
  }
  return { files, bytes: written, skipped: plan.skipped, stripped: plan.strip };
}
