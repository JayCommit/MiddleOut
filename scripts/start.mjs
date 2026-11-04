import { spawnSync } from "node:child_process";
const migrated = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
  stdio: "inherit",
  env: process.env,
});
if (migrated.status !== 0) process.exit(migrated.status ?? 1);
process.env.HOST ||= "0.0.0.0";
process.env.PORT ||= "8080";
const { serve } = await import("srvx/node");
const { serveStatic } = await import("srvx/static");
const { fileURLToPath } = await import("node:url");
const { default: app } = await import("../dist/server/server.js");
serve({
  hostname: process.env.HOST,
  port: Number(process.env.PORT),
  middleware: [serveStatic({ dir: fileURLToPath(new URL("../dist/client", import.meta.url)) })],
  fetch: (request) => app.fetch(request),
});
