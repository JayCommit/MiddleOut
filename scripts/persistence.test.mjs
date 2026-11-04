import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

test("embedded objects and access keys survive process restart", () => {
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
        `import * as q from './src/lib/storage/queries.server.ts'; import {getPglite} from './src/lib/db.ts'; await q.createBucket('persistent-owner','persistent-bucket',false); await q.putBytes('persistent-owner','persistent-bucket','file',Buffer.from('retained'),'text/plain',{}); console.log(JSON.stringify(await q.createKey('persistent-owner','retained'))); await (await getPglite()).close();`,
      ),
    );
    const read = JSON.parse(
      run(
        `import * as q from './src/lib/storage/queries.server.ts'; import {getPglite} from './src/lib/db.ts'; const object=await q.readObjectFor('persistent-owner','persistent-bucket','file'); const auth=await q.authenticateAccessKey(${JSON.stringify(credentials.accessKeyId)},${JSON.stringify(credentials.secretKey)}); console.log(JSON.stringify({bytes:object.object.bytes.toString(), owner:auth.ownerId})); await (await getPglite()).close();`,
      ),
    );
    assert.deepEqual(read, { bytes: "retained", owner: "persistent-owner" });
  } finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    rmSync(directory, { recursive: true, force: true });
  }
});
