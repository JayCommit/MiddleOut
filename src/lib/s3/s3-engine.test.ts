import assert from "node:assert/strict";
import { test } from "node:test";
import { handleS3 } from "./engine.server.ts";
import { createBucket, createKey, putBytes } from "../storage/queries.server.ts";
import { checkRateLimit } from "../rate-limiter.ts";

test("checkRateLimit correctly tracks and limits tokens", () => {
  const key = `test-ip-${Date.now()}`;
  // 5 tokens capacity
  for (let i = 0; i < 5; i++) {
    const res = checkRateLimit(key, 5, 1);
    assert.equal(res.allowed, true);
  }
  // 6th should be rejected
  const blocked = checkRateLimit(key, 5, 1);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfter >= 1);
});

test("S3 endpoint: Anonymous request to non-existent bucket returns 404 NoSuchBucket", async () => {
  const req = new Request("http://localhost:8080/api/s3/non-existent-bucket-xyz", {
    method: "HEAD",
  });
  const res = await handleS3(req);
  assert.equal(res.status, 404);
  const text = await res.text();
  assert.match(text, /NoSuchBucket/);
});

test("S3 endpoint: Read-only access key blocks write operations", async () => {
  const ownerId = `ro-user-${Date.now()}`;
  await createBucket(ownerId, "ro-test-bucket", false);
  const keyRes = await createKey(ownerId, "ReadOnlyKey", "read-only");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;

  // Read should be permitted (e.g. HEAD bucket)
  const headReq = new Request("http://localhost:8080/api/s3/ro-test-bucket", {
    method: "HEAD",
    headers: { authorization: authHeader },
  });
  const headRes = await handleS3(headReq);
  assert.equal(headRes.status, 200);

  // Write (PUT object) must be rejected with 403
  const putReq = new Request("http://localhost:8080/api/s3/ro-test-bucket/file.txt", {
    method: "PUT",
    headers: {
      authorization: authHeader,
      "content-type": "text/plain",
    },
    body: "Hello World",
  });
  const putRes = await handleS3(putReq);
  assert.equal(putRes.status, 403);
  const xml = await putRes.text();
  assert.match(xml, /AccessDenied/);
  assert.match(xml, /Read-only/);
});

test("S3 endpoint: Scoped access key rejects operations on other buckets", async () => {
  const ownerId = `scope-user-${Date.now()}`;
  await createBucket(ownerId, "allowed-bucket", false);
  await createBucket(ownerId, "forbidden-bucket", false);
  const keyRes = await createKey(ownerId, "ScopedKey", "full", "allowed-bucket");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;

  // Allowed bucket
  const okReq = new Request("http://localhost:8080/api/s3/allowed-bucket", {
    method: "HEAD",
    headers: { authorization: authHeader },
  });
  const okRes = await handleS3(okReq);
  assert.equal(okRes.status, 200);

  // Forbidden bucket
  const badReq = new Request("http://localhost:8080/api/s3/forbidden-bucket", {
    method: "HEAD",
    headers: { authorization: authHeader },
  });
  const badRes = await handleS3(badReq);
  assert.equal(badRes.status, 403);
  const xml = await badRes.text();
  assert.match(xml, /AccessDenied/);
  assert.match(xml, /restricted/);
});

test("S3 endpoint: Conditional headers (If-Modified-Since and If-Unmodified-Since)", async () => {
  const ownerId = `cond-user-${Date.now()}`;
  await createBucket(ownerId, "cond-bucket", false);
  const keyRes = await createKey(ownerId, "CondKey", "full");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;

  // PUT an object
  await putBytes(ownerId, "cond-bucket", "test.txt", Buffer.from("content"), "text/plain", {});

  // If-Modified-Since in future -> 304 Not Modified
  const future = new Date(Date.now() + 60_000).toUTCString();
  const imsReq = new Request("http://localhost:8080/api/s3/cond-bucket/test.txt", {
    method: "GET",
    headers: {
      authorization: authHeader,
      "if-modified-since": future,
    },
  });
  const imsRes = await handleS3(imsReq);
  assert.equal(imsRes.status, 304);

  // If-Unmodified-Since in the past -> 412 Precondition Failed
  const past = new Date(Date.now() - 60_000).toUTCString();
  const iumsReq = new Request("http://localhost:8080/api/s3/cond-bucket/test.txt", {
    method: "GET",
    headers: {
      authorization: authHeader,
      "if-unmodified-since": past,
    },
  });
  const iumsRes = await handleS3(iumsReq);
  assert.equal(iumsRes.status, 412);
});

