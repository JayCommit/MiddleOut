import assert from "node:assert/strict";
import { test } from "node:test";
import * as q from "./queries.server.ts";
import { saveDriveCredentials } from "./gdrive.server.ts";
import { searchBucket } from "./search.server.ts";
import { getSql } from "../db.ts";
import { handleS3 } from "../s3/engine.server.ts";

// This fake validates the actual MIME upload bytes, rather than returning success blindly.
test("Drive S3 authorization and console/multipart provider round trips", async (t) => {
  const owner = "drive-review-owner";
  const bucket = "drive-review-private";
  const files = new Map<string, { bytes: Buffer; type: string }>();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const url = new URL(String(input));
    if (url.pathname.includes("/upload/")) {
      const body = Buffer.from(init!.body as Uint8Array);
      const boundary = new Headers(init!.headers).get("content-type")!.split("boundary=")[1];
      const marker = Buffer.from(`\r\n--${boundary}\r\n`);
      const firstHeaderEnd = body.indexOf("\r\n\r\n");
      const metadataEnd = body.indexOf(marker, firstHeaderEnd + 4);
      const metadata = JSON.parse(body.subarray(firstHeaderEnd + 4, metadataEnd).toString());
      const mediaStart = body.indexOf("\r\n\r\n", metadataEnd + marker.length) + 4;
      const mediaEnd = body.lastIndexOf(Buffer.from(`\r\n--${boundary}--`));
      const name =
        init!.method === "PATCH"
          ? decodeURIComponent(url.pathname.split("/").pop()!)
          : metadata.name;
      files.set(name, { bytes: body.subarray(mediaStart, mediaEnd), type: metadata.mimeType });
      return Response.json({ id: name });
    }
    if (url.searchParams.get("alt") === "media") {
      const file = files.get(decodeURIComponent(url.pathname.split("/").pop()!));
      return file ? new Response(new Uint8Array(file.bytes)) : new Response(null, { status: 404 });
    }
    const name = url.searchParams.get("q")?.match(/name = '([^']+)'/)?.[1];
    return Response.json({
      files: [...files]
        .filter(([key]) => !name || key === name)
        .map(([key, file]) => ({
          id: key,
          name: key,
          size: String(file.bytes.length),
          mimeType: file.type,
        })),
    });
  });
  await saveDriveCredentials(owner, {
    authType: "oauth",
    accessToken: "fake",
    tokenExpiry: new Date(Date.now() + 3600000).toISOString(),
  });
  await q.createBucket(owner, bucket, "private", {
    provider: "gdrive",
    providerConfig: { folderId: "root", mountMode: "rw" },
  });
  files.set("secret.txt", { bytes: Buffer.from("private"), type: "text/plain" });
  const ownerKey = await q.createKey(owner, "owner");
  const outsiderKey = await q.createKey("drive-review-outsider", "outsider");
  const auth = (key: typeof ownerKey) => ({
    authorization: `MO ${key.accessKeyId}:${key.secretKey}`,
  });
  for (const method of ["GET", "HEAD"]) {
    for (const headers of [{}, auth(outsiderKey)]) {
      const response = await handleS3(
        new Request(`http://localhost/api/s3/${bucket}/secret.txt`, { method, headers }),
      );
      assert.equal(response.status, 403);
    }
  }
  assert.equal(calls, 0, "Denied reads must not contact Drive");
  assert.equal(
    await (
      await handleS3(
        new Request(`http://localhost/api/s3/${bucket}/secret.txt`, { headers: auth(ownerKey) }),
      )
    ).text(),
    "private",
  );
  await q.setBucketAccess(owner, bucket, true);
  assert.equal(
    await (await handleS3(new Request(`http://localhost/api/s3/${bucket}/secret.txt`))).text(),
    "private",
  );
  await q.setBucketAccess(owner, bucket, false);

  const bytes = Buffer.from([0, 255, 13, 10, 128, 65]);
  const started = await q.beginUpload(owner, {
    bucket,
    key: "console.bin",
    size: bytes.length,
    contentType: "application/octet-stream",
  });
  assert.ok(started.ok);
  assert.ok((await q.writePart(owner, started.id!, 0, bytes.toString("base64"))).ok);
  assert.ok((await q.finishUpload(owner, started.id!)).ok);
  const read = await q.readObjectFor(owner, bucket, "console.bin");
  assert.ok("object" in read);
  assert.deepEqual(read.object!.bytes, bytes);
  assert.deepEqual(files.get("console.bin")!.bytes, bytes);
  const mp = await q.initiateMultipartUpload(
    owner,
    bucket,
    "multipart.bin",
    "application/octet-stream",
    {},
  );
  assert.ok(mp.ok);
  const part = await q.uploadMultipartPart(owner, bucket, "multipart.bin", mp.uploadId!, 1, bytes);
  assert.ok(part.ok);
  assert.ok(
    (
      await q.completeMultipartUpload(owner, bucket, "multipart.bin", mp.uploadId!, [
        { partNumber: 1, etag: part.etag! },
      ])
    ).ok,
  );
  assert.deepEqual(files.get("multipart.bin")!.bytes, bytes);
  const mpRead = await q.readObjectFor(owner, bucket, "multipart.bin");
  assert.ok("object" in mpRead);
  assert.deepEqual(mpRead.object!.bytes, bytes);
  const listing = await q.browse(owner, bucket, "");
  assert.ok(listing.ok);
  assert.ok(listing.objects!.some((object) => object.key === "console.bin"));
  const sql = await getSql();
  const [count] = await sql<{
    n: number;
  }>`select count(*)::int as n from mo_objects o join mo_buckets b on b.id = o.bucket_id where b.name = ${bucket}`;
  assert.equal(count.n, 0, "Published Drive uploads must not leave shadow objects");

  await q.createBucket(owner, "drive-review-readonly", "private", {
    provider: "gdrive",
    providerConfig: { folderId: "root", mountMode: "ro" },
  });
  const before = calls;
  assert.equal(
    (
      await q.beginUpload(owner, {
        bucket: "drive-review-readonly",
        key: "blocked",
        size: 1,
        contentType: "text/plain",
      })
    ).ok,
    false,
  );
  const denied = await q.initiateMultipartUpload(
    owner,
    "drive-review-readonly",
    "blocked",
    "text/plain",
    {},
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "AccessDenied");
  assert.equal(calls, before);

  // Permissions can change while parts are staged: recheck at publication.
  const pending = await q.beginUpload(owner, {
    bucket,
    key: "late-console.bin",
    size: bytes.length,
    contentType: "application/octet-stream",
  });
  assert.ok(pending.ok);
  await q.writePart(owner, pending.id!, 0, bytes.toString("base64"));
  const pendingMp = await q.initiateMultipartUpload(
    owner,
    bucket,
    "late-multipart.bin",
    "application/octet-stream",
    {},
  );
  assert.ok(pendingMp.ok);
  const pendingPart = await q.uploadMultipartPart(
    owner,
    bucket,
    "late-multipart.bin",
    pendingMp.uploadId!,
    1,
    bytes,
  );
  assert.ok(pendingPart.ok);
  await sql`update mo_buckets set provider_config = '{"folderId":"root","mountMode":"ro"}' where name = ${bucket}`;
  const callsBeforeCompletion = calls;
  assert.equal((await q.finishUpload(owner, pending.id!)).ok, false);
  assert.equal(
    (
      await q.completeMultipartUpload(owner, bucket, "late-multipart.bin", pendingMp.uploadId!, [
        { partNumber: 1, etag: pendingPart.etag! },
      ])
    ).ok,
    false,
  );
  assert.equal(calls, callsBeforeCompletion);
  await sql`update mo_buckets set provider_config = '{"folderId":"root","mountMode":"rw"}' where name = ${bucket}`;
  const fetchMock = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("Drive unavailable", { status: 503 }),
  );
  assert.equal((await q.finishUpload(owner, pending.id!)).ok, false);
  assert.equal(
    (
      await q.completeMultipartUpload(owner, bucket, "late-multipart.bin", pendingMp.uploadId!, [
        { partNumber: 1, etag: pendingPart.etag! },
      ])
    ).ok,
    false,
  );
  fetchMock.mock.restore();
  // Failed publication retains parts, so the same upload can be retried.
  assert.ok((await q.finishUpload(owner, pending.id!)).ok);
  assert.ok(
    (
      await q.completeMultipartUpload(owner, bucket, "late-multipart.bin", pendingMp.uploadId!, [
        { partNumber: 1, etag: pendingPart.etag! },
      ])
    ).ok,
  );
  assert.deepEqual(files.get("late-console.bin")!.bytes, bytes);
  assert.deepEqual(files.get("late-multipart.bin")!.bytes, bytes);

  // A bucket-level Drive fix must retain local object-level public ACL behavior.
  await q.createBucket(owner, "review-local-private", "private");
  await q.putBytes(
    owner,
    "review-local-private",
    "public.txt",
    Buffer.from("public object"),
    "text/plain",
    {},
    "public-read",
  );
  assert.equal(
    await (
      await handleS3(new Request("http://localhost/api/s3/review-local-private/public.txt"))
    ).text(),
    "public object",
  );
});

