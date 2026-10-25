import { createApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { loadApplications, loadServices } from "./config/files.js";
import { SimulatedExecutor, SystemdExecutor } from "./hosting/executor.js";
import { HostingPaths } from "./hosting/paths.js";
import { HostingService } from "./hosting/service.js";
import { EventLog } from "./lib/events.js";
import { mockSources } from "./mock.js";
import { realSources } from "./sources.js";

async function main() {
  const env = loadEnv();
  const services = loadServices(env.CONFIG_DIR);
  const apps = loadApplications(env.CONFIG_DIR);
  const events = new EventLog();

  const sources = env.MOCK_MODE
    ? mockSources(services, apps)
    : realSources({
        services,
        apps,
        netdataUrl: env.NETDATA_URL,
        netdataTimeoutMs: env.NETDATA_TIMEOUT_MS,
        sharedPath: env.SHARED_PATH,
        events,
      });

  let hosting: HostingService | undefined;
  if (env.HOSTING_ENABLED) {
    // Real builds/units only on the server; development falls back to simulation.
    const kind = env.HOSTING_EXECUTOR ?? (env.MOCK_MODE || process.platform !== "linux" ? "simulated" : "systemd");
    const paths = new HostingPaths(env.HOSTING_ROOT);
    const executor = kind === "systemd" ? new SystemdExecutor() : new SimulatedExecutor(paths);
    hosting = new HostingService({ env, events, executor });
    await hosting.init();
  }

  const app = createApp(env, sources, events, hosting);
  const server = app.listen(env.API_PORT, env.API_HOST, () => {
    console.log(
      `[api] listening on http://${env.API_HOST}:${env.API_PORT} (${env.MOCK_MODE ? "MOCK data" : "live data"}, ` +
        `${services.length} services, ${apps.length} applications)`,
    );
    events.add("info", "system", `Dashboard API started${env.MOCK_MODE ? " in mock mode" : ""}`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