test("S3 endpoint: Object Tagging (?tagging)", async () => {
  const ownerId = `tag-user-${Date.now()}`;
  await createBucket(ownerId, "tag-bucket", false);
  const keyRes = await createKey(ownerId, "TagKey", "full");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;

  // PUT an object
  await putBytes(ownerId, "tag-bucket", "tagged.txt", Buffer.from("tagged file"), "text/plain", {});

  // PUT tags
  const putTagReq = new Request("http://localhost:8080/api/s3/tag-bucket/tagged.txt?tagging", {
    method: "PUT",
    headers: {
      authorization: authHeader,
      "content-type": "application/xml",
    },
    body: `<Tagging><TagSet><Tag><Key>Environment</Key><Value>Production</Value></Tag><Tag><Key>Project</Key><Value>MiddleOut</Value></Tag></TagSet></Tagging>`,
  });
  const putTagRes = await handleS3(putTagReq);
  assert.equal(putTagRes.status, 200);

  // GET tags
  const getTagReq = new Request("http://localhost:8080/api/s3/tag-bucket/tagged.txt?tagging", {
    method: "GET",
    headers: { authorization: authHeader },
  });
  const getTagRes = await handleS3(getTagReq);
  assert.equal(getTagRes.status, 200);
  const xml = await getTagRes.text();
  assert.match(xml, /<Key>Environment<\/Key>/);
  assert.match(xml, /<Value>Production<\/Value>/);
  assert.match(xml, /<Key>Project<\/Key>/);
  assert.match(xml, /<Value>MiddleOut<\/Value>/);

  // DELETE tags
  const delTagReq = new Request("http://localhost:8080/api/s3/tag-bucket/tagged.txt?tagging", {
    method: "DELETE",
    headers: { authorization: authHeader },
  });
  const delTagRes = await handleS3(delTagReq);
  assert.equal(delTagRes.status, 204);

  // GET tags again -> empty TagSet
  const getTagAgain = await handleS3(getTagReq);
  const xmlAgain = await getTagAgain.text();
  assert.doesNotMatch(xmlAgain, /<Key>Environment<\/Key>/);
});

test("S3 endpoint: Multipart Upload lifecycle (Initiate -> Upload Parts -> Complete)", async () => {
  const ownerId = `mp-user-${Date.now()}`;
  await createBucket(ownerId, "mp-bucket", false);
  const keyRes = await createKey(ownerId, "MpKey", "full");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;

  // 1. Initiate
  const initReq = new Request("http://localhost:8080/api/s3/mp-bucket/bigfile.bin?uploads", {
    method: "POST",
    headers: {
      authorization: authHeader,
      "content-type": "application/octet-stream",
    },
  });
  const initRes = await handleS3(initReq);
  assert.equal(initRes.status, 200);
  const initXml = await initRes.text();
  const uploadIdMatch = /<UploadId>(.*?)<\/UploadId>/.exec(initXml);
  assert.ok(uploadIdMatch);
  const uploadId = uploadIdMatch[1];

  // 2. Upload Part 1
  const part1Req = new Request(
    `http://localhost:8080/api/s3/mp-bucket/bigfile.bin?uploadId=${uploadId}&partNumber=1`,
    {
      method: "PUT",
      headers: { authorization: authHeader },
      body: Buffer.from("First part chunk data. "),
    },
  );
  const part1Res = await handleS3(part1Req);
  assert.equal(part1Res.status, 200);
  const etag1 = part1Res.headers.get("etag");
  assert.ok(etag1);

  // 3. Upload Part 2
  const part2Req = new Request(
    `http://localhost:8080/api/s3/mp-bucket/bigfile.bin?uploadId=${uploadId}&partNumber=2`,
    {
      method: "PUT",
      headers: { authorization: authHeader },
      body: Buffer.from("Second part chunk data."),
    },
  );
  const part2Res = await handleS3(part2Req);
  assert.equal(part2Res.status, 200);
  const etag2 = part2Res.headers.get("etag");
  assert.ok(etag2);

  // 4. List Parts
  const listPartsReq = new Request(
    `http://localhost:8080/api/s3/mp-bucket/bigfile.bin?uploadId=${uploadId}`,
    {
      method: "GET",
      headers: { authorization: authHeader },
    },
  );
  const listPartsRes = await handleS3(listPartsReq);
  assert.equal(listPartsRes.status, 200);
  const listPartsXml = await listPartsRes.text();
  assert.match(listPartsXml, /<PartNumber>1<\/PartNumber>/);
  assert.match(listPartsXml, /<PartNumber>2<\/PartNumber>/);

  // 5. Complete Multipart Upload
  const completeBody = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag1}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${etag2}</ETag></Part></CompleteMultipartUpload>`;
  const completeReq = new Request(
    `http://localhost:8080/api/s3/mp-bucket/bigfile.bin?uploadId=${uploadId}`,
    {
      method: "POST",
      headers: { authorization: authHeader },
      body: completeBody,
    },
  );
  const completeRes = await handleS3(completeReq);
  assert.equal(completeRes.status, 200);
  const completeXml = await completeRes.text();
  assert.match(completeXml, /<CompleteMultipartUploadResult/);

  // 6. Verify object GET
  const getReq = new Request("http://localhost:8080/api/s3/mp-bucket/bigfile.bin", {
    method: "GET",
    headers: { authorization: authHeader },
  });
  const getRes = await handleS3(getReq);
  assert.equal(getRes.status, 200);
  const content = await getRes.text();
  assert.equal(content, "First part chunk data. Second part chunk data.");
});

