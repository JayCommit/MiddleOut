import assert from "node:assert/strict";
import { test } from "node:test";
import { getSql } from "../db.ts";
import { handleS3 } from "../s3/engine.server.ts";
import * as q from "./queries.server.ts";
import { MAX_OBJECT_BYTES, MAX_ACCOUNT_BYTES } from "./pure.ts";

async function fixture(name: string) {
  const owner = `regression-${name}`;
  const bucket = `regression-${name}`;
  assert.equal((await q.createBucket(owner, bucket, true)).ok, true);
  return { owner, bucket };
}
async function content(owner: string, bucket: string, key: string) {
  const result = await q.readObjectFor(owner, bucket, key);
  assert.ok("object" in result && result.object);
  return result.object.bytes.toString();
}

test("cancelled and failed console overwrites preserve committed bytes, tags and shares", async () => {
  const { owner, bucket } = await fixture("cancel");
  await q.putBytes(owner, bucket, "file", Buffer.from("old"), "text/plain", {});
  await q.setTags(owner, bucket, "file", [{ key: "keep", value: "yes" }]);
  const share = await q.createLink(owner, bucket, "file", 3600);
  assert.ok(share.ok);
  const upload = await q.beginUpload(owner, {
    bucket,
    key: "file",
    size: 3,
    contentType: "text/plain",
  });
  assert.ok(upload.ok);
  assert.equal(await content(owner, bucket, "file"), "old");
  assert.equal((await q.finishUpload(owner, upload.id)).ok, false);
  assert.equal(await content(owner, bucket, "file"), "old");
  await q.abortUpload(owner, upload.id);
  assert.equal(await content(owner, bucket, "file"), "old");
  assert.equal((await q.readShare(share.token))?.bytes.toString(), "old");
  const detail = await q.objectDetail(owner, bucket, "file");
  assert.ok(detail.ok);
  assert.deepEqual(detail.object.tags, [{ key: "keep", value: "yes" }]);
});

test("successful console overwrite publishes only when complete, including zero-byte objects", async () => {
  const { owner, bucket } = await fixture("publish");
  await q.putBytes(owner, bucket, "file", Buffer.from("old"), "text/plain", {});
  const upload = await q.beginUpload(owner, {
    bucket,
    key: "file",
    size: 3,
    contentType: "text/plain",
  });
  assert.ok(upload.ok);
  assert.equal(
    (await q.writePart(owner, upload.id, 0, Buffer.from("new").toString("base64"))).ok,
    true,
  );
  assert.equal(await content(owner, bucket, "file"), "old");
  assert.equal((await q.finishUpload(owner, upload.id)).ok, true);
  assert.equal(await content(owner, bucket, "file"), "new");
  const empty = await q.beginUpload(owner, {
    bucket,
    key: "file",
    size: 0,
    contentType: "text/plain",
  });
  assert.ok(empty.ok);
  assert.equal((await q.finishUpload(owner, empty.id)).ok, true);
  assert.equal(await content(owner, bucket, "file"), "");
});

test("console parts cannot exceed reserved bytes or use extra part numbers", async () => {
  const { owner, bucket } = await fixture("parts");
  const upload = await q.beginUpload(owner, {
    bucket,
    key: "file",
    size: 1,
    contentType: "text/plain",
  });
  assert.ok(upload.ok);
  assert.equal(
    (await q.writePart(owner, upload.id, 0, Buffer.from("too big").toString("base64"))).ok,
    false,
  );
  assert.equal((await q.writePart(owner, upload.id, 1, "YQ==")).ok, false);
  assert.equal((await q.writePart("another-owner", upload.id, 0, "YQ==")).ok, false);
  assert.equal((await q.writePart(owner, upload.id, 0, "YQ==")).ok, true);
  assert.equal((await q.writePart(owner, upload.id, 0, "Yg==")).ok, true);
  assert.equal((await q.finishUpload(owner, upload.id)).ok, true);
  assert.equal(await content(owner, bucket, "file"), "b");
});

