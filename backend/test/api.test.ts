import bcrypt from "bcryptjs";
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { EventLog } from "../src/lib/events.js";
import { mockSources } from "../src/mock.js";
import { NetdataUnavailableError } from "../src/netdata/client.js";
import { parseSystemctlShow } from "../src/system/services.js";

const PASSWORD = "correct horse battery staple";
const services = [
  { name: "ssh", label: "SSH", description: "" },
  { name: "smbd", label: "Samba", description: "" },
];

let hash: string;
beforeAll(async () => {
  hash = await bcrypt.hash(PASSWORD, 4);
});

function makeApp(overrides: Partial<ReturnType<typeof mockSources>> = {}) {
  const env = loadEnv({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: hash, NODE_ENV: "test" });
  const events = new EventLog();
  const sources = { ...mockSources(services, []), ...overrides };
  return { app: createApp(env, sources, events), events };
}

async function login(app: ReturnType<typeof makeApp>["app"]) {
  const res = await request(app).post("/api/v1/auth/login").send({ username: "admin", password: PASSWORD });
  expect(res.status).toBe(200);
  return res.headers["set-cookie"] as unknown as string[];
}

describe("auth", () => {
  it("rejects private endpoints without a session", async () => {
    const { app } = makeApp();
    for (const path of ["/system/summary", "/services", "/storage", "/metrics/cpu", "/applications", "/events"]) {
      const res = await request(app).get(`/api/v1${path}`);
      expect(res.status, path).toBe(401);
      expect(res.body).toMatchObject({ data: null, error: "Authentication required" });
    }
  });

  it("keeps /health public", async () => {
    const res = await request(makeApp().app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ok");
  });

  it("rejects a wrong password without echoing it", async () => {
    const { app, events } = makeApp();
    const res = await request(app).post("/api/v1/auth/login").send({ username: "admin", password: "nope-nope" });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("nope-nope");
    expect(JSON.stringify(events.list())).not.toContain("nope-nope");
  });

  it("issues an HttpOnly SameSite cookie and allows access after login", async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    expect(cookie[0]).toMatch(/HttpOnly/);
    expect(cookie[0]).toMatch(/SameSite=Strict/);

    const res = await request(app).get("/api/v1/system/summary").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(typeof res.body.timestamp).toBe("string");
  });

  it("marks the cookie Secure only for HTTPS requests from the local proxy", async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("X-Forwarded-Proto", "https")
      .send({ username: "admin", password: PASSWORD });
    expect(res.headers["set-cookie"]![0]).toMatch(/Secure/);
    const cookie = await login(app);
    expect(cookie[0]).not.toMatch(/Secure/);
  });

  it("ends the session on logout", async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await request(app).post("/api/v1/auth/logout").set("Cookie", cookie).send({}).expect(200);
    await request(app).get("/api/v1/services").set("Cookie", cookie).expect(401);
  });

  it("refuses non-JSON form posts", async () => {
    const res = await request(makeApp().app)
      .post("/api/v1/auth/login")
      .type("form")
      .send("username=admin&password=x");
    expect(res.status).toBe(415);
  });

  it("rate-limits repeated failed logins", async () => {
    const { app } = makeApp();
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await request(app).post("/api/v1/auth/login").send({ username: "admin", password: "bad" })).status;
    }
    expect(last).toBe(429);
  });
});

describe("data endpoints", () => {
  it("only serves allowlisted metrics", async () => {
    const { app } = makeApp();
    const cookie = await login(app);
    await request(app).get("/api/v1/metrics/cpu").set("Cookie", cookie).expect(200);
    await request(app).get("/api/v1/metrics/..%2F..%2Fetc").set("Cookie", cookie).expect(404);
    await request(app).get("/api/v1/metrics/constructor").set("Cookie", cookie).expect(404);
    await request(app).get("/api/v1/metrics/cpu?range=99y").set("Cookie", cookie).expect(400);
  });

  it("returns 503 instead of crashing when Netdata is down", async () => {
    const { app } = makeApp({
      metric: async () => {
        throw new NetdataUnavailableError("down");
      },
    });
    const cookie = await login(app);
    const res = await request(app).get("/api/v1/metrics/memory").set("Cookie", cookie);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("Netdata is not available");
    // Other endpoints keep working.
    await request(app).get("/api/v1/system/summary").set("Cookie", cookie).expect(200);
  });

  it("passes unavailable values through as null (rendered as N/A)", async () => {
    const base = mockSources(services, []);
    const { app } = makeApp({
      summary: async () => ({ ...(await base.summary()), temperature: { packageCelsius: null, cores: [] } }),
    });
    const cookie = await login(app);
    const res = await request(app).get("/api/v1/system/summary").set("Cookie", cookie);
    expect(res.body.data.temperature.packageCelsius).toBeNull();
  });

  it("hides internal error details", async () => {
    const { app } = makeApp({
      services: async () => {
        throw new Error("secret path /etc/shadow");
      },
    });
    const cookie = await login(app);
    const res = await request(app).get("/api/v1/services").set("Cookie", cookie);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("shadow");
  });
});

describe("config & parsing", () => {
  it("parses systemctl show output", () => {
    const out = [
      "Id=ssh.service\nActiveState=active\nSubState=running\nResult=success\nActiveEnterTimestamp=Mon 2026-10-19 08:00:00 WIB",
      "Id=smbd.service\nActiveState=failed\nSubState=failed\nResult=exit-code\nActiveEnterTimestamp=",
    ].join("\n\n");
    const units = parseSystemctlShow(out);
    expect(units.get("ssh")?.ActiveState).toBe("active");
    expect(units.get("smbd")?.Result).toBe("exit-code");
  });

  it("refuses to start without a valid password hash", () => {
    expect(() => loadEnv({ ADMIN_USERNAME: "admin", ADMIN_PASSWORD_HASH: "plaintext" })).toThrow(/bcrypt/);
  });
});
