import { once } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { acquireDataLock } from "./data-directory.mjs";
const run = (code, directory) =>
  spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: "", DATA_DIR: directory },
  });

test("offline backup/restore preserves bytes, rejects live nodes, rejects corrupt backups and existing targets", async () => {
  const root = mkdtempSync(join(tmpdir(), "middleout-recovery-"));
  const data = join(root, "data");
  const backup = join(root, "backup");
  const restored = join(root, "restored");
  const maintenance = (action, directory, source = backup) =>
    spawnSync(process.execPath, ["scripts/backup.mjs", action, source], {
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "", DATA_DIR: directory },
    });
  try {
    let result = run(
      `import * as q from './src/lib/storage/queries.server.ts';import {getPglite} from './src/lib/db.ts';await q.createBucket('backup-user','backup-bucket',false);await q.putBytes('backup-user','backup-bucket','file',Buffer.from('backup survives'),'text/plain',{});await(await getPglite()).close();`,
      data,
    );
    assert.equal(result.status, 0, result.stderr);
    writeFileSync(join(data, "auth-secret"), "a".repeat(64));
    const release = await acquireDataLock(data);
    assert.notEqual(maintenance("backup", data).status, 0);
    await release();
    assert.equal(maintenance("backup", data).status, 0);
    assert.notEqual(maintenance("backup", data).status, 0);
    assert.notEqual(maintenance("restore", data).status, 0);
    assert.equal(maintenance("restore", restored).status, 0);
    assert.equal(readFileSync(join(restored, "auth-secret"), "utf8"), "a".repeat(64));
    result = run(
      `import * as q from './src/lib/storage/queries.server.ts';import {getPglite} from './src/lib/db.ts';const obj=await q.readObjectFor('backup-user','backup-bucket','file');if(obj.object.bytes.toString()!=='backup survives')throw Error('Lost bytes');await(await getPglite()).close();`,
      restored,
    );
    assert.equal(result.status, 0, result.stderr);
    const corrupt = join(root, "corrupt");
    cpSync(backup, corrupt, { recursive: true });
    writeFileSync(join(corrupt, "auth-secret"), "tampered");
    assert.notEqual(maintenance("restore", join(root, "never-created"), corrupt).status, 0);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  }
});

test("backup refuses a live embedded DB opened directly without the production start script", async () => {
  const root = mkdtempSync(join(tmpdir(), "middleout-live-backup-"));
  const data = join(root, "data");
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import {getPglite} from './src/lib/db.ts';await getPglite();console.log('READY');setInterval(()=>{},1000);`,
    ],
    {
      env: { ...process.env, DATABASE_URL: "", DATA_DIR: data },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const deadline = setTimeout(() => reject(Error("DB boot timed out")), 15000);
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("READY")) {
          clearTimeout(deadline);
          resolve();
        }
      });
      child.on("error", reject);
      child.on("exit", () => {
        clearTimeout(deadline);
        reject(Error("DB exited before ready"));
      });
    });
    const backup = spawnSync(
      process.execPath,
      ["scripts/backup.mjs", "backup", join(root, "backup")],
      { env: { ...process.env, DATABASE_URL: "", DATA_DIR: data }, encoding: "utf8" },
    );
    assert.notEqual(backup.status, 0);
    assert.match(backup.stderr, /lock|ELOCKED|already locked/i);
  } finally {
    if (child.exitCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  }
});
