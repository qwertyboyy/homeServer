import crypto from "node:crypto";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Env } from "../config/env.js";
import { fail, ok } from "../lib/respond.js";
import type { HostingService } from "./service.js";

const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest();

/**
 * Endpoint for Caddy's on-demand TLS `ask` hook (see deploy/caddy/Caddyfile).
 * Caddy asks before requesting a certificate for a hostname it has never seen;
 * we answer 200 only for domains that belong to a hosted app. That keeps random
 * visitors from making the server request certificates for arbitrary names.
 *
 * Not behind the admin session (Caddy has none), so it is guarded by a shared
 * secret, answers with a bare 404 for anything else, and reveals nothing but
 * "yes" for a domain the caller already named.
 */
export function caddyRouter(service: HostingService, env: Env) {
  const router = Router();
  const expected = env.CADDY_ASK_TOKEN ? sha256(env.CADDY_ASK_TOKEN) : null;

  router.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600, // scanners hitting :443 with random names must not exhaust the API
      standardHeaders: "draft-8",
      legacyHeaders: false,
      handler: (_req, res) => fail(res, 429, "Too many requests"),
    }),
  );

  router.get("/ask", (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const domain = typeof req.query.domain === "string" ? req.query.domain.trim().toLowerCase() : "";
    // Disabled, wrong token and unknown domain are indistinguishable from outside.
    if (!expected || !crypto.timingSafeEqual(sha256(token), expected) || !service.isHostedDomain(domain)) {
      return fail(res, 404, "Not found");
    }
    ok(res, { ok: true });
  });

  return router;
}
