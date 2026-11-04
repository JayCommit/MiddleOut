import {
  maxRequestBytes,
  maxObjectBytes,
  accountQuotaBytes,
  maintenanceSeconds,
} from "./runtime-config.mjs";
import { randomUUID } from "node:crypto";
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
process.env.MIDDLEOUT_BOOTSTRAP = "true";
if (process.argv[2] === "--reset-password") {
  if (!process.argv[3] || process.argv.length !== 4)
    throw new Error("Usage: npm run admin:reset -- email@example.com");
  process.env.MIDDLEOUT_RESET_EMAIL = process.argv[3];
} else {
  delete process.env.MIDDLEOUT_RESET_EMAIL;
}
console.log(
  `Middle Out public origin: ${new URL(process.env.BETTER_AUTH_URL || "http://localhost:8080").origin} (must match your browser scheme, hostname and port)`,
);
const { default: app } = await import("../dist/server/server.js");
const initialized = await app.fetch(
  new Request(`${process.env.BETTER_AUTH_URL || "http://localhost:8080"}/api/auth/get-session`),
);
if (!initialized.ok) throw new Error("Administrator initialization failed");
if (process.env.MIDDLEOUT_RESET_EMAIL) {
  await (await globalThis.__pgliteInstance__)?.close();
  await globalThis.__pgliteReleaseLock__?.();
  process.exit(0);
}
console.log(
  `Capacity: object=${maxObjectBytes} account=${accountQuotaBytes} request=${maxRequestBytes} bytes`,
);
const server = serve({
  hostname: process.env.HOST,
  maxRequestBodySize: maxRequestBytes,
  trustProxy: false,
  port: Number(process.env.PORT),
  middleware: [
    async (request, next) => {
      const response = await next();
      if (response?.headers) {
        if (!response.headers.has("x-content-type-options"))
          response.headers.set("x-content-type-options", "nosniff");
        if (!response.headers.has("referrer-policy"))
          response.headers.set("referrer-policy", "no-referrer");
        if (!response.headers.has("x-frame-options"))
          response.headers.set("x-frame-options", "DENY");
      }
      return response;
    },
    serveStatic({ dir: fileURLToPath(new URL("../dist/client", import.meta.url)) }),
  ],
  fetch: async (request) => {
    const id = randomUUID();
    try {
      const response = await app.fetch(request);
      response.headers.set("x-request-id", id);
      if (!response.headers.has("x-content-type-options"))
        response.headers.set("x-content-type-options", "nosniff");
      if (!response.headers.has("referrer-policy"))
        response.headers.set("referrer-policy", "no-referrer");
      if (!response.headers.has("x-frame-options"))
        response.headers.set("x-frame-options", "DENY");
      if (response.status >= 500)
        console.error(
          JSON.stringify({
            event: "request_failed",
            requestId: id,
            status: response.status,
            method: request.method,
          }),
        );
      return response;
    } catch {
      console.error(
        JSON.stringify({ event: "request_failed", requestId: id, method: request.method }),
      );
      return Response.json(
        { error: "Internal server error", requestId: id },
        { status: 500, headers: { "x-request-id": id } },
      );
    }
  },
});

let maintenanceRunning = false;
const maintenanceTimer = setInterval(async () => {
  if (maintenanceRunning) return;
  maintenanceRunning = true;
  try {
    await globalThis.__middleoutMaintenance__?.();
  } catch {
    console.error(JSON.stringify({ event: "maintenance_failed" }));
  } finally {
    maintenanceRunning = false;
  }
}, maintenanceSeconds * 1000);
maintenanceTimer.unref();
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(maintenanceTimer);
  const deadline = setTimeout(() => process.exit(1), 30000);
  deadline.unref();
  try {
    await server.close();
    while (maintenanceRunning) await new Promise((resolve) => setTimeout(resolve, 100));
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
