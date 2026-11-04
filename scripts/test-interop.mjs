import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import assert from "node:assert/strict";
const directory = mkdtempSync(join(tmpdir(), "middleout-interop-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const origin = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  DATA_DIR: directory,
  DATABASE_URL: "",
  BETTER_AUTH_URL: origin,
  HOST: "127.0.0.1",
  PORT: String(port),
  ALLOW_SIGN_UP: "false",
};
let server;
let logs = "";
try {
  const setup = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import * as q from './src/lib/storage/queries.server.ts';import {getPglite} from './src/lib/db.ts';await q.ensureAccount('interop-owner');const key=await q.createKey('interop-owner','clients');console.log(JSON.stringify(key));await(await getPglite()).close();`,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let credentials = "";
  setup.stdout.on("data", (d) => (credentials += d));
  setup.stderr.on("data", (d) => (logs += d));
  const [setupCode] = await once(setup, "exit");
  assert.equal(setupCode, 0, logs);
  const key = JSON.parse(credentials);
  assert.ok(key.ok);
  server = spawn(process.execPath, ["scripts/start.mjs"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (logs += d));
  server.stderr.on("data", (d) => (logs += d));
  let healthy = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(origin + "/api/health", { signal: AbortSignal.timeout(1500) })).ok) {
        healthy = true;
        break;
      }
    } catch {
      /* boot */
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  assert.ok(healthy, logs);
  const python = process.env.PYTHON || "python";
  const client = spawn(python, ["scripts/interop.py"], {
    env: {
      ...env,
      PYTHON: python,
      MIDDLEOUT_TEST_ENDPOINT: origin + "/api/s3",
      AWS_ACCESS_KEY_ID: key.accessKeyId,
      AWS_SECRET_ACCESS_KEY: key.secretKey,
      AWS_DEFAULT_REGION: "us-east-1",
      AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
      AWS_RESPONSE_CHECKSUM_VALIDATION: "when_required",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_PAGER: "",
    },
    stdio: "inherit",
  });
  const [code] = await once(client, "exit");
  assert.equal(code, 0, "Client compatibility suite failed.");
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (server?.exitCode === null) {
    const stopped = once(server, "exit");
    server.kill();
    await stopped;
  }
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