test("pending reservations and concurrent console/S3 writers share the same quota", async () => {
  const { owner, bucket } = await fixture("quota");
  for (let i = 0; i < 7; i++)
    assert.equal(
      (
        await q.beginUpload(owner, {
          bucket,
          key: `reserved-${i}`,
          size: MAX_OBJECT_BYTES,
          contentType: "application/octet-stream",
        })
      ).ok,
      true,
    );
  const mp = await q.initiateMultipartUpload(owner, bucket, "multipart", "text/plain", {});
  assert.ok(mp.ok);
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  const attempts = await Promise.all([
    q.beginUpload(owner, {
      bucket,
      key: "console",
      size: bytes.length,
      contentType: "application/octet-stream",
    }),
    q.putBytes(owner, bucket, "single", bytes, "application/octet-stream", {}),
    q.uploadMultipartPart(owner, bucket, "multipart", mp.uploadId, 1, bytes),
  ]);
  assert.equal(attempts.filter((r) => r.ok).length, 1);
  const sql = await getSql();
  const usage = await sql<{
    bytes: number;
  }>`select sum(size)::int as bytes from mo_objects o join mo_buckets b on b.id=o.bucket_id where b.owner_id=${owner}`;
  assert.ok(Number(usage[0].bytes) <= MAX_ACCOUNT_BYTES);
});

test("part-write failures roll back single PUT and multipart completion", async () => {
  const { owner, bucket } = await fixture("rollback");
  await q.putBytes(owner, bucket, "file", Buffer.from("old"), "text/plain", {});
  const mp = await q.initiateMultipartUpload(owner, bucket, "file", "text/plain", {});
  assert.ok(mp.ok);
  const part = await q.uploadMultipartPart(
    owner,
    bucket,
    "file",
    mp.uploadId,
    1,
    Buffer.from("new"),
  );
  assert.ok(part.ok);
  const sql = await getSql();
  await sql.query("alter table mo_parts add constraint regression_fail check (data <> 'bmV3')");
  try {
    await assert.rejects(q.putBytes(owner, bucket, "file", Buffer.from("new"), "text/plain", {}));
    assert.equal(await content(owner, bucket, "file"), "old");
    await assert.rejects(
      q.completeMultipartUpload(owner, bucket, "file", mp.uploadId, [
        { partNumber: 1, etag: part.etag },
      ]),
    );
    assert.equal(await content(owner, bucket, "file"), "old");
    assert.equal((await q.listMultipartParts(owner, bucket, "file", mp.uploadId)).ok, true);
  } finally {
    await sql.query("alter table mo_parts drop constraint regression_fail");
  }
  assert.equal(
    (
      await q.completeMultipartUpload(owner, bucket, "file", mp.uploadId, [
        { partNumber: 1, etag: part.etag },
      ])
    ).ok,
    true,
  );
  assert.equal(await content(owner, bucket, "file"), "new");
});

test("multipart lifecycle binds uploads to the object key", async () => {
  const { owner, bucket } = await fixture("binding");
  const mp = await q.initiateMultipartUpload(owner, bucket, "file", "text/plain", {});
  assert.ok(mp.ok);
  assert.equal(
    (await q.uploadMultipartPart(owner, bucket, "wrong", mp.uploadId, 1, Buffer.from("x"))).ok,
    false,
  );
  assert.equal(
    (await q.completeMultipartUpload(owner, bucket, "wrong", mp.uploadId, [])).ok,
    false,
  );
  assert.equal((await q.abortMultipartUpload(owner, bucket, "wrong", mp.uploadId)).ok, false);
  assert.equal((await q.listMultipartParts(owner, bucket, "wrong", mp.uploadId)).ok, false);
  assert.equal((await q.abortMultipartUpload(owner, bucket, "file", mp.uploadId)).ok, true);
});

