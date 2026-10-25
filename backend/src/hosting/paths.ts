import path from "node:path";
import { APP_ID_RE, DEPLOY_ID_RE, RELEASE_ID_RE } from "./model.js";

function must(re: RegExp, value: string, what: string) {
  if (!re.test(value)) throw new Error(`invalid ${what}`);
  return value;
}

/**
 * Directory layout under HOSTING_ROOT. Every id is re-validated here so no
 * caller can turn request input into an arbitrary path.
 *
 *   registry.json  routes.json  audit.log  tmp/
 *   apps/<id>/run.env  releases/<rid>/  build/  logs/<did>.log  secrets/ (0700)
 */
export class HostingPaths {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  get registry() { return path.join(this.root, "registry.json"); }
  get routes() { return path.join(this.root, "routes.json"); }
  get audit() { return path.join(this.root, "audit.log"); }
  get tmp() { return path.join(this.root, "tmp"); }
  get apps() { return path.join(this.root, "apps"); }

  app(id: string) { return path.join(this.apps, must(APP_ID_RE, id, "app id")); }
  releases(id: string) { return path.join(this.app(id), "releases"); }
  release(id: string, rid: string) { return path.join(this.releases(id), must(RELEASE_ID_RE, rid, "release id")); }
  build(id: string) { return path.join(this.app(id), "build"); }
  plan(id: string) { return path.join(this.build(id), "plan.json"); }
  result(id: string) { return path.join(this.build(id), "result.json"); }
  buildLog(id: string) { return path.join(this.build(id), "build.log"); }
  logs(id: string) { return path.join(this.app(id), "logs"); }
  deployLog(id: string, did: string) { return path.join(this.logs(id), `${must(DEPLOY_ID_RE, did, "deployment id")}.log`); }
  secrets(id: string) { return path.join(this.app(id), "secrets"); }
  secretsFile(id: string) { return path.join(this.secrets(id), "secrets.json"); }
  runtimeEnv(id: string) { return path.join(this.secrets(id), "runtime.env"); }
  gitToken(id: string) { return path.join(this.secrets(id), "git-token"); }
  runEnv(id: string) { return path.join(this.app(id), "run.env"); }
}

/** Persistent per-app state directory inside the app's sandbox (systemd StateDirectory=nifhost/%i). */
export const appStateDir = (id: string) => `/var/lib/nifhost/${must(APP_ID_RE, id, "app id")}`;
