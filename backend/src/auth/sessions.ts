import crypto from "node:crypto";

interface Session {
  username: string;
  createdAt: number;
  expiresAt: number;
}

const hash = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

/**
 * Server-side session store. Only a SHA-256 of the token is kept, so a memory
 * dump does not leak usable cookies. Sessions reset when the API restarts.
 */
export class SessionStore {
  private sessions = new Map<string, Session>();
  private sweeper: NodeJS.Timeout;

  constructor(private readonly ttlMs: number) {
    this.sweeper = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.sweeper.unref();
  }

  create(username: string): { token: string; expiresAt: number } {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    this.sessions.set(hash(token), { username, createdAt: now, expiresAt });
    return { token, expiresAt };
  }

  get(token: string | undefined): Session | null {
    if (!token || token.length > 128) return null;
    const key = hash(token);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  destroy(token: string | undefined) {
    if (token) this.sessions.delete(hash(token));
  }

  private sweep() {
    const now = Date.now();
    for (const [key, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(key);
  }
}
