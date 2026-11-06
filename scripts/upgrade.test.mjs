import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";

test("upgrading the previous schema retains committed objects and enables safe staging", async () => {
  const root = mkdtempSync(join(tmpdir(), "middleout-upgrade-"));
  try {
    mkdirSync(join(root, "db"));
    const pg = new PGlite(join(root, "db"));
    await pg.waitReady;
    await pg.exec(
      "create table _migrations (name text primary key, applied_at timestamptz default now())",
    );
    for (const file of ["0001_auth.sql", "0002_storage.sql", "0003_features.sql"]) {
      await pg.exec(readFileSync(join("migrations", file), "utf8"));
      await pg.query("insert into _migrations(name) values($1)", [file]);
    }
    await pg.exec(
      "insert into mo_accounts(owner_id,seeded) values('upgrade-user',true); insert into mo_buckets(id,owner_id,name) values('upgrade-bucket','upgrade-user','upgrade-bucket'); insert into mo_objects(id,bucket_id,key,size,content_type,etag,complete) values('old-object','upgrade-bucket','file',3,'text/plain','old',true); insert into mo_parts(object_id,part,data) values('old-object',0,'b2xk');",
    );
    await pg.close();
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `import * as q from './src/lib/storage/queries.server.ts';import {getPglite} from './src/lib/db.ts';const before=await q.readObjectFor('upgrade-user','upgrade-bucket','file');if(before.object.bytes.toString()!=='old')throw Error('Upgrade lost bytes');if(before.object.writtenAt!==before.object.updatedAt)throw Error('Upgrade did not retain the publication clock');const {getLifecycle}=await import('./src/lib/storage/lifecycle.server.ts');if((await getLifecycle('upgrade-user','upgrade-bucket')).rules.length)throw Error('Upgrade installed unexpected retention rules');const upload=await q.beginUpload('upgrade-user',{bucket:'upgrade-bucket',key:'file',size:0,contentType:'text/plain'});if(!upload.ok)throw Error(upload.error);await q.abortUpload('upgrade-user',upload.id);const after=await q.readObjectFor('upgrade-user','upgrade-bucket','file');if(after.object.bytes.toString()!=='old')throw Error('Overwrite lost bytes');await(await getPglite()).close();`,
      ],
      { encoding: "utf8", env: { ...process.env, DATA_DIR: root, DATABASE_URL: "" } },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  }
});
