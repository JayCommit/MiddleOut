import { objectResponseHeaders } from "../storage/response-headers.ts";
import { BodyTooLarge, readBoundedBody, transportAddress } from "./body.ts";
import {
  abortMultipartUpload,
  authenticateAccessKey,
  bucketRecord,
  completeMultipartUpload,
  copyObject,
  createBucket,
  deleteBucket,
  deleteBucketCors,
  deleteBucketPolicy,
  deleteObjectTags,
  getBucketCors,
  getBucketPolicy,
  getObjectTags,
  initiateMultipartUpload,
  listForS3,
  listMultipartParts,
  listMultipartUploads,
  listOwnedBuckets,
  putBytes,
  readObjectFor,
  removeObject,
  secretForAccessKey,
  setBucketAccess,
  setBucketCors,
  setBucketPolicy,
  setTags,
  uploadMultipartPart,
} from "../storage/queries.server.ts";
import { crc32Base64, parseAuthorization, verifySigV4 } from "./sigv4.ts";
import {
  completeMultipartUploadXml,
  initiateMultipartUploadXml,
  listBucketsXml,
  listMultipartUploadsXml,
  listObjectsXml,
  listPartsXml,
  parseTaggingXml,
  taggingXml,
  withCors,
  xmlError,
  xmlEscape,
  xmlResponse,
} from "./xml.ts";
import { checkRateLimit } from "../rate-limiter.ts";

const MAX_BODY = 12 * 1024 * 1024;

function splitPath(pathname: string): { bucket?: string; key?: string } {
  const marker = "/api/s3";
  const at = pathname.indexOf(marker);
  let rest = at >= 0 ? pathname.slice(at + marker.length) : pathname;
  if (rest.startsWith("/")) rest = rest.slice(1);
  if (!rest) return {};
  const slash = rest.indexOf("/");
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  if (slash === -1) return { bucket: decode(rest) };
  const key = decode(rest.slice(slash + 1));
  return { bucket: decode(rest.slice(0, slash)), key: key || undefined };
}

function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "bad" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "bad";
  if (size === 0) return "bad";
  let start: number;
  let end: number;
  if (match[1] === "") {
    const tail = Number(match[2]);
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start)
    return "bad";
  return { start, end: Math.min(end, size - 1) };
}

function unescapeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function deleteKeys(xml: string): string[] {
  const keys: string[] = [];
  const re = /<Key>([\s\S]*?)<\/Key>/g;
  for (let match = re.exec(xml); match; match = re.exec(xml))
    keys.push(unescapeXml(match[1] ?? ""));
  return keys;
}

function parseCompleteParts(xml: string): { partNumber: number; etag: string }[] {
  const parts: { partNumber: number; etag: string }[] = [];
  const re = /<Part>([\s\S]*?)<\/Part>/g;
  let match = re.exec(xml);
  while (match) {
    const block = match[1] ?? "";
    const numMatch = /<PartNumber>\s*(\d+)\s*<\/PartNumber>/.exec(block);
    const etagMatch = /<ETag>\s*([\s\S]*?)\s*<\/ETag>/.exec(block);
    if (numMatch && etagMatch) {
      parts.push({
        partNumber: parseInt(numMatch[1] ?? "0", 10),
        etag: unescapeXml(etagMatch[1] ?? "").replace(/^"|"$/g, ""),
      });
    }
    match = re.exec(xml);
  }
  return parts;
}

function metaHeaders(request: Request, bytes: Buffer): Record<string, string> {
  const extra: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (key.startsWith("x-amz-meta-") || key.startsWith("x-amz-checksum-")) extra[key] = value;
  });
  const algo = (request.headers.get("x-amz-sdk-checksum-algorithm") ?? "").toUpperCase();
  if (algo === "CRC32" || request.headers.get("x-amz-checksum-crc32")) {
    extra["x-amz-checksum-crc32"] = crc32Base64(bytes);
  }
  const encoding = request.headers.get("content-encoding");
  if (encoding && !encoding.includes("aws-chunked")) extra["content-encoding"] = encoding;
  return extra;
}

