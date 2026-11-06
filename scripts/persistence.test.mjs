import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

test("embedded objects, access keys and lifecycle rules survive process restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "middleout-persistence-"));
  const run = (code) => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      { encoding: "utf8", env: { ...process.env, DATABASE_URL: "", DATA_DIR: directory } },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout.trim();
  };
  try {
    const credentials = JSON.parse(
      run(
        `import * as q from './src/lib/storage/queries.server.ts'; import {getPglite} from './src/lib/db.ts'; await q.createBucket('persistent-owner','persistent-bucket',false); await q.putBytes('persistent-owner','persistent-bucket','file',Buffer.from('retained'),'text/plain',{}); const {setLifecycle}=await import('./src/lib/storage/lifecycle.server.ts'); await setLifecycle('persistent-owner','persistent-bucket',[{id:'persisted-retention',status:'Enabled',prefix:'logs/',tags:[],expirationDays:7}]); console.log(JSON.stringify(await q.createKey('persistent-owner','retained'))); await (await getPglite()).close();`,
      ),
    );
    const read = JSON.parse(
      run(
        `import * as q from './src/lib/storage/queries.server.ts'; import {getPglite} from './src/lib/db.ts'; const object=await q.readObjectFor('persistent-owner','persistent-bucket','file'); const auth=await q.authenticateAccessKey(${JSON.stringify(credentials.accessKeyId)},${JSON.stringify(credentials.secretKey)}); const {getLifecycle}=await import('./src/lib/storage/lifecycle.server.ts'); const lifecycle=await getLifecycle('persistent-owner','persistent-bucket'); console.log(JSON.stringify({bytes:object.object.bytes.toString(), owner:auth.ownerId, retention:lifecycle.rules[0].id})); await (await getPglite()).close();`,
      ),
    );
    assert.deepEqual(read, {
      bytes: "retained",
      owner: "persistent-owner",
      retention: "persisted-retention",
    });
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