test("S3 endpoint: Multipart Upload abort lifecycle", async () => {
  const ownerId = `mp-abort-user-${Date.now()}`;
  await createBucket(ownerId, "mp-abort-bucket", false);
  const keyRes = await createKey(ownerId, "MpAbortKey", "full");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;

  // Initiate
  const initReq = new Request("http://localhost:8080/api/s3/mp-abort-bucket/abortme.bin?uploads", {
    method: "POST",
    headers: { authorization: authHeader },
  });
  const initRes = await handleS3(initReq);
  const initXml = await initRes.text();
  const uploadId = /<UploadId>(.*?)<\/UploadId>/.exec(initXml)![1];

  // Abort
  const abortReq = new Request(
    `http://localhost:8080/api/s3/mp-abort-bucket/abortme.bin?uploadId=${uploadId}`,
    {
      method: "DELETE",
      headers: { authorization: authHeader },
    },
  );
  const abortRes = await handleS3(abortReq);
  assert.equal(abortRes.status, 204);

  // List parts should now return 404 NoSuchUpload
  const listPartsReq = new Request(
    `http://localhost:8080/api/s3/mp-abort-bucket/abortme.bin?uploadId=${uploadId}`,
    {
      method: "GET",
      headers: { authorization: authHeader },
    },
  );
  const listPartsRes = await handleS3(listPartsReq);
  assert.equal(listPartsRes.status, 404);
});

test("S3 endpoint: DeleteObjects respects Quiet mode", async () => {
  const ownerId = `del-quiet-${Date.now()}`;
  await createBucket(ownerId, "del-quiet-bucket", false);
  const keyRes = await createKey(ownerId, "DelQuietKey", "full");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;
  await putBytes(ownerId, "del-quiet-bucket", "f1.txt", Buffer.from("1"), "text/plain", {});

  // Quiet delete
  const quietReq = new Request("http://localhost:8080/api/s3/del-quiet-bucket?delete", {
    method: "POST",
    headers: { authorization: authHeader },
    body: `<Delete><Quiet>true</Quiet><Object><Key>f1.txt</Key></Object></Delete>`,
  });
  const quietRes = await handleS3(quietReq);
  assert.equal(quietRes.status, 200);
  const xml = await quietRes.text();
  // In quiet mode, successfully deleted items are omitted
  assert.doesNotMatch(xml, /<Deleted>/);
});

