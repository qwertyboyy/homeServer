import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { Router, type CookieOptions, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { EventLog } from "../lib/events.js";
import { fail, ok } from "../lib/respond.js";
import type { SessionStore } from "./sessions.js";

export const SESSION_COOKIE = "nif_session";

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

declare module "express-serve-static-core" {
  interface Request {
    session?: { username: string; expiresAt: number };
  }
}

export function requireAuth(sessions: SessionStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const session = sessions.get(req.cookies?.[SESSION_COOKIE]);
    if (!session) return fail(res, 401, "Authentication required");
    req.session = { username: session.username, expiresAt: session.expiresAt };
    next();
  };
}

function safeEqual(a: string, b: string) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function authRouter(env: Env, sessions: SessionStore, events: EventLog) {
  const router = Router();

  const cookieOptions = (req: Request): CookieOptions => ({
    httpOnly: true,
    secure: env.COOKIE_SECURE === "auto" ? req.secure : env.COOKIE_SECURE === "true",
    sameSite: "strict",
    path: "/",
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    skipSuccessfulRequests: true,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => {
      events.add("warning", "auth", "Login rate limit reached");
      fail(res, 429, "Too many login attempts. Try again later.");
    },
  });

  router.post("/login", loginLimiter, async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, "Username and password are required");

    const { username, password } = parsed.data;
    // Always run bcrypt so response time does not reveal whether the username exists.
    const passwordOk = await bcrypt.compare(password, env.ADMIN_PASSWORD_HASH);
    const userOk = safeEqual(username, env.ADMIN_USERNAME);

    if (!passwordOk || !userOk) {
      events.add("warning", "auth", "Failed login attempt");
      return fail(res, 401, "Invalid username or password");
    }

    const { token, expiresAt } = sessions.create(env.ADMIN_USERNAME);
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), expires: new Date(expiresAt) });
    events.add("info", "auth", "Administrator signed in");
    ok(res, { username: env.ADMIN_USERNAME, expiresAt: new Date(expiresAt).toISOString() });
  });

  router.post("/logout", (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (sessions.get(token)) events.add("info", "auth", "Administrator signed out");
    sessions.destroy(token);
    res.clearCookie(SESSION_COOKIE, cookieOptions(req));
    ok(res, { loggedOut: true });
  });

  router.get("/me", requireAuth(sessions), (req, res) => {
    ok(res, {
      username: req.session!.username,
      expiresAt: new Date(req.session!.expiresAt).toISOString(),
    });
  });

  return router;
}
