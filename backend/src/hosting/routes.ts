import crypto from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import express, { Router, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { fail, ok } from "../lib/respond.js";
import {
  ActionBody,
  AppId,
  CreateAppBody,
  DatabaseBody,
  DEPLOY_ID_RE,
  DeleteBody,
  DomainsBody,
  EnvBody,
  GitTokenBody,
  GithubDeployBody,
  RollbackBody,
  RUNTIMES,
  UpdateAppBody,
} from "./model.js";
import { RUNTIME_INFO } from "./runtimes.js";
import { HostingError, type HostingService } from "./service.js";

export const HOSTING_PREFIX = "/api/v1/hosting";
/** ZIP upload: application/zip. */
export const UPLOAD_PATH = /^\/api\/v1\/hosting\/apps\/[a-z0-9-]+\/deploy\/upload$/;
/** Loose file of a file/folder upload: application/octet-stream, target path in the query. */
export const FILE_UPLOAD_PATH = /^\/api\/v1\/hosting\/apps\/[a-z0-9-]+\/uploads\/[0-9a-f-]{36}\/file$/;
const UPLOAD_ID_RE = /^[0-9a-f-]{36}$/;

/** Non-JSON bodies are only accepted on these two routes, each with a content type a cross-site form cannot send. */
export const isRawUpload = (req: Request) =>
  (req.method === "POST" && UPLOAD_PATH.test(req.path) && !!req.is("application/zip")) ||
  (req.method === "PUT" && FILE_UPLOAD_PATH.test(req.path) && !!req.is("application/octet-stream"));

const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

type Handler = (req: Request, res: Response) => Promise<void>;

function handle(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof HostingError) return fail(res, err.status, err.message);
      next(err);
    }
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HostingError(400, `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
  }
  return r.data;
}

function appId(req: Request) {
  const r = AppId.safeParse(req.params.id);
  if (!r.success) throw new HostingError(404, "Aplikasi tidak ditemukan");
  return r.data;
}

const actor = (req: Request) => req.session?.username ?? "unknown";

/** Streams the request body to disk, aborting once it exceeds `max` bytes. */
async function receiveUpload(req: Request, file: string, max: number, allowEmpty = false) {
  let seen = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > max) cb(new HostingError(413, `File melebihi batas ${Math.round(max / 1048576)} MB`));
      else cb(null, chunk);
    },
  });
  // req is piped (not part of the pipeline) so a rejection leaves the socket
  // open for drainRejected() instead of resetting it before the 413 arrives.
  const done = pipeline(limiter, createWriteStream(file, { flags: "wx", mode: 0o600 }));
  const abort = () => limiter.destroy(new Error("aborted"));
  req.once("aborted", abort);
  req.once("error", abort);
  req.pipe(limiter);
  try {
    await done;
  } catch (err) {
    req.unpipe(limiter);
    await fs.rm(file, { force: true });
    if (err instanceof HostingError) throw err;
    throw new HostingError(400, "Upload terputus");
  }
  if (seen === 0 && !allowEmpty) {
    await fs.rm(file, { force: true });
    throw new HostingError(400, "File kosong");
  }
  return seen;
}

/**
 * After an early rejection, discard the rest of the body (bounded by size and
 * time) so the client can read the error instead of hitting a TCP reset.
 */
function drainRejected(req: Request, maxBytes: number) {
  if (req.complete) return;
  let discarded = 0;
  const timer = setTimeout(() => req.socket.destroy(), 10_000).unref();
  req.on("data", (c: Buffer) => {
    discarded += c.length;
    if (discarded > maxBytes) req.socket.destroy();
  });
  req.once("end", () => clearTimeout(timer));
  req.once("close", () => clearTimeout(timer));
  req.resume();
}

/**
 * /api/v1/hosting — mounted behind requireAuth (administrator session) in app.ts.
 * Every body is validated with Zod; nothing here builds a shell command.
 */
export function hostingRouter(service: HostingService, env: Env) {
  const router = Router();
  const maxUpload = env.HOSTING_MAX_UPLOAD_MB * 1024 * 1024;

  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 60,
      // Loose files of one folder upload arrive as many requests; the per-session file limit bounds them instead.
      skip: (req) => req.method === "GET" || (req.method === "PUT" && /^\/apps\/[a-z0-9-]+\/uploads\/[0-9a-f-]{36}\/file$/.test(req.path)),
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) => fail(res, 429, "Terlalu banyak permintaan. Coba lagi sebentar."),
    }),
  );
  const deployLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: env.HOSTING_DEPLOY_LIMIT,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => fail(res, 429, "Batas deployment tercapai. Coba lagi dalam 15 menit."),
  });
  router.use(express.json({ limit: "64kb" }));

  router.get("/overview", handle(async (_req, res) => ok(res, await service.overview())));

  router.get("/runtimes", (_req, res) => ok(res, RUNTIMES.map((r) => RUNTIME_INFO[r])));

  router.get("/prerequisites", handle(async (req, res) => ok(res, await service.prerequisites(req.query.refresh === "1"))));

  router.get("/audit", handle(async (req, res) => ok(res, await service.auditList(parse(AuditQuery, req.query).limit))));

  router.get("/apps", handle(async (_req, res) => ok(res, await service.listApps())));

  router.post("/apps", handle(async (req, res) => ok(res, await service.createApp(parse(CreateAppBody, req.body), actor(req)), 201)));

  router.get("/apps/:id", handle(async (req, res) => ok(res, await service.getApp(appId(req)))));

  router.patch("/apps/:id", handle(async (req, res) => ok(res, await service.updateApp(appId(req), parse(UpdateAppBody, req.body), actor(req)))));

  router.delete(
    "/apps/:id",
    handle(async (req, res) => {
      const id = appId(req);
      if (parse(DeleteBody, req.body).confirm !== id) throw new HostingError(400, "Konfirmasi tidak cocok: ketik ID aplikasi");
      await service.deleteApp(id, actor(req), parse(DeleteBody, req.body).deleteDatabase);
      ok(res, { deleted: id });
    }),
  );

  router.post(
    "/apps/:id/actions",
    handle(async (req, res) => {
      const id = appId(req);
      const body = parse(ActionBody, req.body);
      if (body.action === "stop" && body.confirm !== id) throw new HostingError(400, "Konfirmasi tidak cocok: ketik ID aplikasi");
      ok(res, await service.action(id, body.action, actor(req)));
    }),
  );

  router.put("/apps/:id/domains", handle(async (req, res) => ok(res, await service.setDomains(appId(req), parse(DomainsBody, req.body).domains, actor(req)))));
  router.post("/apps/:id/domains/sync", handle(async (req, res) => ok(res, await service.syncDomains(appId(req), actor(req)))));
  router.get("/apps/:id/domains/status", handle(async (req, res) => ok(res, await service.domainStatus(appId(req)))));
  router.put("/apps/:id/env", handle(async (req, res) => ok(res, await service.setEnv(appId(req), parse(EnvBody, req.body), actor(req)))));
  router.put("/apps/:id/database", handle(async (req, res) => ok(res, await service.setDatabase(appId(req), parse(DatabaseBody, req.body), actor(req)))));
  router.post("/apps/:id/database/phpmyadmin-credentials", handle(async (req, res) => {
    const expected = env.PHPMYADMIN_BRIDGE_KEY;
    const provided = req.get("X-Nif-Pma-Key") ?? "";
    if (!env.PHPMYADMIN_ENABLED || !expected) throw new HostingError(404, "phpMyAdmin belum diaktifkan");
    // Local transport alone is insufficient: reverse proxies also run on loopback.
    if (!crypto.timingSafeEqual(crypto.createHash("sha256").update(provided).digest(), crypto.createHash("sha256").update(expected).digest())) {
      throw new HostingError(403, "Akses khusus bridge phpMyAdmin");
    }
    ok(res, await service.phpMyAdminCredentials(appId(req), actor(req)));
  }));
  for (const operation of ["create", "reset", "delete"] as const) {
    router.post(`/apps/:id/database/${operation}`, handle(async (req, res) => {
      const id = appId(req);
      if (operation !== "create" && parse(DeleteBody, req.body).confirm !== id) throw new HostingError(400, "Konfirmasi tidak cocok: ketik ID aplikasi");
      ok(res, await service.managedDatabase(id, operation, actor(req)));
    }));
  }
  router.post("/apps/:id/database/migrate", handle(async (req, res) => {
    const id = appId(req);
    if (parse(DeleteBody, req.body).confirm !== id) throw new HostingError(400, "Konfirmasi tidak cocok: ketik ID aplikasi");
    ok(res, await service.migrate(id, actor(req)));
  }));
  router.put("/apps/:id/git-token", handle(async (req, res) => ok(res, await service.setGitToken(appId(req), parse(GitTokenBody, req.body).token, actor(req)))));

  router.post(
    "/apps/:id/deploy/github",
    deployLimiter,
    handle(async (req, res) => {
      parse(GithubDeployBody, req.body);
      ok(res, await service.deployGithub(appId(req), actor(req)), 202);
    }),
  );

  router.post(
    "/apps/:id/deploy/upload",
    deployLimiter,
    handle(async (req, res) => {
      const id = appId(req);
      if (!req.is("application/zip")) throw new HostingError(415, "Content-Type harus application/zip");
      const file = path.join(service.paths.tmp, `${crypto.randomUUID()}.zip`);
      try {
        const declared = Number(req.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > maxUpload) {
          throw new HostingError(413, `File melebihi batas ${env.HOSTING_MAX_UPLOAD_MB} MB`);
        }
        service.requireApp(id);
        await receiveUpload(req, file, maxUpload);
      } catch (err) {
        drainRejected(req, maxUpload);
        throw err;
      }
      ok(res, await service.deployUpload(id, file, actor(req)), 202);
    }),
  );

  const uploadId = (req: Request) => {
    const v = String(req.params.uploadId);
    if (!UPLOAD_ID_RE.test(v)) throw new HostingError(404, "Sesi upload tidak ditemukan");
    return v;
  };

  router.post("/apps/:id/uploads", handle(async (req, res) => ok(res, await service.beginUpload(appId(req)), 201)));

  router.put(
    "/apps/:id/uploads/:uploadId/file",
    handle(async (req, res) => {
      const id = appId(req);
      const uid = uploadId(req);
      if (!req.is("application/octet-stream")) throw new HostingError(415, "Content-Type harus application/octet-stream");
      let staged: ReturnType<HostingService["stageFile"]> | null = null;
      try {
        staged = service.stageFile(id, uid, typeof req.query.path === "string" ? req.query.path : undefined);
        if (staged.skipped) {
          drainRejected(req, maxUpload);
          return ok(res, { path: staged.rel, skipped: true });
        }
        const declared = Number(req.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > staged.maxBytes) {
          throw new HostingError(413, `File melebihi batas ${Math.round(service.uploadLimits.maxBytes / 1048576)} MB`);
        }
        await fs.mkdir(path.dirname(staged.target), { recursive: true });
        const size = await receiveUpload(req, staged.target, staged.maxBytes, true);
        service.stagedFileDone(id, uid, staged.rel, size);
        ok(res, { path: staged.rel, size });
      } catch (err) {
        if (staged && !staged.skipped) service.stagedFileFailed(uid, staged.key);
        drainRejected(req, maxUpload);
        throw err;
      }
    }),
  );

  router.post("/apps/:id/uploads/:uploadId/commit", deployLimiter, handle(async (req, res) => ok(res, await service.deployStaged(appId(req), uploadId(req), actor(req)), 202)));

  router.delete(
    "/apps/:id/uploads/:uploadId",
    handle(async (req, res) => {
      await service.cancelUpload(appId(req), uploadId(req));
      ok(res, { cancelled: true });
    }),
  );

  router.post("/apps/:id/rollback", handle(async (req, res) => ok(res, await service.rollback(appId(req), parse(RollbackBody, req.body).releaseId, actor(req)), 202)));

  router.get(
    "/apps/:id/deployments/:deploymentId/log",
    handle(async (req, res) => {
      const did = String(req.params.deploymentId);
      if (!DEPLOY_ID_RE.test(did)) throw new HostingError(404, "Deployment tidak ditemukan");
      ok(res, { log: await service.deploymentLog(appId(req), did) });
    }),
  );

  return router;
}