test("recursive agent search covers nested keys and every page; browsing uses actual prefixes", async () => {
  const owner = "search-review-owner";
  const bucket = "search-review-bucket";
  await q.createBucket(owner, bucket, "private");
  const sql = await getSql();
  await sql`insert into mo_objects (id, bucket_id, key, size, content_type, etag, complete, headers)
    select 'review-search-' || n, b.id, 'docs/report-' || lpad(n::text, 4, '0') || '.txt', 0, 'text/plain', 'empty', true, '{}'
    from mo_buckets b cross join generate_series(1, 1010) n where b.name = ${bucket}`;
  const results = await searchBucket(owner, bucket, "REPORT-");
  assert.equal(results.length, 1010);
  assert.ok(results.some((result) => result.key === "docs/report-1010.txt"));
  const root = await q.browse(owner, bucket, "");
  assert.ok(root.ok);
  assert.deepEqual(root.folders, ["docs/"]);
  const first = await q.browse(owner, bucket, "docs/");
  assert.ok(first.ok);
  assert.equal(first.objects!.length, 50);
  assert.ok(first.nextStart);
  const second = await q.browse(owner, bucket, "docs/", first.nextStart!);
  assert.ok(second.ok);
  assert.notEqual(first.objects![0].key, second.objects![0].key);
});
