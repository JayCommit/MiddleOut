import assert from "node:assert/strict";
import { test } from "node:test";
import { handleS3 } from "./engine.server.ts";
import { readBoundedBody, BodyTooLarge, transportAddress } from "./body.ts";
import { objectResponseHeaders } from "../storage/response-headers.ts";
import * as q from "../storage/queries.server.ts";
import { verifySigV4, EMPTY_SHA256 } from "./sigv4.ts";

const owner = "security-review";
test("bucket-scoped keys cannot copy from another bucket or enumerate its name", async () => {
  await q.createBucket(owner, "security-allowed", false);
  await q.createBucket(owner, "security-secret", false);
  await q.putBytes(owner, "security-secret", "file", Buffer.from("private"), "text/plain", {});
  await q.putBytes(owner, "security-allowed", "file", Buffer.from("allowed"), "text/plain", {});
  const key = await q.createKey(owner, "scoped", "full", "security-allowed");
  assert.ok(key.ok);
  const headers = { authorization: `MO ${key.accessKeyId}:${key.secretKey}` };
  for (const source of [
    "/security-secret/file",
    "security-secret/file",
    "/security%2Dsecret/file",
  ]) {
    const result = await handleS3(
      new Request("http://localhost/api/s3/security-allowed/copied", {
        method: "PUT",
        headers: { ...headers, "x-amz-copy-source": source },
      }),
    );
    assert.equal(result.status, 403);
  }
  const normal = await handleS3(
    new Request("http://localhost/api/s3/security-allowed/copied", {
      method: "PUT",
      headers: { ...headers, "x-amz-copy-source": "/security-allowed/file" },
    }),
  );
  assert.equal(normal.status, 200);
  const listing = await (
    await handleS3(new Request("http://localhost/api/s3", { headers }))
  ).text();
  assert.match(listing, /security-allowed/);
  assert.doesNotMatch(listing, /security-secret/);
});

