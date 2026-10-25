import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// systemd unit names only: letters, digits, and a few safe separators.
const serviceName = z.string().regex(/^[a-zA-Z0-9@._-]{1,64}$/, "invalid service name");

const ServicesSchema = z.object({
  services: z
    .array(
      z.object({
        name: serviceName,
        label: z.string().min(1).max(64),
        description: z.string().max(200).default(""),
      }),
    )
    .min(1)
    .max(50),
});

const ApplicationsSchema = z.object({
  applications: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9-]{1,48}$/),
        name: z.string().min(1).max(64),
        url: z.url({ protocol: /^https?$/ }),
        description: z.string().max(200).default(""),
        category: z.enum(["app", "storage", "monitoring"]).default("app"),
        // Only URLs flagged here are ever probed by the backend.
        healthCheck: z.boolean().default(false),
      }),
    )
    .max(100),
});

export type ServiceDef = z.infer<typeof ServicesSchema>["services"][number];
export type AppDef = z.infer<typeof ApplicationsSchema>["applications"][number];

function readJson<T>(file: string, schema: z.ZodType<T>): T {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid config file ${path.basename(file)}:\n${issues}`);
  }
  return parsed.data;
}

export function loadServices(configDir: string): ServiceDef[] {
  return readJson(path.join(configDir, "services.json"), ServicesSchema).services;
}

/** applications.json is local-only; falls back to the committed example. */
export function loadApplications(configDir: string): AppDef[] {
  const local = path.join(configDir, "applications.json");
  const example = path.join(configDir, "applications.example.json");
  const file = fs.existsSync(local) ? local : example;
  if (!fs.existsSync(file)) return [];
  return readJson(file, ApplicationsSchema).applications;
}
