#!/usr/bin/env node
// NIFSERVER Hosting gateway — ExecStart of nifhost-gateway.service (user nifgw).
//
// One small process on 127.0.0.1:<port> that cloudflared (or Nginx) points at.
// It routes by Host header using /srv/nifhost/routes.json:
//   - static sites (HTML, Vite builds) are served straight from the active release,
//   - process apps (Next.js, Node, Laravel, PHP) are reverse-proxied to their 127.0.0.1 port.
// Serving static sites here avoids one process per site (RAM on a 4 GB host).
// Dotfiles (.env, .git), node_modules, keys, databases and lockfiles are never served.
//
// Self-contained (no npm dependencies); installed root-owned to /usr/local/lib/nifhost.

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HOST_RE = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const INTERNAL_SUFFIX = ".nifhost.internal";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".map": "application/json", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".otf": "font/otf", ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf",
  ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
};

const BLOCKED_SEGMENTS = new Set(["node_modules", "vendor"]);
const BLOCKED_FILE = /(^(package(-lock)?\.json|npm-shrinkwrap\.json|composer\.(json|lock)|yarn\.lock|pnpm-lock\.yaml|artisan)$)|\.(env|pem|key|crt|p12|pfx|sqlite3?|db|sql|log|bak|old|orig|swp|php|phtml|sh|ini|conf)$|~$/i;

/** Decodes and vets a URL path. Returns path segments, or null if the request must be refused. */
export function safeSegments(urlPath) {
  const segments = [];
  for (const raw of urlPath.split("/")) {
    if (raw === "") continue;
    let seg;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || seg.includes("\0")) return null;
    if (seg.startsWith(".") && !(segments.length === 0 && seg === ".well-known")) return null;
    if (BLOCKED_SEGMENTS.has(seg.toLowerCase())) return null;
    segments.push(seg);
  }
  if (segments.length && BLOCKED_FILE.test(segments[segments.length - 1])) return null;
  return segments;
}

export function validateRoutes(raw, root) {
  const out = new Map();
  const appsDir = path.join(root, "apps") + path.sep;
  for (const [host, r] of Object.entries(raw?.routes ?? {})) {
    if (!HOST_RE.test(host) || !r || typeof r !== "object") continue;
    const release = typeof r.release === "string" && /^r\d{14}-[a-f0-9]{6}$/.test(r.release) ? r.release : null;
    if (r.type === "static" && typeof r.root === "string" && path.resolve(r.root) === r.root && r.root.startsWith(appsDir) && !r.root.includes("..")) {
      out.set(host, { type: "static", root: r.root, spa: r.spa === true, app: String(r.app ?? ""), release });
    } else if (r.type === "proxy" && Number.isInteger(r.port) && r.port >= 1024 && r.port <= 65535) {
      out.set(host, { type: "proxy", port: r.port, app: String(r.app ?? "") });
    }
  }
  return out;
}

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

function forwardHeaders(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v;
  const prior = req.headers["x-forwarded-for"];
  headers["x-forwarded-for"] = prior ? `${prior}, ${req.socket.remoteAddress}` : req.socket.remoteAddress;
  headers["x-forwarded-proto"] = req.headers["x-forwarded-proto"] ?? "http";
  headers["x-forwarded-host"] = req.headers.host ?? "";
  return headers;
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
  res.end(body);
}

async function resolveFile(route, segments) {
  const root = await fs.realpath(route.root);
  const within = (p) => p === root || p.startsWith(root + path.sep);
  const tryPath = async (p) => {
    try {
      const real = await fs.realpath(p);
      if (!within(real)) return null; // symlink escaping the site root
      const st = await fs.stat(real);
      if (st.isDirectory()) return tryPath(path.join(real, "index.html"));
      return st.isFile() ? { file: real, st } : null;
    } catch {
      return null;
    }
  };
  const hit = await tryPath(path.join(root, ...segments));
  if (hit) return { ...hit, status: 200 };
  const last = segments[segments.length - 1] ?? "";
  if (route.spa && !path.extname(last)) {
    const index = await tryPath(path.join(root, "index.html"));
    if (index) return { ...index, status: 200 };
  }
  const notFound = await tryPath(path.join(root, "404.html"));
  return notFound ? { ...notFound, status: 404 } : null;
}

