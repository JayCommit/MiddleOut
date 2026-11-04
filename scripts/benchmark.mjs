import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir, cpus, totalmem, platform } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
const directory = mkdtempSync(join(tmpdir(), "middleout-benchmark-"));
process.env.DATA_DIR = directory;
process.env.DATABASE_URL = "";
function disk(path) {
  return readdirSync(path).reduce((n, name) => {
    const p = join(path, name);
    return n + (statSync(p).isDirectory() ? disk(p) : statSync(p).size);
  }, 0);
}
const q = await import("../src/lib/storage/queries.server.ts");
const { getPglite } = await import("../src/lib/db.ts");
let server;
let databaseClosed = false;
try {
  await q.ensureAccount("benchmark");
  await q.createBucket("benchmark", "benchmark", false);
  const baseline = disk(directory);
  const samples = [];
  for (const size of [1048576, 8388608]) {
    const data = randomBytes(size);
    const expected = createHash("sha256").update(data).digest("hex");
    const start = performance.now();
    const put = await q.putBytes(
      "benchmark",
      "benchmark",
      String(size),
      data,
      "application/octet-stream",
      {},
    );
    if (!put.ok) throw Error(put.error);
    const writeMs = performance.now() - start;
    const readStart = performance.now();
    const result = await q.readObjectFor("benchmark", "benchmark", String(size));
    if (
      !result.object ||
      createHash("sha256").update(result.object.bytes).digest("hex") !== expected
    )
      throw Error("Byte verification failed");
    samples.push({
      bytes: size,
      writeMs: Math.round(writeMs),
      readMs: Math.round(performance.now() - readStart),
      rssBytes: process.memoryUsage().rss,
    });
  }
  const credentials = await q.createKey("benchmark", "benchmark");
  if (!credentials.ok) throw Error("Could not create benchmark key");
  await (await getPglite()).close();
  databaseClosed = true;
  await globalThis.__pgliteReleaseLock__?.();
  globalThis.__pgliteReleaseLock__ = undefined;
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  async function start() {
    server = spawn(process.execPath, ["scripts/start.mjs"], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", BETTER_AUTH_URL: origin },
      stdio: "ignore",
    });
    for (let i = 0; i < 240; i++) {
      if (server.exitCode !== null) throw Error("Benchmark server exited");
      try {
        if ((await fetch(`${origin}/api/health`)).ok) return;
      } catch {
        /* waiting for readiness */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw Error("Benchmark server readiness timeout");
  }
  async function stop() {
    const done = once(server, "exit");
    server.kill();
    await done;
  }
  const startup = performance.now();
  await start();
  const startupMs = Math.round(performance.now() - startup);
  const headers = { authorization: `MO ${credentials.accessKeyId}:${credentials.secretKey}` };
  // The public API uses the same credentials as interoperability tests.
  const payload = randomBytes(1048576);
  const digest = createHash("sha256").update(payload).digest("hex");
  const parallelStart = performance.now();
  await Promise.all(
    [0, 1, 2, 3].map(async (i) => {
      const url = `${origin}/api/s3/benchmark/http-${i}`;
      const put = await fetch(url, { method: "PUT", headers, body: payload });
      if (!put.ok) throw Error(`HTTP write ${put.status}`);
      const get = await fetch(url, { headers });
      if (!get.ok) throw Error(`HTTP read ${get.status}`);
      if (
        createHash("sha256")
          .update(Buffer.from(await get.arrayBuffer()))
          .digest("hex") !== digest
      )
        throw Error("HTTP readback mismatch");
    }),
  );
  const fourConcurrentTransfersMs = Math.round(performance.now() - parallelStart);
  await stop();
  const restart = performance.now();
  await start();
  const restartMs = Math.round(performance.now() - restart);
  const retained = await fetch(`${origin}/api/s3/benchmark/http-0`, { headers });
  if (
    !retained.ok ||
    createHash("sha256")
      .update(Buffer.from(await retained.arrayBuffer()))
      .digest("hex") !== digest
  )
    throw Error("Restart lost bytes");
  await stop();
  server = undefined;
  console.log(
    JSON.stringify(
      {
        date: new Date().toISOString(),
        node: process.version,
        os: platform(),
        cpu: cpus()[0].model,
        ramBytes: totalmem(),
        scope:
          "random-byte embedded storage API samples and four concurrent 1 MiB HTTP write/read clients; no TLS; single run, not a peak-memory measurement or SLA",
        samples,
        startupMs,
        fourConcurrentTransfersMs,
        restartMs,
        diskBaselineBytes: baseline,
        diskAfterBytes: disk(directory),
      },
      null,
      2,
    ),
  );
} finally {
  server?.kill();
  if (!databaseClosed) await (await getPglite()).close();
  await globalThis.__pgliteReleaseLock__?.();
  rmSync(directory, { recursive: true, force: true });
}
