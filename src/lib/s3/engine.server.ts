import {
  authenticateAccessKey,
  bucketRecord,
  copyObject,
  createBucket,
  deleteBucket,
  listForS3,
  listOwnedBuckets,
  putBytes,
  readObjectFor,
  removeObject,
  secretForAccessKey,
  setBucketAccess,
} from "@/lib/storage/queries.server";
import { crc32Base64, decodeAwsChunked, parseAuthorization, verifySigV4 } from "@/lib/s3/sigv4";
import { listBucketsXml, listObjectsXml, withCors, xmlError, xmlEscape, xmlResponse } from "@/lib/s3/xml";

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

function parseRange(header: string | null, size: number): { start: number; end: number } | "bad" | null {
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
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= size || end < start) return "bad";
  return { start, end: Math.min(end, size - 1) };
}

function unescapeXml(value: string): string {
  return value.replace(/</g, "<").replace(/>/g, ">").replace(/"/g, '"').replace(/&/g, "&");
}

function deleteKeys(xml: string): string[] {
  const keys: string[] = [];
  const re = /<Key>([\s\S]*?)<\/Key>/g;
  for (let match = re.exec(xml); match; match = re.exec(xml)) keys.push(unescapeXml(match[1] ?? ""));
  return keys;
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
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_BODY) {
    return withCors(xmlError(413, "EntityTooLarge", "The object is larger than 8 MB."));
  }
  let body = Buffer.from(await request.arrayBuffer());
  if (body.length > MAX_BODY) return withCors(xmlError(413, "EntityTooLarge", "The object is larger than 8 MB."));

  const mo = request.headers.get("authorization") ?? "";
  let ownerId: string | null = null;
  if (mo.startsWith("MO ")) {
    const raw = mo.slice(3).trim();
    const split = raw.indexOf(":");
    if (split <= 0) return withCors(xmlError(403, "InvalidAccessKeyId", "Access key is malformed."));
    const owner = await authenticateAccessKey(raw.slice(0, split), raw.slice(split + 1));
    if (!owner) return withCors(xmlError(403, "InvalidAccessKeyId", "The access key or secret is wrong."));
    ownerId = owner;
  } else {
    const parsed = parseAuthorization(request);
    if (parsed && "error" in parsed) {
      return withCors(xmlError(400, "AuthorizationHeaderMalformed", parsed.error));
    }
    if (parsed) {
      const key = await secretForAccessKey(parsed.accessKeyId);
      if (!key) return withCors(xmlError(403, "InvalidAccessKeyId", "The access key ID does not exist."));
      const verified = verifySigV4({ request, body, secret: key.secret_key, parsed, now });
      if (!verified.ok) return withCors(xmlError(403, verified.code, verified.message));
      ownerId = key.owner_id;
    }
  }

  const declared = request.headers.get("x-amz-content-sha256") ?? "";
  const encoding = request.headers.get("content-encoding") ?? "";
  if (declared.startsWith("STREAMING-") || encoding.includes("aws-chunked")) {
    try {
      body = Buffer.from(decodeAwsChunked(body));
    } catch {
      return withCors(xmlError(400, "InvalidRequest", "Could not read the chunked upload body."));
    }
  }

  const url = new URL(request.url);
  const { bucket, key } = splitPath(url.pathname);
  const method = request.method.toUpperCase();

  if (!bucket) {
    if (method !== "GET" && method !== "HEAD") {
      return withCors(xmlError(405, "MethodNotAllowed", "The specified method is not allowed."));
    }
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const buckets = await listOwnedBuckets(ownerId);
    const xml = listBucketsXml(buckets, ownerId);
    return withCors(xmlResponse(method === "HEAD" ? 200 : 200, method === "HEAD" ? "" : xml));
  }

  if (url.searchParams.has("location") && !key && (method === "GET" || method === "HEAD")) {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const record = await bucketRecord(bucket);
    if (!record || record.owner_id !== ownerId) return withCors(xmlError(404, "NoSuchBucket", "The bucket does not exist.", `/${bucket}`));
    const region = record.region === "us-east-1" ? "" : record.region;
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${xmlEscape(region)}</LocationConstraint>`;
    return withCors(xmlResponse(200, method === "HEAD" ? "" : xml));
  }

  if (url.searchParams.has("acl") && !key && method === "GET") {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const record = await bucketRecord(bucket);
    if (!record || record.owner_id !== ownerId) return withCors(xmlError(404, "NoSuchBucket", "The bucket does not exist.", `/${bucket}`));
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
    const isPublic = canned === "public-read" || canned === "public-read-write" || text.includes("AllUsers");
    const updated = await setBucketAccess(ownerId, bucket, isPublic && canned !== "private");
    if (!updated.ok) return withCors(xmlError(404, "NoSuchBucket", updated.error, `/${bucket}`));
    return withCors(new Response(null, { status: 200 }));
  }

  if (!key && method === "PUT") {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const acl = request.headers.get("x-amz-acl") ?? "";
    const created = await createBucket(ownerId, bucket, acl === "public-read" || acl === "public-read-write");
    if (!created.ok) {
      const code = created.error.includes("taken") || created.error.includes("already") ? "BucketAlreadyExists" : "InvalidBucketName";
      return withCors(xmlError(code === "BucketAlreadyExists" ? 409 : 400, code, created.error, `/${bucket}`));
    }
    return withCors(new Response(null, { status: 200 }));
  }

  if (!key && method === "DELETE") {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const removed = await deleteBucket(ownerId, bucket, false);
    if (!removed.ok) {
      const code = removed.error.includes("not empty") ? "BucketNotEmpty" : "NoSuchBucket";
      return withCors(xmlError(code === "BucketNotEmpty" ? 409 : 404, code, removed.error, `/${bucket}`));
    }
    return withCors(new Response(null, { status: 204 }));
  }

  if (!key && method === "HEAD") {
    const record = await bucketRecord(bucket);
    if (!record) return withCors(xmlError(ownerId ? 404 : 403, ownerId ? "NoSuchBucket" : "AccessDenied", "The bucket does not exist.", `/${bucket}`));
    if (record.owner_id !== ownerId && !record.isPublic) return withCors(xmlError(403, "AccessDenied", "Access denied.", `/${bucket}`));
    return withCors(new Response(null, { status: 200, headers: { "x-amz-bucket-region": record.region } }));
  }

  if (!key && method === "POST" && url.searchParams.has("delete")) {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const deleted: string[] = [];
    const errors: string[] = [];
    for (const objectKey of deleteKeys(body.toString("utf8"))) {
      const result = await removeObject(ownerId, bucket, objectKey);
      if (result.ok) deleted.push(objectKey);
      else errors.push(objectKey);
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><DeleteResult>${deleted.map((item) => `<Deleted><Key>${xmlEscape(item)}</Key></Deleted>`).join("")}${errors.map((item) => `<Error><Key>${xmlEscape(item)}</Key><Code>AccessDenied</Code></Error>`).join("")}</DeleteResult>`;
    return withCors(xmlResponse(200, xml));
  }

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
      const status = listed.error === "NoSuchBucket" ? (ownerId ? 404 : 403) : 403;
      const code = status === 404 ? "NoSuchBucket" : "AccessDenied";
      return withCors(xmlError(status, code, code === "NoSuchBucket" ? "The bucket does not exist." : "Access denied.", `/${bucket}`));
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
    if (slash <= 0) return withCors(xmlError(400, "InvalidArgument", "x-amz-copy-source is invalid."));
    const copied = await copyObject(ownerId, decoded.slice(0, slash), decoded.slice(slash + 1), bucket, key);
    if (!copied.ok) {
      const code = copied.code ?? "AccessDenied";
      return withCors(xmlError(code === "NoSuchBucket" ? 404 : 403, code, copied.error ?? "Request failed"));
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?><CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LastModified>${copied.updatedAt}</LastModified><ETag>"${copied.etag}"</ETag></CopyObjectResult>`;
    return withCors(xmlResponse(200, xml));
  }

  if (key && method === "PUT") {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const type = request.headers.get("content-type") || "application/octet-stream";
    const written = await putBytes(ownerId, bucket, key, body, type, metaHeaders(request, body));
    if (!written.ok) {
      const status = written.code === "NoSuchBucket" ? 404 : written.code === "EntityTooLarge" ? 400 : 400;
      return withCors(xmlError(status, written.code ?? "InvalidArgument", written.error, `/${bucket}/${key}`));
    }
    const headers = new Headers({ etag: `"${written.etag}"` });
    const checksum = metaHeaders(request, body)["x-amz-checksum-crc32"];
    if (checksum) headers.set("x-amz-checksum-crc32", checksum);
    return withCors(new Response(null, { status: 200, headers }));
  }

  if (key && method === "DELETE") {
    if (!ownerId) return withCors(xmlError(403, "AccessDenied", "Access denied."));
    const removed = await removeObject(ownerId, bucket, key);
    if (!removed.ok && removed.code === "NoSuchBucket") {
      return withCors(xmlError(404, "NoSuchBucket", removed.error, `/${bucket}`));
    }
    return withCors(new Response(null, { status: 204 }));
  }

  if (key && (method === "GET" || method === "HEAD")) {
    const found = await readObjectFor(ownerId, bucket, key);
    if ("error" in found) {
      const missingBucket = found.error === "NoSuchBucket";
      const status = found.error === "AccessDenied" || (missingBucket && !ownerId) ? 403 : 404;
      const code = status === 403 ? "AccessDenied" : found.error || "NoSuchKey";
      return withCors(xmlError(status, code, status === 403 ? "Access denied." : "The specified key does not exist.", `/${bucket}/${key}`));
    }
    const object = found.object;
    const inm = request.headers.get("if-none-match");
    const quoted = `"${object.etag}"`;
    if (inm && (inm === "*" || inm === quoted || inm === object.etag)) {
      return withCors(new Response(null, { status: 304, headers: { etag: quoted } }));
    }
    const im = request.headers.get("if-match");
    if (im && im !== "*" && im !== quoted && im !== object.etag) {
      return withCors(xmlError(412, "PreconditionFailed", "At least one of the preconditions you specified did not hold."));
    }
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
    const slice = object.bytes.length === 0 ? Buffer.alloc(0) : object.bytes.subarray(start, end + 1);
    const headers = new Headers({
      "content-type": object.contentType || "application/octet-stream",
      "content-length": String(slice.length),
      etag: quoted,
      "last-modified": new Date(object.updatedAt).toUTCString(),
      "accept-ranges": "bytes",
    });
    if (range) headers.set("content-range", `bytes ${start}-${end}/${object.bytes.length}`);
    for (const [name, value] of Object.entries(object.headers)) headers.set(name, value);
    return withCors(new Response(method === "HEAD" ? null : new Uint8Array(slice), { status: range ? 206 : 200, headers }));
  }

  return withCors(xmlError(405, "MethodNotAllowed", "The specified method is not allowed."));
}