async function serveStatic(route, req, res) {
  // Lets the dashboard's health check confirm WHICH release answered (internal hosts only).
  if (route.release && String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "").endsWith(INTERNAL_SUFFIX)) {
    res.setHeader("X-Nifhost-Release", route.release);
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
  // Vet the raw path: URL normalization would silently resolve encoded "..".
  const rawPath = (req.url ?? "/").split(/[?#]/)[0];
  const segments = rawPath.startsWith("/") ? safeSegments(rawPath) : null;
  if (!segments) return send(res, 404, "Not found");
  const hit = await resolveFile(route, segments);
  if (!hit) return send(res, 404, "Not found");
  const etag = `"${hit.st.size.toString(16)}-${Math.floor(hit.st.mtimeMs).toString(16)}"`;
  const ext = path.extname(hit.file).toLowerCase();
  const immutable = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp|avif)$/.test(hit.file);
  const headers = {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Content-Length": hit.st.size,
    ETag: etag,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "SAMEORIGIN",
  };
  if (hit.status === 200 && req.headers["if-none-match"] === etag) {
    res.writeHead(304, { ETag: etag, "Cache-Control": headers["Cache-Control"] });
    return res.end();
  }
  res.writeHead(hit.status, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(hit.file).on("error", () => res.destroy()).pipe(res);
}

function proxy(route, req, res) {
  const upstream = http.request(
    { host: "127.0.0.1", port: route.port, method: req.method, path: req.url, headers: forwardHeaders(req), timeout: 60_000 },
    (up) => {
      const headers = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k)) headers[k] = v;
      res.writeHead(up.statusCode ?? 502, headers);
      up.pipe(res);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
  upstream.on("error", (e) => (res.headersSent ? res.destroy() : send(res, e.message === "timeout" ? 504 : 502, "Aplikasi tidak merespons")));
  req.pipe(upstream);
}

function proxyUpgrade(route, req, socket, head) {
  const up = net.connect(route.port, "127.0.0.1", () => {
    const headers = { ...forwardHeaders(req), connection: "Upgrade", upgrade: req.headers.upgrade ?? "websocket" };
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (const [k, v] of Object.entries(headers)) for (const val of [].concat(v)) lines.push(`${k}: ${String(val).replace(/[\r\n]/g, "")}`);
    up.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket).pipe(up);
  });
  const close = () => (up.destroy(), socket.destroy());
  up.on("error", close);
  socket.on("error", close);
  up.setTimeout(10 * 60_000, close);
}

export function createGateway({ root, getRoutes }) {
  const hostOf = (req) => String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
  const server = http.createServer((req, res) => {
    if (req.url === "/__nifhost/healthz") return send(res, 200, "ok");
    const route = getRoutes().get(hostOf(req));
    if (!route) return send(res, 404, "Situs tidak ditemukan");
    if (route.type === "static") serveStatic(route, req, res).catch(() => (res.headersSent ? res.destroy() : send(res, 500, "Error")));
    else proxy(route, req, res);
  });
  server.on("upgrade", (req, socket, head) => {
    const route = getRoutes().get(hostOf(req));
    if (!route || route.type !== "proxy") return socket.destroy();
    proxyUpgrade(route, req, socket, head);
  });
  server.headersTimeout = 20_000;
  server.requestTimeout = 120_000;
  return server;
}

async function main() {
  const root = process.env.NIFHOST_ROOT || "/srv/nifhost";
  const port = Number(process.env.NIFHOST_GATEWAY_PORT || 8090);
  const file = path.join(root, "routes.json");
  let routes = new Map();
  let mtime = 0;
  const reload = async () => {
    try {
      const st = await fs.stat(file);
      if (st.mtimeMs === mtime) return;
      routes = validateRoutes(JSON.parse(await fs.readFile(file, "utf8")), root);
      mtime = st.mtimeMs;
      console.log(`gateway: ${routes.size} host(s) loaded`);
    } catch (e) {
      if (e.code !== "ENOENT") console.error(`gateway: routes.json not loaded (${e.message})`);
    }
  };
  await reload();
  setInterval(reload, 1000).unref();
  createGateway({ root, getRoutes: () => routes }).listen(port, "127.0.0.1", () => console.log(`gateway: listening on 127.0.0.1:${port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`gateway: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