test("unsupported policies are rejected and legacy policies fail closed until explicitly removed", async () => {
  const { owner, bucket } = await fixture("policy");
  await q.putBytes(owner, bucket, "file", Buffer.from("secret"), "text/plain", {});
  const credentials = await q.createKey(owner, "policy test");
  assert.ok(credentials.ok);
  const headers = { authorization: `MO ${credentials.accessKeyId}:${credentials.secretKey}` };
  const policy = JSON.stringify({
    Statement: [{ Effect: "Deny", Principal: "*", Action: "s3:GetObject", Resource: "*" }],
  });
  const result = await handleS3(
    new Request(`http://localhost/api/s3/${bucket}?policy`, {
      method: "PUT",
      headers,
      body: policy,
    }),
  );
  assert.equal(result.status, 501);
  assert.equal((await q.bucketRecord(bucket))?.policy, null);
  const share = await q.createLink(owner, bucket, "file", 3600);
  assert.ok(share.ok);
  const sql = await getSql();
  await sql`update mo_buckets set policy=${policy} where name=${bucket}`;
  assert.equal((await handleS3(new Request(`http://localhost/api/s3/${bucket}/file`))).status, 501);
  assert.equal(await q.readShare(share.token), null);
  assert.equal(await q.readPublicObject(bucket, "file"), null);
  assert.equal((await q.publicListing(bucket, "")).available, false);
  assert.ok("error" in (await q.readObjectFor(owner, bucket, "file")));
  const removed = await handleS3(
    new Request(`http://localhost/api/s3/${bucket}?policy`, { method: "DELETE", headers }),
  );
  assert.equal(removed.status, 204);
  assert.equal(await content(owner, bucket, "file"), "secret");
});

test("reads observe a complete object version while concurrent PUTs replace it", async () => {
  const { owner, bucket } = await fixture("snapshot");
  const versions = ["a".repeat(4096), "b".repeat(4096)];
  await q.putBytes(owner, bucket, "file", Buffer.from(versions[0]), "text/plain", {});
  await Promise.all([
    (async () => {
      for (let i = 0; i < 12; i++)
        assert.equal(
          (await q.putBytes(owner, bucket, "file", Buffer.from(versions[i % 2]), "text/plain", {}))
            .ok,
          true,
        );
    })(),
    (async () => {
      for (let i = 0; i < 12; i++)
        assert.ok(versions.includes(await content(owner, bucket, "file")));
    })(),
    (async () => {
      for (let i = 0; i < 12; i++)
        assert.ok(
          versions.includes((await q.readPublicObject(bucket, "file"))?.bytes.toString() || ""),
        );
    })(),
  ]);
});

test("move rolls back source deletion and destination creation when a later step fails", async () => {
  const { owner, bucket } = await fixture("move-failure");
  await q.putBytes(owner, bucket, "source", Buffer.from("keep"), "text/plain", {});
  const sql = await getSql();
  await sql.query(
    "alter table mo_audit add constraint regression_move_fail check (action <> 'object.move' or owner_id <> 'regression-move-failure')",
  );
  try {
    await assert.rejects(q.moveObject(owner, bucket, "source", "destination"));
    assert.equal(await content(owner, bucket, "source"), "keep");
    const dest = await q.readObjectFor(owner, bucket, "destination");
    assert.ok("error" in dest && dest.error === "NoSuchKey");
  } finally {
    await sql.query("alter table mo_audit drop constraint regression_move_fail");
  }
});

test("console and public folder browsers hide their own folder marker", async () => {
  const { owner, bucket } = await fixture("folder-marker");
  await q.putBytes(owner, bucket, "new/", Buffer.alloc(0), "application/octet-stream", {});
  const consolePage = await q.browse(owner, bucket, "new/");
  assert.ok(consolePage.ok);
  assert.deepEqual(consolePage.objects, []);
  const publicPage = await q.publicListing(bucket, "new/");
  assert.ok(publicPage.available);
  assert.deepEqual(publicPage.objects, []);
  const s3Page = await q.listForS3(owner, bucket, "new/", "", 1000, "");
  assert.ok(!("error" in s3Page));
  assert.equal(s3Page.contents[0].key, "new/");
});
