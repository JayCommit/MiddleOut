import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRequest,
  decodeAwsChunked,
  signatureHex,
  signingKey,
  stringToSign,
  verifySigV4,
} from "./sigv4.ts";

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

test("header SigV4 matches the AWS GET Object example", () => {
  const headers = new Headers({
    host: "examplebucket.s3.amazonaws.com",
    range: "bytes=0-9",
    "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "x-amz-date": "20130524T000000Z",
  });
  const canonical = canonicalRequest({
    method: "GET",
    uri: "/test.txt",
    query: "",
    headers,
    signedHeaders: ["host", "range", "x-amz-content-sha256", "x-amz-date"],
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  });
  const toSign = stringToSign(
    "20130524T000000Z",
    "20130524/us-east-1/s3/aws4_request",
    canonical,
  );
  assert.equal(
    stringToSign("20130524T000000Z", "20130524/us-east-1/s3/aws4_request", canonical).split("\n")[3],
    "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
  );
  const sig = signatureHex(signingKey(SECRET, "20130524", "us-east-1", "s3"), toSign);
  assert.equal(sig, "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

test("presigned query signature matches the AWS example", () => {
  const url = new URL(
    "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
  );
  const request = new Request(url, { method: "GET", headers: { host: "examplebucket.s3.amazonaws.com" } });
  const result = verifySigV4({
    request,
    body: Buffer.alloc(0),
    secret: SECRET,
    parsed: {
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      dateStamp: "20130524",
      region: "us-east-1",
      service: "s3",
      signedHeaders: ["host"],
      signature: "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
      amzDate: "20130524T000000Z",
      expiresSec: 86400,
      presigned: true,
    },
    now: Date.parse("2013-05-24T00:00:00Z"),
  });
  assert.equal(result.ok, true);
});

test("aws-chunked body decodes to the raw bytes", () => {
  const raw = Buffer.from("5;chunk-signature=abc\r\nhello\r\n0;chunk-signature=def\r\n\r\n");
  assert.equal(decodeAwsChunked(raw).toString(), "hello");
});
