import { api } from "./api";

export interface PickedFile {
  file: File;
  /** Path relative to the selected folder (or just the file name). */
  path: string;
}

interface Session {
  uploadId: string;
  maxFiles: number;
  maxBytes: number;
  maxFileBytes: number;
}

// Mirrors the server's ignore list (backend/src/hosting/archive.ts isSkippedPath).
const IGNORED = /(^|\/)(\.git|node_modules|__MACOSX)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db)$|(^|\/)\.env(\..*)?$/;

export function pick(list: FileList | null): { files: PickedFile[]; ignored: number } {
  const files: PickedFile[] = [];
  let ignored = 0;
  for (const file of Array.from(list ?? [])) {
    const path = (file.webkitRelativePath || file.name).replace(/\\/g, "/");
    if (IGNORED.test(path)) ignored++;
    else files.push({ file, path });
  }
  return { files, ignored };
}

/** Quick pre-check so an obviously invalid selection is not uploaded at all. The server repeats the real validation. */
export function hasIndexHtml(files: PickedFile[]) {
  if (files.length === 1 && /\.html?$/i.test(files[0].path)) return true; // a lone page is served as index.html
  return files.some((f) => f.path === "index.html" || f.path.endsWith("/index.html"));
}

export interface Progress {
  files: number;
  totalFiles: number;
  bytes: number;
  totalBytes: number;
}

/**
 * Stages every file on the server (one request per file, 4 in parallel), then
 * commits. On any failure the staging area is discarded, so nothing half-uploaded
 * stays behind and the active release is never touched.
 */
export async function uploadSite(appId: string, files: PickedFile[], onProgress: (p: Progress) => void) {
  const totalBytes = files.reduce((n, f) => n + f.file.size, 0);
  const progress: Progress = { files: 0, totalFiles: files.length, bytes: 0, totalBytes };
  onProgress({ ...progress });

  const session = (await api<Session>(`/hosting/apps/${appId}/uploads`, { method: "POST", json: {} })).data;
  if (!session) throw new Error("Respons server tidak valid");
  const { uploadId } = session;
  if (files.length > session.maxFiles) {
    await cancel(appId, uploadId);
    throw new Error(`Terlalu banyak file (${files.length}); maksimum ${session.maxFiles}`);
  }
  if (totalBytes > session.maxBytes) {
    await cancel(appId, uploadId);
    throw new Error(`Total ukuran melebihi batas ${Math.round(session.maxBytes / 1048576)} MB`);
  }

  const queue = [...files];
  let failure: unknown = null;
  async function worker() {
    for (let next = queue.shift(); next && !failure; next = queue.shift()) {
      try {
        await api(`/hosting/apps/${appId}/uploads/${uploadId}/file?path=${encodeURIComponent(next.path)}`, {
          method: "PUT",
          body: next.file,
          headers: { "Content-Type": "application/octet-stream" },
        });
        progress.files++;
        progress.bytes += next.file.size;
        onProgress({ ...progress });
      } catch (e) {
        failure ??= e;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));

  if (failure) {
    await cancel(appId, uploadId);
    throw failure;
  }
  try {
    return await api(`/hosting/apps/${appId}/uploads/${uploadId}/commit`, { method: "POST", json: {} });
  } catch (e) {
    await cancel(appId, uploadId);
    throw e;
  }
}

async function cancel(appId: string, uploadId: string) {
  try {
    await api(`/hosting/apps/${appId}/uploads/${uploadId}`, { method: "DELETE", json: {} });
  } catch {
    /* the server also discards stale sessions */
  }
}
