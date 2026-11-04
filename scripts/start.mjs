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
const server = serve({
  hostname: process.env.HOST,
  maxRequestBodySize: 12 * 1024 * 1024,
  trustProxy: false,
  port: Number(process.env.PORT),
  middleware: [serveStatic({ dir: fileURLToPath(new URL("../dist/client", import.meta.url)) })],
  fetch: (request) => app.fetch(request),
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30000);
  deadline.unref();
  try {
    await server.close();
    const embedded = await globalThis.__pgliteInstance__;
    if (embedded) await embedded.close();
    await globalThis.__pgliteReleaseLock__?.();
    process.exit(0);
  } catch (error) {
    console.error("Shutdown failed:", error.message);
    process.exit(1);
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
