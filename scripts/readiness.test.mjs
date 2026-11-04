import { test } from "node:test";
import assert from "node:assert/strict";
process.env.DATA_DIR = ":memory:";
process.env.DATABASE_URL = "";
process.env.MAX_OBJECT_BYTES = String(16 * 1024 * 1024);
process.env.ACCOUNT_QUOTA_BYTES = String(128 * 1024 * 1024);
const q = await import("../src/lib/storage/queries.server.ts");
const { getSql, getPglite } = await import("../src/lib/db.ts");

test("configured capacity and cleanup preserve recently active and completed uploads", async () => {
  await q.ensureAccount("readiness");
  assert.ok((await q.createBucket("readiness", "readiness-test", false)).ok);
  const bytes = Buffer.alloc(9 * 1024 * 1024, 7);
  assert.ok(
    (
      await q.putBytes(
        "readiness",
        "readiness-test",
        "large",
        bytes,
        "application/octet-stream",
        {},
      )
    ).ok,
  );
  const pending = await q.beginUpload("readiness", {
    bucket: "readiness-test",
    key: "pending",
    size: 3,
    contentType: "text/plain",
  });
  assert.ok(pending.ok);
  const sql = await getSql();
  await sql.query(
    "UPDATE mo_objects SET created_at = now() - interval '2 days', updated_at = now() - interval '2 days' WHERE id = $1",
    [pending.id],
  );
  assert.ok(
    (await q.writePart("readiness", pending.id, 0, Buffer.from("abc").toString("base64"))).ok,
  );
  await q.cleanupExpired();
  assert.ok((await q.finishUpload("readiness", pending.id)).ok);
  const read = await q.readObjectFor("readiness", "readiness-test", "large");
  assert.ok(read.object);
  assert.equal(read.object.bytes.length, bytes.length);
  const stale = await q.beginUpload("readiness", {
    bucket: "readiness-test",
    key: "stale",
    size: 3,
    contentType: "text/plain",
  });
  await sql.query("UPDATE mo_objects SET updated_at = now() - interval '2 days' WHERE id = $1", [
    stale.id,
  ]);
  await q.cleanupExpired();
  assert.equal((await q.writePart("readiness", stale.id, 0, "YWJj")).ok, false);
  await sql.query(
    `INSERT INTO mo_objects(id,bucket_id,key,size,content_type,complete) SELECT 'page-'||n,b.id,'page-'||lpad(n::text,5,'0'),0,'text/plain',true FROM generate_series(1,5001) n CROSS JOIN mo_buckets b WHERE b.name='readiness-test'`,
  );
  const keys = new Set();
  let cursor = "";
  for (let page = 0; page < 110; page++) {
    const result = await q.browse("readiness", "readiness-test", "page-", cursor);
    assert.ok(result.ok);
    for (const object of result.objects) {
      assert.ok(!keys.has(object.key));
      keys.add(object.key);
    }
    if (!result.truncated) break;
    assert.notEqual(result.nextStart, cursor);
    cursor = result.nextStart;
  }
  assert.equal(keys.size, 5001);
  await sql.query(
    `INSERT INTO mo_audit(id,owner_id,action,detail) SELECT 'audit-'||n,'readiness','test','test' FROM generate_series(1,205) n`,
  );
  const first = await q.listAudit("readiness", 0);
  const second = await q.listAudit("readiness", 100);
  assert.equal(first.length, 100);
  assert.equal(second.length, 100);
  assert.equal(first.filter((a) => second.some((b) => a.id === b.id)).length, 0);
  await (await getPglite()).close();
});