test("bounded reader cancels oversized streams before buffering the whole body", async () => {
  let consumed = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (consumed === 20) {
        controller.close();
        return;
      }
      consumed++;
      controller.enqueue(new Uint8Array(1024 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("http://localhost/", {
    method: "PUT",
    body: stream,
    duplex: "half",
  } as RequestInit);
  await assert.rejects(readBoundedBody(request, 12 * 1024 * 1024), BodyTooLarge);
  assert.ok(consumed < 20);
  assert.equal(cancelled, true);
  const small = await readBoundedBody(
    new Request("http://localhost/", { method: "PUT", body: "valid" }),
    12,
  );
  assert.equal(small.toString(), "valid");
});

test("forwarding headers cannot select the rate limit identity", () => {
  const request = new Request("http://localhost/", {
    headers: { "x-forwarded-for": "fake", "x-real-ip": "also-fake" },
  });
  assert.equal(transportAddress(request), "unknown");
  Object.defineProperty(request, "ip", { value: "127.0.0.1" });
  assert.equal(transportAddress(request), "127.0.0.1");
});

test("all unverified streaming representations are rejected before consuming bytes", async () => {
  for (const headers of [
    { "x-amz-content-sha256": "STREAMING-AWS4-HMAC-SHA256-PAYLOAD" },
    { "x-amz-content-sha256": "STREAMING-UNSIGNED-PAYLOAD-TRAILER" },
    { "content-encoding": "AWS-CHUNKED" },
    { "content-encoding": "gzip, aws-chunked" },
  ] as Record<string, string>[]) {
    const request = new Request("http://localhost/api/s3/security-allowed/file", {
      method: "PUT",
      headers,
      body: "invalid signed chunks",
    });
    assert.equal((await handleS3(request)).status, 501);
    assert.equal(request.bodyUsed, false);
  }
});

test("SigV4 rejects arbitrary and streaming payload markers", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  for (const marker of [
    "STREAMING-AWS4-HMAC-SHA256-PAYLOAD",
    "arbitrary",
    EMPTY_SHA256.toUpperCase(),
  ]) {
    const result = verifySigV4({
      request: new Request("http://localhost/", { headers: { "x-amz-content-sha256": marker } }),
      body: Buffer.from("tampered"),
      secret: "test",
      now,
      parsed: {
        accessKeyId: "test",
        dateStamp: "20261104",
        region: "us-east-1",
        service: "s3",
        signedHeaders: ["host"],
        signature: "0".repeat(64),
        amzDate: "20261104T120000Z",
        expiresSec: null,
        presigned: false,
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "InvalidRequest");
  }
});

test("object responses sandbox documents and sanitize download filenames", async () => {
  for (const type of ["text/html", "image/svg+xml", "application/xhtml+xml", "application/xml"]) {
    const headers = objectResponseHeaders(
      new Headers({
        "content-type": type,
        "content-security-policy": "default-src * 'unsafe-inline'",
      }),
      "evil\r\nname.html",
    );
    assert.match(headers.get("content-security-policy")!, /^sandbox;/);
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.match(headers.get("content-disposition")!, /^attachment;/);
    assert.doesNotMatch(headers.get("content-disposition")!, /[\r\n]/);
  }
  await q.createBucket("security-html", "security-html", true);
  await q.putBytes(
    "security-html",
    "security-html",
    "file",
    Buffer.from("<script>alert(1)</script>"),
    "text/html",
    { "content-security-policy": "default-src * 'unsafe-inline'", "x-content-type-options": "" },
  );
  for (const method of ["GET", "HEAD"]) {
    const result = await handleS3(
      new Request("http://localhost/api/s3/security-html/file", {
        method,
        headers: { range: "bytes=0-3" },
      }),
    );
    assert.equal(result.status, 206);
    assert.match(result.headers.get("content-security-policy")!, /^sandbox;/);
    assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  }
});

test("raw bucket CORS configuration cannot escape the S3 response sandbox", async () => {
  await q.createBucket("security-cors", "security-cors", false);
  const key = await q.createKey("security-cors", "cors");
  assert.ok(key.ok);
  await q.setBucketCors(
    "security-cors",
    "security-cors",
    '<html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>',
  );
  const response = await handleS3(
    new Request("http://localhost/api/s3/security-cors?cors", {
      headers: { authorization: `MO ${key.accessKeyId}:${key.secretKey}` },
    }),
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy")!, /^sandbox;/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("stored object headers cannot overwrite content-type or inject arbitrary response headers", async () => {
  await q.createBucket("security-hdrs", "security-hdrs", true);
  await q.putBytes(
    "security-hdrs",
    "security-hdrs",
    "disguised.bin",
    Buffer.from("<script>alert(1)</script>"),
    "text/html",
    {
      "content-type": "image/png",
      "set-cookie": "session=hijacked",
      "x-amz-meta-valid": "kept",
      "x-amz-meta-bad": "line1\r\nline2",
    },
  );
  const res = await handleS3(new Request("http://localhost/api/s3/security-hdrs/disguised.bin"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html");
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("x-amz-meta-valid"), "kept");
  assert.equal(res.headers.get("x-amz-meta-bad"), null);
  assert.match(res.headers.get("content-disposition")!, /^attachment;/);
});

test("active file extensions force attachment disposition even with passive content-type", () => {
  for (const name of ["exploit.html", "vector.svg", "worker.js", "doc.xhtml"]) {
    const headers = objectResponseHeaders(
      new Headers({ "content-type": "application/octet-stream" }),
      name,
    );
    assert.match(headers.get("content-disposition")!, /^attachment;/);
  }
});

test("object tags on public buckets are private to the owner and duplicate tag keys fail atomically", async () => {
  await q.createBucket("security-tags", "security-tags", true);
  await q.putBytes(
    "security-tags",
    "security-tags",
    "doc.txt",
    Buffer.from("hello"),
    "text/plain",
    {},
  );
  assert.equal(
    (await q.setTags("security-tags", "security-tags", "doc.txt", [{ key: "env", value: "prod" }]))
      .ok,
    true,
  );
  // Anonymous GET ?tagging on public bucket must be denied
  const anon = await handleS3(
    new Request("http://localhost/api/s3/security-tags/doc.txt?tagging"),
  );
  assert.equal(anon.status, 403);
  // Duplicate tag keys must be rejected without wiping existing tags
  const dup = await q.setTags("security-tags", "security-tags", "doc.txt", [
    { key: "dup", value: "1" },
    { key: "dup", value: "2" },
  ]);
  assert.equal(dup.ok, false);
  const retained = await q.getObjectTags("security-tags", "security-tags", "doc.txt");
  assert.ok(retained.ok);
  assert.deepEqual(retained.tags, [{ key: "env", value: "prod" }]);
});

test("malformed auth headers, unsigned host, and duplicate presigned parameters are rejected", async () => {
  await q.createBucket("security-auth", "security-auth", true);
  // Unrecognized Authorization header must not silently fall back to anonymous
  const badHeader = await handleS3(
    new Request("http://localhost/api/s3/security-auth", {
      headers: { authorization: "Bearer some-token" },
    }),
  );
  assert.equal(badHeader.status, 400);

  // Simultaneous Authorization header (AWS4 or MO) and presigned URL parameters must be rejected
  const bothAuthAws = await handleS3(
    new Request(
      "http://localhost/api/s3/security-auth?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=a%2F20261104%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261104T120000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=" +
        "a".repeat(64),
      {
        headers: {
          authorization:
            "AWS4-HMAC-SHA256 Credential=a/20261104/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=" +
            "b".repeat(64),
        },
      },
    ),
  );
  assert.equal(bothAuthAws.status, 400);

  const bothAuthMo = await handleS3(
    new Request(
      "http://localhost/api/s3/security-auth?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=a%2F20261104%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261104T120000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=" +
        "a".repeat(64),
      {
        headers: {
          authorization: "MO testkey:testsecret",
        },
      },
    ),
  );
  assert.equal(bothAuthMo.status, 400);

  // Duplicate presigned parameters must be rejected
  const dupPresign = await handleS3(
    new Request(
      "http://localhost/api/s3/security-auth?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=a%2F20261104%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20261104T120000Z&X-Amz-Expires=60&X-Amz-SignedHeaders=host&X-Amz-Signature=" +
        "a".repeat(64) +
        "&x-amz-signature=" +
        "b".repeat(64),
    ),
  );
  assert.equal(dupPresign.status, 400);

  // SigV4 without host in signedHeaders must fail
  const noHost = verifySigV4({
    request: new Request("http://localhost/"),
    body: Buffer.alloc(0),
    secret: "test",
    now: Date.parse("2026-11-04T12:00:00Z"),
    parsed: {
      accessKeyId: "test",
      dateStamp: "20261104",
      region: "us-east-1",
      service: "s3",
      signedHeaders: ["x-amz-date"],
      signature: "0".repeat(64),
      amzDate: "20261104T120000Z",
      expiresSec: null,
      presigned: false,
    },
  });
  assert.equal(noHost.ok, false);
});

test("XML unescaping does not double-unescape entities in batch delete or tagging", async () => {
  await q.createBucket("security-xml", "security-xml", false);
  const key = await q.createKey("security-xml", "xml");
  assert.ok(key.ok);
  const headers = { authorization: `MO ${key.accessKeyId}:${key.secretKey}` };
  await q.putBytes(
    "security-xml",
    "security-xml",
    "literal-&lt;-key",
    Buffer.from("1"),
    "text/plain",
    {},
  );
  await q.putBytes(
    "security-xml",
    "security-xml",
    "literal-<-key",
    Buffer.from("2"),
    "text/plain",
    {},
  );
  const delRes = await handleS3(
    new Request("http://localhost/api/s3/security-xml?delete", {
      method: "POST",
      headers,
      body: "<Delete><Object><Key>literal-&amp;lt;-key</Key></Object></Delete>",
    }),
  );
  assert.equal(delRes.status, 200);
  // literal-&lt;-key was deleted, while literal-<-key remains intact
  assert.ok("error" in (await q.readObjectFor("security-xml", "security-xml", "literal-&lt;-key")));
  assert.ok("object" in (await q.readObjectFor("security-xml", "security-xml", "literal-<-key")));
});

test("rate limiter isolates overflow buckets per prefix namespace", async () => {
  const { checkRateLimit } = await import("../rate-limiter.ts");
  // Fill up with dummy keys to trigger cardinality cap
  for (let i = 0; i < 10001; i++) {
    checkRateLimit(`dummy:${i}`, 10, 10);
  }
  // S3 overflow exhaustion should not exhaust auth overflow
  for (let i = 0; i < 15; i++) {
    checkRateLimit(`s3:newip_${i}`, 5, 1);
  }
  // s3 overflow is now depleted
  const s3Result = checkRateLimit("s3:overflow_test", 5, 1);
  assert.equal(s3Result.allowed, false);

  // But auth overflow should still have tokens
  const authResult = checkRateLimit("auth:fresh_ip", 5, 1);
  assert.equal(authResult.allowed, true);
});