test("S3 endpoint: Bucket and Object ACL support and anonymous access", async () => {
  const ownerId = `s3-acl-user-${Date.now()}`;
  await createBucket(ownerId, "s3-acl-bucket", "private");
  const keyRes = await createKey(ownerId, "AclTestKey", "full");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;

  // 1. GET bucket ACL (initially private)
  const getBktAclReq = new Request("http://localhost:8080/api/s3/s3-acl-bucket?acl", {
    method: "GET",
    headers: { authorization: authHeader },
  });
  const getBktAclRes = await handleS3(getBktAclReq);
  assert.equal(getBktAclRes.status, 200);
  const bktAclXml1 = await getBktAclRes.text();
  assert.match(bktAclXml1, /<AccessControlPolicy/);
  assert.match(bktAclXml1, /<Permission>FULL_CONTROL<\/Permission>/);
  assert.doesNotMatch(bktAclXml1, /AllUsers/);

  // 2. PUT bucket ACL with x-amz-acl: public-read
  const putBktAclReq = new Request("http://localhost:8080/api/s3/s3-acl-bucket?acl", {
    method: "PUT",
    headers: {
      authorization: authHeader,
      "x-amz-acl": "public-read",
    },
  });
  const putBktAclRes = await handleS3(putBktAclReq);
  assert.equal(putBktAclRes.status, 200);

  // Verify bucket ACL XML now has READ grant to AllUsers
  const getBktAclRes2 = await handleS3(getBktAclReq);
  const bktAclXml2 = await getBktAclRes2.text();
  assert.match(bktAclXml2, /AllUsers/);
  assert.match(bktAclXml2, /<Permission>READ<\/Permission>/);

  // Reset bucket to private
  await handleS3(
    new Request("http://localhost:8080/api/s3/s3-acl-bucket?acl", {
      method: "PUT",
      headers: { authorization: authHeader, "x-amz-acl": "private" },
    }),
  );

  // 3. PUT object with x-amz-acl: public-read in private bucket
  const putObjReq = new Request("http://localhost:8080/api/s3/s3-acl-bucket/public-item.txt", {
    method: "PUT",
    headers: {
      authorization: authHeader,
      "content-type": "text/plain",
      "x-amz-acl": "public-read",
    },
    body: "Public Content",
  });
  const putObjRes = await handleS3(putObjReq);
  assert.equal(putObjRes.status, 200);

  // 4. Anonymous GET should succeed for this public-read object!
  const anonGetReq = new Request("http://localhost:8080/api/s3/s3-acl-bucket/public-item.txt", {
    method: "GET",
  });
  const anonGetRes = await handleS3(anonGetReq);
  assert.equal(anonGetRes.status, 200);
  assert.equal(await anonGetRes.text(), "Public Content");

  // 5. GET object ACL
  const getObjAclReq = new Request(
    "http://localhost:8080/api/s3/s3-acl-bucket/public-item.txt?acl",
    {
      method: "GET",
      headers: { authorization: authHeader },
    },
  );
  const getObjAclRes = await handleS3(getObjAclReq);
  assert.equal(getObjAclRes.status, 200);
  const objAclXml = await getObjAclRes.text();
  assert.match(objAclXml, /AllUsers/);

  // 6. PUT object ACL back to private
  const putObjAclReq = new Request(
    "http://localhost:8080/api/s3/s3-acl-bucket/public-item.txt?acl",
    {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "x-amz-acl": "private",
      },
    },
  );
  const putObjAclRes = await handleS3(putObjAclReq);
  assert.equal(putObjAclRes.status, 200);

  // 7. Anonymous GET now returns 403 AccessDenied
  const anonGetReq2 = new Request("http://localhost:8080/api/s3/s3-acl-bucket/public-item.txt", {
    method: "GET",
  });
  const anonGetRes2 = await handleS3(anonGetReq2);
  assert.equal(anonGetRes2.status, 403);
});

