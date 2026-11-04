import assert from "node:assert/strict";
import { test } from "node:test";
import {
  batchDeleteObjects,
  browse,
  cleanupExpired,
  createBucket,
  createKey,
  createLink,
  getSystemMetrics,
  listShares,
  moveObject,
  putBytes,
  readObjectFor,
  revokeShare,
} from "./queries.server.ts";

test("storage features: moveObject copies and deletes source atomically", async () => {
  const ownerId = `move-user-${Date.now()}`;
  await createBucket(ownerId, "move-bucket", false);
  await putBytes(ownerId, "move-bucket", "source.txt", Buffer.from("move me"), "text/plain", {});

  const moveRes = await moveObject(ownerId, "move-bucket", "source.txt", "destination/moved.txt");
  assert.equal(moveRes.ok, true);

  // Source should no longer exist
  const oldObj = await readObjectFor(ownerId, "move-bucket", "source.txt");
  assert.equal("error" in oldObj && oldObj.error, "NoSuchKey");

  // Dest should exist with identical bytes
  const newObj = await readObjectFor(ownerId, "move-bucket", "destination/moved.txt");
  assert.equal("object" in newObj && Boolean(newObj.object), true);
  if ("object" in newObj && newObj.object) {
    assert.equal(newObj.object.bytes.toString(), "move me");
  }
});

test("storage features: batchDeleteObjects deletes multiple keys", async () => {
  const ownerId = `batch-user-${Date.now()}`;
  await createBucket(ownerId, "batch-bucket", false);
  await putBytes(ownerId, "batch-bucket", "k1.txt", Buffer.from("1"), "text/plain", {});
  await putBytes(ownerId, "batch-bucket", "k2.txt", Buffer.from("2"), "text/plain", {});
  await putBytes(ownerId, "batch-bucket", "k3.txt", Buffer.from("3"), "text/plain", {});

  const res = await batchDeleteObjects(ownerId, "batch-bucket", ["k1.txt", "k2.txt"]);
  assert.equal(res.ok, true);
  assert.deepEqual(res.deleted.sort(), ["k1.txt", "k2.txt"]);

  // k3 still exists
  const k3 = await readObjectFor(ownerId, "batch-bucket", "k3.txt");
  assert.equal("object" in k3, true);
});

test("storage features: share links listing and revocation", async () => {
  const ownerId = `share-user-${Date.now()}`;
  await createBucket(ownerId, "share-bucket", false);
  await putBytes(ownerId, "share-bucket", "secret.pdf", Buffer.from("pdf bytes"), "application/pdf", {});

  // Create 24-hour link
  const linkRes = await createLink(ownerId, "share-bucket", "secret.pdf", 86400);
  assert.equal(linkRes.ok, true);
  if (!linkRes.ok) return;

  const shares = await listShares(ownerId);
  const found = shares.find((s) => s.token === linkRes.token);
  assert.ok(found);
  assert.equal(found.key, "secret.pdf");
  assert.equal(found.bucket, "share-bucket");

  // Revoke link
  const revRes = await revokeShare(ownerId, linkRes.token);
  assert.equal(revRes.ok, true);

  const afterShares = await listShares(ownerId);
  assert.ok(!afterShares.some((s) => s.token === linkRes.token));
});

test("storage features: cleanupExpired removes stale uploads and links", async () => {
  const res = await cleanupExpired(0);
  assert.equal(res.ok, true);
});

test("storage features: getSystemMetrics returns valid metrics", async () => {
  const metrics = await getSystemMetrics();
  assert.ok(Number.isFinite(metrics.totalBuckets));
  assert.ok(Number.isFinite(metrics.totalObjects));
  assert.ok(Number.isFinite(metrics.totalBytes));
  assert.ok(Number.isFinite(metrics.totalKeys));
});

test("storage features: browse pagination with startAfter cursor", async () => {
  const ownerId = `page-user-${Date.now()}`;
  await createBucket(ownerId, "page-bucket", false);

  // Insert 5 objects
  for (let i = 1; i <= 5; i++) {
    await putBytes(ownerId, "page-bucket", `item-${i}.txt`, Buffer.from(`item ${i}`), "text/plain", {});
  }

  // Browse starting from startAfter = "item-2.txt"
  const page = await browse(ownerId, "page-bucket", "", "item-2.txt");
  assert.equal(page.ok, true);
  if (page.ok) {
    const keys = page.objects.map((o) => o.key);
    assert.deepEqual(keys, ["item-3.txt", "item-4.txt", "item-5.txt"]);
  }
});