export async function handleS3(request: Request, now = Date.now()): Promise<Response> {
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

  // Rate limiting check
  const ip = transportAddress(request);
  const rateLimit = checkRateLimit(`s3:${ip}`, 180, 30);
  if (!rateLimit.allowed) {
    const res = xmlError(429, "SlowDown", "Please reduce your request rate.");
    res.headers.set("retry-after", String(rateLimit.retryAfter));
    return withCors(res);
  }

  const declared = request.headers.get("x-amz-content-sha256") || "";
  const encoding = request.headers.get("content-encoding") || "";
  if (
    declared.toUpperCase().startsWith("STREAMING-") ||
    /(?:^|,)\s*aws-chunked\s*(?:,|$)/i.test(encoding)
  ) {
    return withCors(
      xmlError(
        501,
        "NotImplemented",
        "Streaming payload signatures and aws-chunked uploads are unsupported. Use a single PUT or multipart upload.",
      ),
    );
  }
  let body: Buffer;
  try {
    body = await readBoundedBody(request, MAX_BODY);
  } catch (error) {
    if (
      error instanceof BodyTooLarge ||
      (error as { status?: number; statusCode?: number }).status === 413 ||
      (error as { statusCode?: number }).statusCode === 413
    )
      return withCors(xmlError(413, "EntityTooLarge", "Request body exceeds 12 MiB."));
    return withCors(xmlError(400, "InvalidRequest", "Could not read the request body."));
  }

  const mo = request.headers.get("authorization") ?? "";
  let ownerId: string | null = null;
  let keyPermission: "full" | "read-only" = "full";
  let keyBucketScope: string | null = null;

  if (mo.startsWith("MO ")) {
    const raw = mo.slice(3).trim();
    const split = raw.indexOf(":");
    if (split <= 0)
      return withCors(xmlError(403, "InvalidAccessKeyId", "Access key is malformed."));
    const auth = await authenticateAccessKey(raw.slice(0, split), raw.slice(split + 1));
    if (!auth)
      return withCors(xmlError(403, "InvalidAccessKeyId", "The access key or secret is wrong."));
    ownerId = auth.ownerId;
    keyPermission = auth.permission;
    keyBucketScope = auth.bucketScope;
  } else {
    const parsed = parseAuthorization(request);
    if (parsed && "error" in parsed) {
      return withCors(xmlError(400, "AuthorizationHeaderMalformed", parsed.error));
    }
    if (parsed) {
      const key = await secretForAccessKey(parsed.accessKeyId);
      if (!key)
        return withCors(xmlError(403, "InvalidAccessKeyId", "The access key ID does not exist."));
      const verified = verifySigV4({ request, body, secret: key.secret_key, parsed, now });
      if (!verified.ok) return withCors(xmlError(403, verified.code, verified.message));
      ownerId = key.owner_id;
      keyPermission = key.permission;
      keyBucketScope = key.bucket_scope;
    }
  }

  const url = new URL(request.url);
  const { bucket, key } = splitPath(url.pathname);
  const method = request.method.toUpperCase();

  // Enforce Bucket Scoping
  if (bucket && keyBucketScope && bucket !== keyBucketScope) {
    return withCors(
      xmlError(
        403,
        "AccessDenied",
        "Access key is restricted to a different bucket.",
        `/${bucket}`,
      ),
    );
  }

  // Enforce Read-Only Permission
  const isMutation = method === "PUT" || method === "POST" || method === "DELETE";
  if (isMutation && keyPermission === "read-only") {
    return withCors(
      xmlError(403, "AccessDenied", "Read-only access key cannot perform write operations."),
    );
  }

  // Root operations (ListBuckets)
  if (!bucket) {
    if (method !== "GET" && method !== "HEAD") {
      return withCors(xmlError(405, "MethodNotAllowed", "The specified method is not allowed."));
    }
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const buckets = await listOwnedBuckets(ownerId);
    const xml = listBucketsXml(
      keyBucketScope ? buckets.filter((entry) => entry.name === keyBucketScope) : buckets,
      ownerId,
    );
    return withCors(xmlResponse(200, method === "HEAD" ? "" : xml));
  }

  // Policies from older releases were stored without enforcement. Fail closed
  // until the owner removes them; new policy writes are explicitly unsupported.
  const recordWithPolicy = await bucketRecord(bucket);
  if (
    recordWithPolicy &&
    recordWithPolicy.policy !== null &&
    !(url.searchParams.has("policy") && !key && (method === "GET" || method === "DELETE"))
  ) {
    return withCors(
      xmlError(
        501,
        "NotImplemented",
        "Bucket policies are unsupported. Remove the existing policy before using this bucket.",
      ),
    );
  }

  // Location Constraint
  if (url.searchParams.has("location") && !key && (method === "GET" || method === "HEAD")) {
    const record = await bucketRecord(bucket);
    if (!record)
      return withCors(xmlError(404, "NoSuchBucket", "The bucket does not exist.", `/${bucket}`));
    if (!ownerId || record.owner_id !== ownerId)
      return withCors(xmlError(403, "AccessDenied", "Access denied.", `/${bucket}`));
    const region = record.region === "us-east-1" ? "" : record.region;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${xmlEscape(region)}</LocationConstraint>`;
    return withCors(xmlResponse(200, method === "HEAD" ? "" : xml));
  }

  // Bucket ACL
  if (url.searchParams.has("acl") && !key && method === "GET") {
    const record = await bucketRecord(bucket);
    if (!record)
      return withCors(xmlError(404, "NoSuchBucket", "The bucket does not exist.", `/${bucket}`));
    if (!ownerId || record.owner_id !== ownerId)
      return withCors(xmlError(403, "AccessDenied", "Access denied.", `/${bucket}`));
    const allUsers = record.isPublic
      ? `<Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="Group"><URI>http://acs.amazonaws.com/groups/global/AllUsers</URI></Grantee><Permission>READ</Permission></Grant>`
      : "";
    const xml = `<?xml version="1.0" encoding="UTF-8"?><AccessControlPolicy><Owner><ID>${xmlEscape(ownerId)}</ID><DisplayName>${xmlEscape(ownerId)}</DisplayName></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>${xmlEscape(ownerId)}</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant>${allUsers}</AccessControlList></AccessControlPolicy>`;
    return withCors(xmlResponse(200, xml));
  }

  if (url.searchParams.has("acl") && !key && method === "PUT") {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const canned = request.headers.get("x-amz-acl") ?? "";
    const text = body.toString("utf8");
    const isPublic =
      canned === "public-read" || canned === "public-read-write" || text.includes("AllUsers");
    const updated = await setBucketAccess(ownerId, bucket, isPublic && canned !== "private");
    if (!updated.ok) return withCors(xmlError(404, "NoSuchBucket", updated.error, `/${bucket}`));
    return withCors(new Response(null, { status: 200 }));
  }

  // Bucket CORS
  if (url.searchParams.has("cors") && !key) {
    if (method === "GET") {
      if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
      const res = await getBucketCors(ownerId, bucket);
      if (!res.ok) {
        return withCors(
          xmlError(
            res.error === "NoSuchBucket" ? 404 : 404,
            res.error,
            res.error === "NoSuchBucket"
              ? "The bucket does not exist."
              : "The CORS configuration does not exist.",
            `/${bucket}`,
          ),
        );
      }
      return withCors(xmlResponse(200, res.corsRules));
    }
    if (method === "PUT") {
      if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
      const res = await setBucketCors(ownerId, bucket, body.toString("utf8"));
      if (!res.ok)
        return withCors(xmlError(404, "NoSuchBucket", "The bucket does not exist.", `/${bucket}`));
      return withCors(new Response(null, { status: 200 }));
    }
    if (method === "DELETE") {
      if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
      const res = await deleteBucketCors(ownerId, bucket);
      if (!res.ok)
        return withCors(xmlError(404, "NoSuchBucket", "The bucket does not exist.", `/${bucket}`));
      return withCors(new Response(null, { status: 204 }));
    }
  }

  // Bucket Policy
  if (url.searchParams.has("policy") && !key) {
    if (method === "GET") {
      if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
      const res = await getBucketPolicy(ownerId, bucket);
      if (!res.ok) {
        return withCors(
          xmlError(
            404,
            res.error,
            res.error === "NoSuchBucket"
              ? "The bucket does not exist."
              : "The bucket policy does not exist.",
            `/${bucket}`,
          ),
        );
      }
      return withCors(
        new Response(res.policy, { status: 200, headers: { "content-type": "application/json" } }),
      );
    }
    if (method === "PUT") {
      if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
      const res = await setBucketPolicy(ownerId, bucket, body.toString("utf8"));
      if (!res.ok)
        return withCors(
          xmlError(501, "NotImplemented", "Bucket policies are not supported.", `/${bucket}`),
        );
      return withCors(new Response(null, { status: 204 }));
    }
    if (method === "DELETE") {
      if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
      const res = await deleteBucketPolicy(ownerId, bucket);
      if (!res.ok)
        return withCors(xmlError(404, "NoSuchBucket", "The bucket does not exist.", `/${bucket}`));
      return withCors(new Response(null, { status: 204 }));
    }
  }

  // List Multipart Uploads for Bucket (GET /bucket?uploads)
  if (!key && method === "GET" && url.searchParams.has("uploads")) {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const prefix = url.searchParams.get("prefix") ?? "";
    const listRes = await listMultipartUploads(ownerId, bucket, prefix);
    if (!listRes.ok)
      return withCors(xmlError(404, "NoSuchBucket", "The bucket does not exist.", `/${bucket}`));
    const xml = listMultipartUploadsXml({ bucket, uploads: listRes.uploads });
    return withCors(xmlResponse(200, xml));
  }

  // Create Bucket
  if (!key && method === "PUT") {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const acl = request.headers.get("x-amz-acl") ?? "";
    const created = await createBucket(
      ownerId,
      bucket,
      acl === "public-read" || acl === "public-read-write",
    );
    if (!created.ok) {
      const code =
        created.error.includes("taken") || created.error.includes("already")
          ? "BucketAlreadyExists"
          : "InvalidBucketName";
      return withCors(
        xmlError(code === "BucketAlreadyExists" ? 409 : 400, code, created.error, `/${bucket}`),
      );
    }
    return withCors(new Response(null, { status: 200 }));
  }

  // Delete Bucket
  if (!key && method === "DELETE") {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const removed = await deleteBucket(ownerId, bucket, false);
    if (!removed.ok) {
      const code = removed.error.includes("not empty") ? "BucketNotEmpty" : "NoSuchBucket";
      return withCors(
        xmlError(code === "BucketNotEmpty" ? 409 : 404, code, removed.error, `/${bucket}`),
      );
    }
    return withCors(new Response(null, { status: 204 }));
  }

  // Head Bucket
  if (!key && method === "HEAD") {
    const record = await bucketRecord(bucket);
    if (!record)
      return withCors(xmlError(404, "NoSuchBucket", "The bucket does not exist.", `/${bucket}`));
    if (record.owner_id !== ownerId && !record.isPublic)
      return withCors(xmlError(403, "AccessDenied", "Access denied.", `/${bucket}`));
    return withCors(
      new Response(null, { status: 200, headers: { "x-amz-bucket-region": record.region } }),
    );
  }

  // Batch Delete Objects (POST /bucket?delete)
  if (!key && method === "POST" && url.searchParams.has("delete")) {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const record = await bucketRecord(bucket);
    if (!record || record.owner_id !== ownerId)
      return withCors(xmlError(404, "NoSuchBucket", "The bucket does not exist.", `/${bucket}`));

    const text = body.toString("utf8");
    const isQuiet = /<Quiet>\s*true\s*<\/Quiet>/i.test(text);
    const deleted: string[] = [];
    const errors: { key: string; code: string; message: string }[] = [];

    for (const objectKey of deleteKeys(text)) {
      const result = await removeObject(ownerId, bucket, objectKey);
      if (result.ok) {
        deleted.push(objectKey);
      } else {
        errors.push({
          key: objectKey,
          code: result.code || "NoSuchKey",
          message: result.error || "Delete failed",
        });
      }
    }

    const deletedXml = isQuiet
      ? ""
      : deleted.map((item) => `<Deleted><Key>${xmlEscape(item)}</Key></Deleted>`).join("");
    const errorXml = errors
      .map(
        (e) =>
          `<Error><Key>${xmlEscape(e.key)}</Key><Code>${xmlEscape(e.code)}</Code><Message>${xmlEscape(e.message)}</Message></Error>`,
      )
      .join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${deletedXml}${errorXml}</DeleteResult>`;
    return withCors(xmlResponse(200, xml));
  }

  // List Objects
  if (!key && (method === "GET" || method === "HEAD")) {
    const prefix = url.searchParams.get("prefix") ?? "";
    const delimiter = url.searchParams.get("delimiter") ?? "";
    const maxKeys = Number(url.searchParams.get("max-keys") ?? "1000");
    const start =
      url.searchParams.get("continuation-token") ??
      url.searchParams.get("start-after") ??
      url.searchParams.get("marker") ??
      "";
    const listed = await listForS3(ownerId, bucket, prefix, delimiter, maxKeys, start);
    if ("error" in listed) {
      const status = listed.error === "NoSuchBucket" ? 404 : 403;
      const code = status === 404 ? "NoSuchBucket" : "AccessDenied";
      return withCors(
        xmlError(
          status,
          code,
          code === "NoSuchBucket" ? "The bucket does not exist." : "Access denied.",
          `/${bucket}`,
        ),
      );
    }
    const xml = listObjectsXml({
      v2: url.searchParams.get("list-type") === "2",
      bucket,
      prefix,
      delimiter,
      maxKeys: Math.min(1000, Math.max(0, maxKeys || 1000)),
      contents: listed.contents,
      prefixes: listed.prefixes,
      truncated: listed.truncated,
      next: listed.nextStart,
    });
    return withCors(xmlResponse(200, method === "HEAD" ? "" : xml));
  }

  // --- OBJECT-LEVEL OPERATIONS ---

  // Object Tagging (?tagging)
  if (key && url.searchParams.has("tagging")) {
    if (method === "GET") {
      const tagRes = await getObjectTags(ownerId, bucket, key);
      if (!tagRes.ok) {
        const code =
          tagRes.error === "NoSuchBucket"
            ? "NoSuchBucket"
            : tagRes.error === "NoSuchKey"
              ? "NoSuchKey"
              : "AccessDenied";
        return withCors(
          xmlError(
            code === "AccessDenied" ? 403 : 404,
            code,
            "Error reading object tags.",
            `/${bucket}/${key}`,
          ),
        );
      }
      return withCors(xmlResponse(200, taggingXml(tagRes.tags)));
    }
    if (method === "PUT") {
      if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
      const parsedTags = parseTaggingXml(body.toString("utf8"));
      const setRes = await setTags(ownerId, bucket, key, parsedTags);
      if (!setRes.ok) {
        return withCors(xmlError(400, "InvalidArgument", setRes.error, `/${bucket}/${key}`));
      }
      return withCors(new Response(null, { status: 200 }));
    }
    if (method === "DELETE") {
      if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
      const delRes = await deleteObjectTags(ownerId, bucket, key);
      if (!delRes.ok) {
        return withCors(xmlError(404, delRes.error, "Could not delete tags.", `/${bucket}/${key}`));
      }
      return withCors(new Response(null, { status: 204 }));
    }
  }

  // Initiate Multipart Upload (POST /bucket/key?uploads)
  if (key && method === "POST" && url.searchParams.has("uploads")) {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const contentType = request.headers.get("content-type") || "application/octet-stream";
    const res = await initiateMultipartUpload(
      ownerId,
      bucket,
      key,
      contentType,
      metaHeaders(request, body),
    );
    if (!res.ok) {
      return withCors(
        xmlError(
          res.code === "NoSuchBucket" ? 404 : 400,
          res.code ?? "InvalidArgument",
          res.error,
          `/${bucket}/${key}`,
        ),
      );
    }
    return withCors(xmlResponse(200, initiateMultipartUploadXml(bucket, key, res.uploadId)));
  }

  // Upload Part (PUT /bucket/key?uploadId=xxx&partNumber=n)
  if (
    key &&
    method === "PUT" &&
    url.searchParams.has("uploadId") &&
    url.searchParams.has("partNumber")
  ) {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const partNum = parseInt(url.searchParams.get("partNumber") ?? "0", 10);
    const res = await uploadMultipartPart(ownerId, bucket, key, uploadId, partNum, body);
    if (!res.ok) {
      return withCors(
        xmlError(
          res.code === "NoSuchUpload" ? 404 : 400,
          res.code ?? "InvalidArgument",
          res.error,
          `/${bucket}/${key}`,
        ),
      );
    }
    const headers = new Headers({ etag: `"${res.etag}"` });
    return withCors(new Response(null, { status: 200, headers }));
  }

  // Complete Multipart Upload (POST /bucket/key?uploadId=xxx)
  if (key && method === "POST" && url.searchParams.has("uploadId")) {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const parts = parseCompleteParts(body.toString("utf8"));
    const res = await completeMultipartUpload(ownerId, bucket, key, uploadId, parts);
    if (!res.ok) {
      return withCors(
        xmlError(
          res.code === "NoSuchUpload" ? 404 : 400,
          res.code ?? "InvalidArgument",
          res.error,
          `/${bucket}/${key}`,
        ),
      );
    }
    return withCors(
      xmlResponse(200, completeMultipartUploadXml(bucket, key, res.etag, res.location)),
    );
  }

  // Abort Multipart Upload (DELETE /bucket/key?uploadId=xxx)
  if (key && method === "DELETE" && url.searchParams.has("uploadId")) {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const res = await abortMultipartUpload(ownerId, bucket, key, uploadId);
    if (!res.ok) return withCors(xmlError(404, "NoSuchUpload", res.error, `/${bucket}/${key}`));
    return withCors(new Response(null, { status: 204 }));
  }

  // List Parts (GET /bucket/key?uploadId=xxx)
  if (key && method === "GET" && url.searchParams.has("uploadId")) {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const uploadId = url.searchParams.get("uploadId") ?? "";
    const res = await listMultipartParts(ownerId, bucket, key, uploadId);
    if (!res.ok) return withCors(xmlError(404, "NoSuchUpload", res.error, `/${bucket}/${key}`));
    return withCors(xmlResponse(200, listPartsXml(res)));
  }

  // Copy Object
  if (key && method === "PUT" && request.headers.get("x-amz-copy-source")) {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const source = request.headers.get("x-amz-copy-source") ?? "";
    const clean = source.startsWith("/") ? source.slice(1) : source;
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      decoded = clean;
    }
    const slash = decoded.indexOf("/");
    if (slash <= 0)
      return withCors(xmlError(400, "InvalidArgument", "x-amz-copy-source is invalid."));
    if (keyBucketScope && decoded.slice(0, slash) !== keyBucketScope) {
      return withCors(xmlError(403, "AccessDenied", "Access key cannot read the source bucket."));
    }
    const copied = await copyObject(
      ownerId,
      decoded.slice(0, slash),
      decoded.slice(slash + 1),
      bucket,
      key,
    );
    if (!copied.ok) {
      const code = copied.code ?? "AccessDenied";
      return withCors(
        xmlError(
          code === "NoSuchBucket" || code === "NoSuchKey" ? 404 : 403,
          code,
          copied.error ?? "Request failed",
        ),
      );
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LastModified>${copied.updatedAt}</LastModified><ETag>"${copied.etag}"</ETag></CopyObjectResult>`;
    return withCors(xmlResponse(200, xml));
  }

  // Put Object
  if (key && method === "PUT") {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const type = request.headers.get("content-type") || "application/octet-stream";
    const written = await putBytes(ownerId, bucket, key, body, type, metaHeaders(request, body));
    if (!written.ok) {
      const status =
        written.code === "NoSuchBucket" ? 404 : written.code === "EntityTooLarge" ? 400 : 400;
      return withCors(
        xmlError(status, written.code ?? "InvalidArgument", written.error, `/${bucket}/${key}`),
      );
    }
    const headers = new Headers({ etag: `"${written.etag}"` });
    const checksum = metaHeaders(request, body)["x-amz-checksum-crc32"];
    if (checksum) headers.set("x-amz-checksum-crc32", checksum);
    return withCors(new Response(null, { status: 200, headers }));
  }

  // Delete Object
  if (key && method === "DELETE") {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const removed = await removeObject(ownerId, bucket, key);
    if (!removed.ok && removed.code === "NoSuchBucket") {
      return withCors(xmlError(404, "NoSuchBucket", removed.error, `/${bucket}`));
    }
    return withCors(new Response(null, { status: 204 }));
  }

  // Get / Head Object
  if (key && (method === "GET" || method === "HEAD")) {
    const found = await readObjectFor(ownerId, bucket, key);
    if ("error" in found) {
      const missingBucket = found.error === "NoSuchBucket";
      const status = missingBucket ? 404 : found.error === "AccessDenied" ? 403 : 404;
      const code = status === 403 ? "AccessDenied" : found.error || "NoSuchKey";
      return withCors(
        xmlError(
          status,
          code,
          status === 403 ? "Access denied." : "The specified key does not exist.",
          `/${bucket}/${key}`,
        ),
      );
    }
    const object = found.object;
    const quoted = `"${object.etag}"`;

    // Conditional headers: ETag
    const inm = request.headers.get("if-none-match");
    if (inm && (inm === "*" || inm === quoted || inm === object.etag)) {
      return withCors(
        new Response(null, {
          status: 304,
          headers: objectResponseHeaders(new Headers({ etag: quoted }), key),
        }),
      );
    }
    const im = request.headers.get("if-match");
    if (im && im !== "*" && im !== quoted && im !== object.etag) {
      return withCors(
        xmlError(
          412,
          "PreconditionFailed",
          "At least one of the preconditions you specified did not hold.",
        ),
      );
    }

    // Conditional headers: Last-Modified
    const objectTime = new Date(object.updatedAt).getTime();
    const ims = request.headers.get("if-modified-since");
    if (ims) {
      const imsTime = Date.parse(ims);
      if (!Number.isNaN(imsTime) && objectTime <= imsTime) {
        return withCors(
          new Response(null, {
            status: 304,
            headers: objectResponseHeaders(new Headers({ etag: quoted }), key),
          }),
        );
      }
    }
    const iums = request.headers.get("if-unmodified-since");
    if (iums) {
      const iumsTime = Date.parse(iums);
      if (!Number.isNaN(iumsTime) && objectTime > iumsTime) {
        return withCors(
          xmlError(
            412,
            "PreconditionFailed",
            "At least one of the preconditions you specified did not hold.",
          ),
        );
      }
    }

    // Range support
    const range = parseRange(request.headers.get("range"), object.bytes.length);
    if (range === "bad") {
      return withCors(
        new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${object.bytes.length}` },
        }),
      );
    }
    const start = range?.start ?? 0;
    const end = range ? range.end : object.bytes.length - 1;
    const slice =
      object.bytes.length === 0 ? Buffer.alloc(0) : object.bytes.subarray(start, end + 1);
    const headers = new Headers({
      "content-type": object.contentType || "application/octet-stream",
      "content-length": String(slice.length),
      etag: quoted,
      "last-modified": new Date(object.updatedAt).toUTCString(),
      "accept-ranges": "bytes",
    });
    if (range) headers.set("content-range", `bytes ${start}-${end}/${object.bytes.length}`);
    for (const [name, value] of Object.entries(object.headers)) headers.set(name, value);
    objectResponseHeaders(headers, key);
    return withCors(
      new Response(method === "HEAD" ? null : new Uint8Array(slice), {
        status: range ? 206 : 200,
        headers,
      }),
    );
  }

  return withCors(xmlError(405, "MethodNotAllowed", "The specified method is not allowed."));
}