test("S3 endpoint: Content-MD5 verification on PutObject and UploadPart", async () => {
  const { createHash } = await import("node:crypto");
  const ownerId = `md5-user-${Date.now()}`;
  await createBucket(ownerId, "md5-test-bucket", false);
  const keyRes = await createKey(ownerId, "Md5Key", "full");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;
  const content = "Hello MiddleOut Content-MD5 verification!";
  const validMd5 = createHash("md5").update(content).digest("base64");
  const wrongMd5 = createHash("md5").update("other content").digest("base64");

  // 1. PutObject with valid Content-MD5 succeeds
  const goodPut = await handleS3(
    new Request("http://localhost:8080/api/s3/md5-test-bucket/good.txt", {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "content-md5": validMd5,
        "content-type": "text/plain",
      },
      body: content,
    }),
  );
  assert.equal(goodPut.status, 200);

  // 2. PutObject with mismatched Content-MD5 returns 400 BadDigest
  const badPut = await handleS3(
    new Request("http://localhost:8080/api/s3/md5-test-bucket/bad.txt", {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "content-md5": wrongMd5,
        "content-type": "text/plain",
      },
      body: content,
    }),
  );
  assert.equal(badPut.status, 400);
  const badPutXml = await badPut.text();
  assert.match(badPutXml, /BadDigest/);

  // 3. PutObject with malformed Content-MD5 returns 400 InvalidDigest
  const malformedPut = await handleS3(
    new Request("http://localhost:8080/api/s3/md5-test-bucket/malformed.txt", {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "content-md5": "not-valid-base64!?",
        "content-type": "text/plain",
      },
      body: content,
    }),
  );
  assert.equal(malformedPut.status, 400);
  const malformedPutXml = await malformedPut.text();
  assert.match(malformedPutXml, /InvalidDigest/);

  // 4. UploadPart with valid and invalid Content-MD5
  const initRes = await handleS3(
    new Request("http://localhost:8080/api/s3/md5-test-bucket/mp.bin?uploads", {
      method: "POST",
      headers: { authorization: authHeader },
    }),
  );
  assert.equal(initRes.status, 200);
  const uploadIdMatch = /<UploadId>(.*?)<\/UploadId>/.exec(await initRes.text());
  assert.ok(uploadIdMatch?.[1]);
  const uploadId = uploadIdMatch[1];

  const partContent = "multipart part 1 content";
  const validPartMd5 = createHash("md5").update(partContent).digest("base64");

  const badPart = await handleS3(
    new Request(
      `http://localhost:8080/api/s3/md5-test-bucket/mp.bin?uploadId=${uploadId}&partNumber=1`,
      {
        method: "PUT",
        headers: {
          authorization: authHeader,
          "content-md5": wrongMd5,
        },
        body: partContent,
      },
    ),
  );
  assert.equal(badPart.status, 400);
  assert.match(await badPart.text(), /BadDigest/);

  const goodPart = await handleS3(
    new Request(
      `http://localhost:8080/api/s3/md5-test-bucket/mp.bin?uploadId=${uploadId}&partNumber=1`,
      {
        method: "PUT",
        headers: {
          authorization: authHeader,
          "content-md5": validPartMd5,
        },
        body: partContent,
      },
    ),
  );
  assert.equal(goodPart.status, 200);
});

test("S3 endpoint: ListObjects and ListObjectsV2 echo pagination markers and continuation tokens", async () => {
  const ownerId = `list-user-${Date.now()}`;
  await createBucket(ownerId, "list-echo-bucket", false);
  const keyRes = await createKey(ownerId, "ListKey", "full");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;
  for (const name of ["item1.txt", "item2.txt", "item3.txt"]) {
    await putBytes(ownerId, "list-echo-bucket", name, Buffer.from("data"), "text/plain", {});
  }

  // 1. ListObjectsV2 with start-after
  const listV2StartAfter = await handleS3(
    new Request(
      "http://localhost:8080/api/s3/list-echo-bucket?list-type=2&start-after=item1.txt&max-keys=1",
      {
        method: "GET",
        headers: { authorization: authHeader },
      },
    ),
  );
  assert.equal(listV2StartAfter.status, 200);
  const v2StartAfterXml = await listV2StartAfter.text();
  assert.match(v2StartAfterXml, /<StartAfter>item1\.txt<\/StartAfter>/);
  assert.match(v2StartAfterXml, /<NextContinuationToken>item2\.txt<\/NextContinuationToken>/);

  // 2. ListObjectsV2 with continuation-token
  const listV2Res = await handleS3(
    new Request(
      "http://localhost:8080/api/s3/list-echo-bucket?list-type=2&continuation-token=item1.txt&max-keys=1",
      {
        method: "GET",
        headers: { authorization: authHeader },
      },
    ),
  );
  assert.equal(listV2Res.status, 200);
  const v2Xml = await listV2Res.text();
  assert.match(v2Xml, /<ContinuationToken>item1\.txt<\/ContinuationToken>/);
  assert.match(v2Xml, /<NextContinuationToken>item2\.txt<\/NextContinuationToken>/);

  // 3. ListObjects (V1) with marker
  const listV1Res = await handleS3(
    new Request("http://localhost:8080/api/s3/list-echo-bucket?marker=item1.txt&max-keys=1", {
      method: "GET",
      headers: { authorization: authHeader },
    }),
  );
  assert.equal(listV1Res.status, 200);
  const v1Xml = await listV1Res.text();
  assert.match(v1Xml, /<Marker>item1\.txt<\/Marker>/);
  assert.match(v1Xml, /<NextMarker>item2\.txt<\/NextMarker>/);
});

