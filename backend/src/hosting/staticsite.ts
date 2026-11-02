import fs from "node:fs/promises";
import path from "node:path";

/** Thrown with a message that is safe to show to the administrator. */
export class StaticSiteError extends Error {}

/**
 * Extensions accepted for loose file / folder uploads of a static site. ZIP
 * uploads keep their previous behaviour and are not filtered by extension.
 */
export const SITE_EXTENSIONS = new Set([
  "html", "htm", "css", "js", "mjs", "map", "json", "webmanifest", "txt", "xml", "md", "csv", "pdf", "wasm",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "bmp",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp4", "webm", "mp3", "ogg", "wav", "m4a",
]);

const extOf = (name: string) => {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 || (dot === 0 && base.length > 1) ? base.slice(dot + 1).toLowerCase() : "";
};

/** Validates a client-supplied relative path (e.g. `css/app.css`) for a loose upload: no traversal, absolute or odd paths. */
export function checkUploadPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw) throw new StaticSiteError("Path file wajib diisi");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\\]/.test(raw)) throw new StaticSiteError("Nama file mengandung karakter yang tidak diizinkan");
  if (raw.length > 1024) throw new StaticSiteError("Path file terlalu panjang");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new StaticSiteError("Path absolut tidak diizinkan");
  const parts = raw.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || s.length > 255)) {
    throw new StaticSiteError(`Path tidak aman: ${raw.slice(0, 120)}`);
  }
  return raw;
}

/** Extension allowlist for loose uploads; checked after ignored paths (.git, .env, …) are filtered out. */
export function checkUploadExtension(rel: string) {
  const ext = extOf(rel);
  if (!SITE_EXTENSIONS.has(ext)) {
    throw new StaticSiteError(`Ekstensi file tidak diizinkan untuk situs statis: ${rel.slice(0, 120)}${ext ? ` (.${ext})` : ""}`);
  }
}

export interface DocRoot {
  /** Directory holding index.html, relative to the upload root ("." = the root itself). */
  root: string;
  /** Set when the only HTML file was promoted to index.html. `from` is its path relative to the upload root. */
  renamed?: { from: string };
  /** Human-readable explanation for the deployment log. */
  note: string;
}

const MAX_DEPTH = 3;
const listDirs = (dirs: string[]) => dirs.map((d) => `${d}/`).join(", ");

/**
 * Finds the document root among a list of relative file paths. Order: archive
 * root, then dist/ or build/, then the shallowest folder holding index.html.
 * Anything not clearly identifiable throws instead of guessing.
 */
export function detectDocRoot(files: string[], opts: { promoteLoneHtml?: boolean } = {}): DocRoot {
  if (!files.length) throw new StaticSiteError("Tidak ada file yang diunggah");

  if (opts.promoteLoneHtml) {
    // No index.html anywhere and exactly one HTML page: that page is the site (other files are its assets).
    const hasIndex = files.some((f) => f === "index.html" || f.endsWith("/index.html"));
    const pages = files.filter((f) => /^.+\.html?$/i.test(f) && f.split("/").length <= MAX_DEPTH + 1);
    if (!hasIndex && pages.length === 1) {
      const from = pages[0];
      const slash = from.lastIndexOf("/");
      return { root: slash < 0 ? "." : from.slice(0, slash), renamed: { from }, note: `File HTML tunggal "${from}" disajikan sebagai index.html` };
    }
  }

  const dirs = new Set<string>();
  for (const f of files) {
    if (f === "index.html") dirs.add(".");
    else if (f.endsWith("/index.html")) dirs.add(f.slice(0, -"/index.html".length));
  }
  const deep = [...dirs].filter((d) => d !== "." && d.split("/").length > MAX_DEPTH);
  for (const d of deep) dirs.delete(d);

  if (dirs.has(".")) return { root: ".", note: "index.html ditemukan di root" };

  const out = ["dist", "build"].filter((d) => dirs.has(d));
  if (out.length > 1) {
    throw new StaticSiteError(`Ditemukan beberapa folder hasil build dengan index.html (${listDirs(out)}). Sisakan satu atau letakkan index.html di root.`);
  }
  if (out.length === 1) return { root: out[0], note: `Document root: ${out[0]}/` };

  if (!dirs.size) {
    throw new StaticSiteError(
      "index.html tidak ditemukan. Letakkan index.html di root (atau di folder dist/build atau satu subfolder proyek). Nama file harus persis \"index.html\".",
    );
  }
  const depth = Math.min(...[...dirs].map((d) => d.split("/").length));
  const nearest = [...dirs].filter((d) => d.split("/").length === depth).sort();
  if (nearest.length > 1) {
    throw new StaticSiteError(`Ditemukan beberapa kandidat index.html (${listDirs(nearest)}). Sisakan satu folder situs atau letakkan index.html di root.`);
  }
  return { root: nearest[0], note: `Document root terdeteksi: ${nearest[0]}/` };
}

/** Lists regular files below `root` as `/`-separated relative paths. Does not follow symlinks. */
export async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    for (const ent of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) stack.push(child);
      else if (ent.isFile()) out.push(child);
    }
  }
  return out.sort();
}

/**
 * Makes `dir/<root>` the release root: everything outside it is removed and its
 * children are moved up. Done by rename, so it never leaves the release dir.
 */
export async function flattenDocRoot(dir: string, root: string): Promise<{ removed: number }> {
  if (root === ".") return { removed: 0 };
  const base = path.resolve(dir);
  const src = path.resolve(base, ...root.split("/"));
  if (!src.startsWith(base + path.sep)) throw new StaticSiteError("Document root di luar folder rilis");
  const holding = `${base}.docroot`;
  await fs.rm(holding, { recursive: true, force: true });
  await fs.rename(src, holding);
  try {
    const before = (await listFiles(base)).length;
    for (const ent of await fs.readdir(base)) await fs.rm(path.join(base, ent), { recursive: true, force: true });
    for (const ent of await fs.readdir(holding)) await fs.rename(path.join(holding, ent), path.join(base, ent));
    return { removed: before };
  } finally {
    await fs.rm(holding, { recursive: true, force: true });
  }
}
