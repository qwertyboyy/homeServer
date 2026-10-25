import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { z } from "zod";
import { authRouter, requireAuth } from "./auth/routes.js";
import { SessionStore } from "./auth/sessions.js";
import type { Env } from "./config/env.js";
import { HOSTING_PREFIX, UPLOAD_PATH, hostingRouter } from "./hosting/routes.js";
import type { HostingService } from "./hosting/service.js";
import type { EventLog } from "./lib/events.js";
import { fail, ok } from "./lib/respond.js";
import { METRIC_CHARTS, NetdataUnavailableError, type MetricName } from "./netdata/client.js";
import type { DataSources } from "./sources.js";

const RANGES = { "5m": 300, "15m": 900, "1h": 3600, "6h": 21600 } as const;
const MetricQuery = z.object({
  range: z.enum(Object.keys(RANGES) as [keyof typeof RANGES]).default("15m"),
});
const EventsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });

const FILE_SERVICES = new Set(["apache2", "smbd"]);

export function createApp(env: Env, sources: DataSources, events: EventLog, hosting?: HostingService) {
  const app = express();
  const sessions = new SessionStore(env.SESSION_TTL_HOURS * 3600_000);

  app.disable("x-powered-by");
  // Requests arrive through local reverse proxies (Nginx / Next.js / cloudflared).
  app.set("trust proxy", "loopback");
  app.use(helmet());
  // Hosting routes parse their own (larger) JSON bodies and the ZIP upload stream.
  const smallJson = express.json({ limit: "10kb" });
  app.use((req, res, next) => (req.path.startsWith(HOSTING_PREFIX) ? next() : smallJson(req, res, next)));
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    // Mutating requests must be JSON: blocks cross-site HTML form posts (CSRF).
    // The ZIP upload is the one exception; application/zip cannot be sent
    // cross-site without a CORS preflight, which this API never allows.
    const zipUpload = req.method === "POST" && UPLOAD_PATH.test(req.path) && req.is("application/zip");
    if (req.method !== "GET" && req.method !== "HEAD" && !req.is("application/json") && !zipUpload) {
      return fail(res, 415, "Content-Type must be application/json");
    }
    next();
  });

  const api = express.Router();

  api.get("/health", (_req, res) => ok(res, { status: "ok", mock: sources.mock }));

  api.use("/auth", authRouter(env, sessions, events));

  // Everything below requires an authenticated session.
  api.use(requireAuth(sessions));

  api.get("/system/summary", async (_req, res) => ok(res, await sources.summary()));

  api.get("/services", async (_req, res) => ok(res, await sources.services()));

  api.get("/storage", async (_req, res) => {
    const [volumes, services, apps] = await Promise.all([
      sources.volumes(),
      sources.services(),
      sources.applications(),
    ]);
    ok(res, {
      volumes,
      fileServices: services.filter((s) => FILE_SERVICES.has(s.name)),
      shortcuts: apps.filter((a) => a.category === "storage"),
    });
  });

  api.get("/metrics/:name", async (req, res) => {
    const name = String(req.params.name);
    if (!Object.hasOwn(METRIC_CHARTS, name)) return fail(res, 404, "Unknown metric");
    const q = MetricQuery.safeParse(req.query);
    if (!q.success) return fail(res, 400, "Invalid range");
    try {
      ok(res, await sources.metric(name as MetricName, RANGES[q.data.range], 90));
    } catch (err) {
      if (err instanceof NetdataUnavailableError) return fail(res, 503, "Netdata is not available");
      throw err;
    }
  });

  api.get("/applications", async (_req, res) => ok(res, await sources.applications()));

  api.get("/events", (req, res) => {
    const q = EventsQuery.safeParse(req.query);
    if (!q.success) return fail(res, 400, "Invalid limit");
    ok(res, events.list(q.data.limit));
  });

  if (hosting) api.use("/hosting", hostingRouter(hosting, env));

  app.use("/api/v1", api);

  app.use((_req, res) => fail(res, 404, "Not found"));

  // Public message only — never a stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err && typeof err === "object" && "type" in err && err.type === "entity.parse.failed") {
      return fail(res, 400, "Malformed JSON body");
    }
    if (err && typeof err === "object" && "type" in err && err.type === "entity.too.large") {
      return fail(res, 413, "Request body too large");
    }
    console.error("[api] unhandled error:", err instanceof Error ? err.message : "unknown");
    fail(res, 500, "Internal server error");
  });

  return app;
}
