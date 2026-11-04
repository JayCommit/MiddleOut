import assert from "node:assert/strict";
import EmbeddedPostgres from "embedded-postgres";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, sep, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
const directory = mkdtempSync(join(tmpdir(), "middleout-postgres-"));
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((done) => probe.close(done));
const password = randomBytes(24).toString("hex");
let cluster;
const run = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Test subprocess exited ${code}`)),
    );
  });
try {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    cluster = new EmbeddedPostgres({
      databaseDir: join(directory, "cluster"),
      port,
      user: "postgres",
      password,
      persistent: true,
      authMethod: "scram-sha-256",
      autoRehydrateSymlinks: true,
      postgresFlags: ["-h", "127.0.0.1"],
      onLog: () => {},
      onError: () => {},
    });
    await cluster.initialise();
    await cluster.start();
    await cluster.createDatabase("middleout_test");
    url = `postgresql://postgres:${password}@127.0.0.1:${port}/middleout_test`;
  }
  const env = { ...process.env, DATABASE_URL: url, TEST_DATABASE_URL: url };
  // Exercise simultaneous application startup against the same fresh schema.
  await Promise.all([run(["scripts/migrate.mjs"], env), run(["scripts/migrate.mjs"], env)]);
  await run(["scripts/test.mjs"], env);
  if (cluster && process.env.PG_BIN) {
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const binaries = await import(`@embedded-postgres/${platform}-${process.arch}`);
    const extension = process.platform === "win32" ? ".exe" : "";
    const bindir = process.env.PG_BIN || dirname(binaries.postgres);
    const dump = join(directory, "backup.dump");
    const connection = ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres"];
    const backup = spawnSync(
      join(bindir, "pg_dump" + extension),
      [...connection, "-Fc", "-f", dump, "middleout_test"],
      { env: { ...process.env, PGPASSWORD: password }, encoding: "utf8" },
    );
    assert.equal(backup.status, 0, backup.stderr || String(backup.error));
    await cluster.createDatabase("middleout_restore");
    const restore = spawnSync(
      join(bindir, "pg_restore" + extension),
      [...connection, "--exit-on-error", "-d", "middleout_restore", dump],
      { env: { ...process.env, PGPASSWORD: password }, encoding: "utf8" },
    );
    assert.equal(restore.status, 0, restore.stderr || String(restore.error));
    const original = cluster.getPgClient("middleout_test");
    const restored = cluster.getPgClient("middleout_restore");
    await original.connect();
    await restored.connect();
    try {
      const query =
        "select count(*)::int as count, coalesce(sum(length(data)),0)::bigint as bytes from mo_parts";
      assert.deepEqual((await original.query(query)).rows, (await restored.query(query)).rows);
      assert.ok(
        (await restored.query("select count(*)::int as count from mo_keys")).rows[0].count > 0,
      );
    } finally {
      await original.end();
      await restored.end();
    }
    console.log("PASS: Postgres pg_dump/pg_restore retains object parts and access keys.");
  }
  console.log(
    "PASS: real Postgres migrations, concurrent startup, isolation, quotas, publication and rollback.",
  );
} finally {
  if (cluster) await cluster.stop();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