test("S3 endpoint: CopyObject honors x-amz-metadata-directive, x-amz-acl and self-copy", async () => {
  const ownerId = `copy-user-${Date.now()}`;
  await createBucket(ownerId, "copy-src-bucket", false);
  await createBucket(ownerId, "copy-dst-bucket", false);
  const keyRes = await createKey(ownerId, "CopyKey", "full");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;

  // Upload source object with custom metadata
  const putRes = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-src-bucket/original.txt", {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "content-type": "text/plain",
        "x-amz-meta-author": "alice",
        "x-amz-meta-project": "middleout",
      },
      body: "Hello CopyObject",
    }),
  );
  assert.equal(putRes.status, 200);

  // 1. Invalid metadata directive returns 400 InvalidArgument
  const badDirective = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-dst-bucket/copy-bad.txt", {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "x-amz-copy-source": "/copy-src-bucket/original.txt",
        "x-amz-metadata-directive": "INVALID",
      },
    }),
  );
  assert.equal(badDirective.status, 400);
  assert.match(await badDirective.text(), /InvalidArgument/);

  // 2. Default COPY directive preserves metadata and content-type
  const copyDefault = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-dst-bucket/copy-default.txt", {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "x-amz-copy-source": "/copy-src-bucket/original.txt",
      },
    }),
  );
  assert.equal(copyDefault.status, 200);
  assert.match(await copyDefault.text(), /<CopyObjectResult/);

  const headDefault = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-dst-bucket/copy-default.txt", {
      method: "HEAD",
      headers: { authorization: authHeader },
    }),
  );
  assert.equal(headDefault.status, 200);
  assert.equal(headDefault.headers.get("content-type"), "text/plain");
  assert.equal(headDefault.headers.get("x-amz-meta-author"), "alice");
  assert.equal(headDefault.headers.get("x-amz-meta-project"), "middleout");

  // 3. REPLACE directive replaces metadata and content-type
  const copyReplace = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-dst-bucket/copy-replace.json", {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "x-amz-copy-source": "/copy-src-bucket/original.txt",
        "x-amz-metadata-directive": "REPLACE",
        "content-type": "application/json",
        "x-amz-meta-author": "bob",
      },
    }),
  );
  assert.equal(copyReplace.status, 200);

  const headReplace = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-dst-bucket/copy-replace.json", {
      method: "HEAD",
      headers: { authorization: authHeader },
    }),
  );
  assert.equal(headReplace.status, 200);
  assert.equal(headReplace.headers.get("content-type"), "application/json");
  assert.equal(headReplace.headers.get("x-amz-meta-author"), "bob");
  assert.equal(headReplace.headers.get("x-amz-meta-project"), null);

  // 4. x-amz-acl header sets public-read on copied object
  const copyPublic = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-dst-bucket/copy-public.txt", {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "x-amz-copy-source": "/copy-src-bucket/original.txt",
        "x-amz-acl": "public-read",
      },
    }),
  );
  assert.equal(copyPublic.status, 200);

  // Anonymous request to public copy should succeed
  const anonGet = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-dst-bucket/copy-public.txt", {
      method: "GET",
    }),
  );
  assert.equal(anonGet.status, 200);
  assert.equal(await anonGet.text(), "Hello CopyObject");

  // Anonymous request to private default copy should be rejected with 403
  const anonPrivate = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-dst-bucket/copy-default.txt", {
      method: "GET",
    }),
  );
  assert.equal(anonPrivate.status, 403);

  // 5. Self-copy with COPY directive fails with 400 InvalidRequest
  const selfCopyFail = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-src-bucket/original.txt", {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "x-amz-copy-source": "/copy-src-bucket/original.txt",
      },
    }),
  );
  assert.equal(selfCopyFail.status, 400);
  assert.match(await selfCopyFail.text(), /InvalidRequest/);

  // 6. Self-copy with REPLACE updates metadata in place
  const selfCopyUpdate = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-src-bucket/original.txt", {
      method: "PUT",
      headers: {
        authorization: authHeader,
        "x-amz-copy-source": "/copy-src-bucket/original.txt",
        "x-amz-metadata-directive": "REPLACE",
        "content-type": "text/markdown",
        "x-amz-meta-author": "charlie",
      },
    }),
  );
  assert.equal(selfCopyUpdate.status, 200);

  const headSelf = await handleS3(
    new Request("http://localhost:8080/api/s3/copy-src-bucket/original.txt", {
      method: "HEAD",
      headers: { authorization: authHeader },
    }),
  );
  assert.equal(headSelf.status, 200);
  assert.equal(headSelf.headers.get("content-type"), "text/markdown");
  assert.equal(headSelf.headers.get("x-amz-meta-author"), "charlie");
});

test("S3 endpoint: completeMultipartUpload streams parts across chunk boundaries correctly", async () => {
  const ownerId = `mp-stream-user-${Date.now()}`;
  await createBucket(ownerId, "mp-stream-bucket", false);
  const keyRes = await createKey(ownerId, "MpKey", "full");
  assert.equal(keyRes.ok, true);
  if (!keyRes.ok) return;

  const authHeader = `MO ${keyRes.accessKeyId}:${keyRes.secretKey}`;

  // Initiate multipart upload
  const initRes = await handleS3(
    new Request("http://localhost:8080/api/s3/mp-stream-bucket/large.bin?uploads", {
      method: "POST",
      headers: { authorization: authHeader },
    }),
  );
  assert.equal(initRes.status, 200);
  const initXml = await initRes.text();
  const uploadIdMatch = initXml.match(/<UploadId>(.+?)<\/UploadId>/);
  assert.ok(uploadIdMatch);
  const uploadId = uploadIdMatch[1];

  // Upload 2 parts of 200KB each (CHUNK_BYTES is 192KB = 196608 bytes)
  // This verifies that chunking slices across part boundaries properly
  const part1Data = Buffer.alloc(200 * 1024, 0x41); // 200KB 'A'
  const part2Data = Buffer.alloc(200 * 1024, 0x42); // 200KB 'B'

  const p1Res = await handleS3(
    new Request(
      `http://localhost:8080/api/s3/mp-stream-bucket/large.bin?uploadId=${uploadId}&partNumber=1`,
      {
        method: "PUT",
        headers: { authorization: authHeader },
        body: part1Data,
      },
    ),
  );
  assert.equal(p1Res.status, 200);
  const etag1 = p1Res.headers.get("etag")!;
  assert.ok(etag1);

  const p2Res = await handleS3(
    new Request(
      `http://localhost:8080/api/s3/mp-stream-bucket/large.bin?uploadId=${uploadId}&partNumber=2`,
      {
        method: "PUT",
        headers: { authorization: authHeader },
        body: part2Data,
      },
    ),
  );
  assert.equal(p2Res.status, 200);
  const etag2 = p2Res.headers.get("etag")!;
  assert.ok(etag2);

  // Complete multipart upload
  const completeBody = `<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>${etag1}</ETag></Part><Part><PartNumber>2</PartNumber><ETag>${etag2}</ETag></Part></CompleteMultipartUpload>`;
  const compRes = await handleS3(
    new Request(`http://localhost:8080/api/s3/mp-stream-bucket/large.bin?uploadId=${uploadId}`, {
      method: "POST",
      headers: { authorization: authHeader },
      body: completeBody,
    }),
  );
  assert.equal(compRes.status, 200);
  const compXml = await compRes.text();
  assert.match(compXml, /<CompleteMultipartUploadResult/);
  assert.match(compXml, /-2"?<\/ETag>/);

  // Verify object content and size
  const getRes = await handleS3(
    new Request("http://localhost:8080/api/s3/mp-stream-bucket/large.bin", {
      method: "GET",
      headers: { authorization: authHeader },
    }),
  );
  assert.equal(getRes.status, 200);
  assert.equal(getRes.headers.get("content-length"), "409600");
  const bytes = Buffer.from(await getRes.arrayBuffer());
  assert.equal(bytes.length, 400 * 1024);
  assert.deepEqual(bytes.subarray(0, 200 * 1024), part1Data);
  assert.deepEqual(bytes.subarray(200 * 1024), part2Data);
});
