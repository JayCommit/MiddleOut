import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getSql, type Sql } from "../db.ts";
import {
  CHUNK_BYTES,
  MAX_ACCOUNT_BYTES,
  MAX_OBJECT_BYTES,
  formatBytes,
  groupListing,
  normalizeBucketName,
  validateBucketName,
  validateKey,
} from "./pure.ts";

type BucketRow = {
  id: string;
  name: string;
  is_public: unknown;
  region: string;
  created_at: unknown;
  object_count?: unknown;
  bytes?: unknown;
};

type ObjectRow = {
  id: string;
  key: string;
  size: unknown;
  content_type: string;
  etag: string;
  updated_at: unknown;
  headers: string;
  bucket_id?: string;
  bucket_name?: string;
  is_public?: unknown;
  owner_id?: string;
};

function asBool(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1;
}

function asNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v ?? ""));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function likePrefix(prefix: string): string {
  return `${prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

async function audit(sql: Sql, ownerId: string, action: string, detail: string) {
  await sql`insert into mo_audit (id, owner_id, action, detail) values (${randomUUID()}, ${ownerId}, ${action}, ${detail.slice(0, 500)})`;
}

async function lockAccountForQuota(sql: Sql, ownerId: string): Promise<void> {
  await sql`select owner_id from mo_accounts where owner_id = ${ownerId} for update`;
}

async function accountBytes(sql: Sql, ownerId: string): Promise<number> {
  const rows = await sql<{ bytes: unknown }>`
    select coalesce(sum(o.size), 0)::int as bytes
    from mo_objects o
    join mo_buckets b on b.id = o.bucket_id
    where b.owner_id = ${ownerId} and o.complete = true
  `;
  const mpRows = await sql<{ bytes: unknown }>`
    select coalesce(sum(p.size), 0)::int as bytes
    from mo_multipart_parts p
    join mo_multipart_uploads u on u.id = p.upload_id
    where u.owner_id = ${ownerId}
  `;
  return asNum(rows[0]?.bytes) + asNum(mpRows[0]?.bytes);
}

const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0e1211"/><path d="M6.2 8.2 L13.6 16 L6.2 23.8" fill="none" stroke="#e7eee9" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M25.8 8.2 L18.4 16 L25.8 23.8" fill="none" stroke="#e7eee9" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="14.15" y="14.35" width="3.7" height="3.3" rx="0.45" fill="#e2a23a"/></svg>`;

async function freeName(sql: Sql, base: string, ownerId: string): Promise<string> {
  const taken = await sql<{ name: string }>`select name from mo_buckets where name = ${base}`;
  if (!taken[0]) return base;
  const suffix = ownerId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "user";
  const next = `${base}-${suffix}`.slice(0, 63);
  const again = await sql<{ name: string }>`select name from mo_buckets where name = ${next}`;
  if (!again[0]) return next;
  return `${base}-${randomBytes(2).toString("hex")}`.slice(0, 63);
}

async function putDirect(
  sql: Sql,
  bucketId: string,
  key: string,
  body: string,
  contentType: string,
) {
  const bytes = Buffer.from(body);
  const id = randomUUID();
  const etag = createHash("md5").update(bytes).digest("hex");
  await sql`insert into mo_objects (id, bucket_id, key, size, content_type, etag, complete, headers)
    values (${id}, ${bucketId}, ${key}, ${bytes.length}, ${contentType}, ${etag}, ${true}, ${"{}"})`;
  if (bytes.length > 0) {
    await sql`insert into mo_parts (object_id, part, data) values (${id}, ${0}, ${bytes.toString("base64")})`;
  }
}

async function seed(sql: Sql, ownerId: string) {
  const regionRows = await sql<{ region: string }>`select region from mo_accounts where owner_id = ${ownerId}`;
  const region = regionRows[0]?.region ?? "us-east-1";
  const pub = await freeName(sql, "public-samples", ownerId);
  const priv = await freeName(sql, "private-records", ownerId);
  const pubId = randomUUID();
  const privId = randomUUID();
  await sql`insert into mo_buckets (id, owner_id, name, is_public, region) values (${pubId}, ${ownerId}, ${pub}, ${true}, ${region})`;
  await sql`insert into mo_buckets (id, owner_id, name, is_public, region) values (${privId}, ${ownerId}, ${priv}, ${false}, ${region})`;
  await putDirect(
    sql,
    pubId,
    "welcome.txt",
    "Welcome to Middle Out.\n\nThis bucket is public: anyone with the link can list and download it.\nPrivate buckets stay hidden until you sign in.\n\nTry the bucket browser, drop in a file, or create an access key and point an S3 client at the /api/s3 endpoint.\n",
    "text/plain",
  );
  await putDirect(
    sql,
    pubId,
    "guides/read-me.txt",
    "Path-style endpoint: /api/s3\n\naws s3 ls --endpoint-url \"$ENDPOINT\"\n\nSet AWS_REQUEST_CHECKSUM_CALCULATION=when_required\nand AWS_RESPONSE_CHECKSUM_VALIDATION=when_required\nso the AWS CLI does not require extra checksums.\n\nObjects in this node are limited to 8 MB.\n",
    "text/plain",
  );
  await putDirect(sql, pubId, "brand/mark.svg", MARK_SVG, "image/svg+xml");
  await putDirect(
    sql,
    privId,
    "readme.txt",
    "This bucket is private.\nOnly this account can list or download these objects.\nThe public browser will not show them.\n",
    "text/plain",
  );
  await putDirect(
    sql,
    privId,
    "notes/internal.txt",
    "Sample private note. Delete this bucket when you want a clean node.\n",
    "text/plain",
  );
  await audit(sql, ownerId, "bucket.create", pub);
  await audit(sql, ownerId, "bucket.create", priv);
  await audit(sql, ownerId, "object.put", `${pub}/welcome.txt`);
}

export async function ensureAccount(ownerId: string): Promise<void> {
  const sql = await getSql();
  await sql`insert into mo_accounts (owner_id) values (${ownerId}) on conflict (owner_id) do nothing`;
  const claimed = await sql<{ owner_id: string }>`
    update mo_accounts set seeded = true where owner_id = ${ownerId} and seeded = false returning owner_id
  `;
  if (!claimed[0]) return;
  try {
    await seed(sql, ownerId);
  } catch (err) {
    await sql`update mo_accounts set seeded = false where owner_id = ${ownerId}`;
    throw err;
  }
}

function mapBucket(row: BucketRow) {
  return {
    id: row.id,
    name: row.name,
    isPublic: asBool(row.is_public),
    region: row.region,
    createdAt: iso(row.created_at),
    objectCount: asNum(row.object_count),
    bytes: asNum(row.bytes),
  };
}

export async function overview(ownerId: string) {
  await ensureAccount(ownerId);
  const sql = await getSql();
  const buckets = await sql<BucketRow>`
    select b.id, b.name, b.is_public, b.region, b.created_at,
      count(o.id)::int as object_count,
      coalesce(sum(o.size), 0)::int as bytes
    from mo_buckets b
    left join mo_objects o on o.bucket_id = b.id and o.complete = true
    where b.owner_id = ${ownerId}
    group by b.id, b.name, b.is_public, b.region, b.created_at
    order by b.created_at desc
  `;
  const mapped = buckets.map(mapBucket);
  const activity = await sql<{ id: string; action: string; detail: string; created_at: unknown }>`
    select id, action, detail, created_at from mo_audit
    where owner_id = ${ownerId}
    order by created_at desc
    limit 8
  `;
  const account = await sql<{ region: string }>`select region from mo_accounts where owner_id = ${ownerId}`;
  return {
    buckets: mapped,
    stats: {
      buckets: mapped.length,
      objects: mapped.reduce((sum, b) => sum + b.objectCount, 0),
      bytes: mapped.reduce((sum, b) => sum + b.bytes, 0),
      publicBuckets: mapped.filter((b) => b.isPublic).length,
    },
    activity: activity.map((row) => ({
      id: row.id,
      action: row.action,
      detail: row.detail,
      createdAt: iso(row.created_at),
    })),
    region: account[0]?.region ?? "us-east-1",
    quota: MAX_ACCOUNT_BYTES,
  };
}

export async function createBucket(ownerId: string, rawName: string, isPublic: boolean) {
  const nameError = validateBucketName(rawName);
  if (nameError) return { ok: false as const, error: nameError };
  const name = normalizeBucketName(rawName);
  await ensureAccount(ownerId);
  const sql = await getSql();
  const existing = await sql<{ owner_id: string }>`select owner_id from mo_buckets where name = ${name}`;
  if (existing[0]) {
    return {
      ok: false as const,
      error: existing[0].owner_id === ownerId ? "You already have that bucket." : "That bucket name is taken.",
    };
  }
  const account = await sql<{ region: string }>`select region from mo_accounts where owner_id = ${ownerId}`;
  const region = account[0]?.region ?? "us-east-1";
  await sql`insert into mo_buckets (id, owner_id, name, is_public, region) values (${randomUUID()}, ${ownerId}, ${name}, ${isPublic}, ${region})`;
  await audit(sql, ownerId, "bucket.create", name);
  return { ok: true as const, name };
}

export async function setBucketAccess(ownerId: string, name: string, isPublic: boolean) {
  const sql = await getSql();
  const rows = await sql<{ id: string }>`
    update mo_buckets set is_public = ${isPublic}
    where name = ${name} and owner_id = ${ownerId}
    returning id
  `;
  if (!rows[0]) return { ok: false as const, error: "Bucket not found." };
  await audit(sql, ownerId, "bucket.acl", `${name} ${isPublic ? "public" : "private"}`);
  return { ok: true as const };
}

export async function deleteBucket(ownerId: string, name: string, force: boolean) {
  const sql = await getSql();
  const rows = await sql<{ id: string }>`select id from mo_buckets where name = ${name} and owner_id = ${ownerId}`;
  if (!rows[0]) return { ok: false as const, error: "Bucket not found." };
  const count = await sql<{ n: unknown }>`select count(*)::int as n from mo_objects where bucket_id = ${rows[0].id} and complete = true`;
  if (asNum(count[0]?.n) > 0 && !force) {
    return { ok: false as const, error: "Bucket is not empty." };
  }
  await sql`delete from mo_buckets where id = ${rows[0].id} and owner_id = ${ownerId}`;
  await audit(sql, ownerId, "bucket.delete", name);
  return { ok: true as const };
}

async function ownedBucket(sql: Sql, ownerId: string, name: string) {
  const rows = await sql<{ id: string; name: string; is_public: unknown; region: string; created_at: unknown }>`
    select id, name, is_public, region, created_at from mo_buckets where name = ${name} and owner_id = ${ownerId}
  `;
  return rows[0] ?? null;
}

export async function browse(ownerId: string, name: string, prefix: string, startAfter = "") {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, name);
  if (!bucket) return { ok: false as const, error: "Bucket not found." };
  const rows = await sql<{ key: string; size: unknown; etag: string; updated_at: unknown; content_type: string; id: string }>`
    select id, key, size, etag, updated_at, content_type
    from mo_objects
    where bucket_id = ${bucket.id} and complete = true and key like ${likePrefix(prefix)} escape '\\' and key > ${startAfter}
    order by key
    limit 5000
  `;
  const mapped = rows.map((row) => ({
    id: row.id,
    key: row.key,
    size: asNum(row.size),
    etag: row.etag,
    updatedAt: iso(row.updated_at),
    contentType: row.content_type,
  }));
  const page = groupListing(mapped, { prefix, delimiter: "/", maxKeys: 50, rawCapped: rows.length === 5000 });
  return {
    ok: true as const,
    bucket: {
      name: bucket.name,
      isPublic: asBool(bucket.is_public),
      region: bucket.region,
      createdAt: iso(bucket.created_at),
    },
    prefix,
    folders: page.prefixes,
    objects: page.contents,
    truncated: page.truncated,
    nextStart: page.nextStart,
  };
}

async function insertBytes(
  sql: Sql,
  objectId: string,
  bytes: Buffer,
) {
  let part = 0;
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + CHUNK_BYTES));
    await sql`insert into mo_parts (object_id, part, data) values (${objectId}, ${part}, ${slice.toString("base64")})`;
    part += 1;
  }
}

export async function putBytes(
  ownerId: string,
  bucketName: string,
  key: string,
  bytes: Buffer,
  contentType: string,
  headers: Record<string, string>,
) {
  const keyError = validateKey(key);
  if (keyError) return { ok: false as const, error: keyError, code: "InvalidArgument" };
  if (bytes.length > MAX_OBJECT_BYTES) {
    return { ok: false as const, error: `Objects are limited to ${formatBytes(MAX_OBJECT_BYTES)}.`, code: "EntityTooLarge" };
  }
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "Bucket not found.", code: "NoSuchBucket" };

  await lockAccountForQuota(sql, ownerId);
  const existing = await sql<{ id: string; size: unknown }>`
    select id, size from mo_objects where bucket_id = ${bucket.id} and key = ${key} and complete = true
  `;
  const used = await accountBytes(sql, ownerId);
  const previous = asNum(existing[0]?.size);
  if (used - previous + bytes.length > MAX_ACCOUNT_BYTES) {
    return { ok: false as const, error: "Account storage limit reached.", code: "QuotaExceeded" };
  }
  await sql`delete from mo_objects where bucket_id = ${bucket.id} and key = ${key}`;
  const id = randomUUID();
  const etag = createHash("md5").update(bytes).digest("hex");
  await sql`insert into mo_objects (id, bucket_id, key, size, content_type, etag, complete, headers)
    values (${id}, ${bucket.id}, ${key}, ${bytes.length}, ${contentType || "application/octet-stream"}, ${etag}, ${true}, ${JSON.stringify(headers)})`;
  await insertBytes(sql, id, bytes);
  await audit(sql, ownerId, "object.put", `${bucketName}/${key}`);
  return { ok: true as const, id, etag, size: bytes.length };
}

export async function beginUpload(
  ownerId: string,
  input: { bucket: string; key: string; size: number; contentType: string },
) {
  const keyError = validateKey(input.key);
  if (keyError) return { ok: false as const, error: keyError };
  if (!Number.isFinite(input.size) || input.size < 0 || input.size > MAX_OBJECT_BYTES) {
    return { ok: false as const, error: `Objects are limited to ${formatBytes(MAX_OBJECT_BYTES)}.` };
  }
  await ensureAccount(ownerId);
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, input.bucket);
  if (!bucket) return { ok: false as const, error: "Bucket not found." };

  await lockAccountForQuota(sql, ownerId);
  const existing = await sql<{ size: unknown }>`
    select size from mo_objects where bucket_id = ${bucket.id} and key = ${input.key} and complete = true
  `;
  const used = await accountBytes(sql, ownerId);
  if (used - asNum(existing[0]?.size) + input.size > MAX_ACCOUNT_BYTES) {
    return { ok: false as const, error: "Account storage limit reached (64 MB)." };
  }
  await sql`delete from mo_objects where bucket_id = ${bucket.id} and key = ${input.key}`;
  const id = randomUUID();
  await sql`insert into mo_objects (id, bucket_id, key, size, content_type, etag, complete, headers)
    values (${id}, ${bucket.id}, ${input.key}, ${Math.round(input.size)}, ${input.contentType || "application/octet-stream"}, ${""}, ${false}, ${"{}"})`;
  return { ok: true as const, id };
}

export async function writePart(ownerId: string, objectId: string, part: number, data: string) {
  if (!Number.isInteger(part) || part < 0 || part > 64) return { ok: false as const, error: "Bad part." };
  let buf: Buffer;
  try {
    buf = Buffer.from(data, "base64");
  } catch {
    return { ok: false as const, error: "Bad part data." };
  }
  if (buf.length > CHUNK_BYTES) return { ok: false as const, error: "Part is too large." };
  const sql = await getSql();
  const rows = await sql<{ id: string }>`
    select o.id from mo_objects o
    join mo_buckets b on b.id = o.bucket_id
    where o.id = ${objectId} and b.owner_id = ${ownerId} and o.complete = false
  `;
  if (!rows[0]) return { ok: false as const, error: "Upload not found." };
  await sql`
    insert into mo_parts (object_id, part, data) values (${objectId}, ${part}, ${data})
    on conflict (object_id, part) do update set data = excluded.data
  `;
  return { ok: true as const };
}

export async function finishUpload(ownerId: string, objectId: string) {
  const sql = await getSql();
  const rows = await sql<{ id: string; size: unknown; key: string; bucket: string }>`
    select o.id, o.size, o.key, b.name as bucket
    from mo_objects o
    join mo_buckets b on b.id = o.bucket_id
    where o.id = ${objectId} and b.owner_id = ${ownerId} and o.complete = false
  `;
  const row = rows[0];
  if (!row) return { ok: false as const, error: "Upload not found." };
  const parts = await sql<{ part: unknown; data: string }>`
    select part, data from mo_parts where object_id = ${objectId} order by part
  `;
  const hash = createHash("md5");
  let total = 0;
  for (let i = 0; i < parts.length; i += 1) {
    if (asNum(parts[i]?.part) !== i) return { ok: false as const, error: "Upload is missing a part." };
    const buf = Buffer.from(parts[i]?.data ?? "", "base64");
    total += buf.length;
    hash.update(buf);
  }
  if (total !== asNum(row.size)) return { ok: false as const, error: "Upload size did not match." };
  const etag = hash.digest("hex");
  await sql`update mo_objects set etag = ${etag}, complete = true, updated_at = now() where id = ${objectId}`;
  await audit(sql, ownerId, "object.put", `${row.bucket}/${row.key}`);
  return { ok: true as const, etag };
}

export async function abortUpload(ownerId: string, objectId: string) {
  const sql = await getSql();
  const rows = await sql<{ id: string }>`
    delete from mo_objects o
    using mo_buckets b
    where o.id = ${objectId} and o.complete = false and b.id = o.bucket_id and b.owner_id = ${ownerId}
    returning o.id
  `;
  if (!rows[0]) return { ok: false as const, error: "Upload not found." };
  return { ok: true as const };
}

export async function cleanupExpired(maxAgeSeconds = 86400) {
  const sql = await getSql();
  await sql`delete from mo_links where expires_at < now()`;
  const cutoff = new Date(Date.now() - maxAgeSeconds * 1000).toISOString();
  await sql`delete from mo_objects where complete = false and created_at < ${cutoff}`;
  await sql`delete from mo_multipart_uploads where created_at < ${cutoff}`;
  return { ok: true as const };
}

export async function removeObject(ownerId: string, bucketName: string, key: string) {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "Bucket not found.", code: "NoSuchBucket" };
  const rows = await sql<{ id: string }>`
    delete from mo_objects where bucket_id = ${bucket.id} and key = ${key} and complete = true returning id
  `;
  if (!rows[0]) return { ok: false as const, error: "Object not found.", code: "NoSuchKey" };
  await audit(sql, ownerId, "object.delete", `${bucketName}/${key}`);
  return { ok: true as const };
}

export async function batchDeleteObjects(ownerId: string, bucketName: string, keys: string[]) {
  const deleted: string[] = [];
  const errors: string[] = [];
  for (const k of keys) {
    const res = await removeObject(ownerId, bucketName, k);
    if (res.ok) deleted.push(k);
    else errors.push(k);
  }
  return { ok: true as const, deleted, errors };
}

export async function moveObject(ownerId: string, bucketName: string, sourceKey: string, destKey: string) {
  if (sourceKey === destKey) return { ok: false as const, error: "Source and destination keys are the same." };
  const copyRes = await copyObject(ownerId, bucketName, sourceKey, bucketName, destKey);
  if (!copyRes.ok) return copyRes;
  await removeObject(ownerId, bucketName, sourceKey);
  const sql = await getSql();
  await audit(sql, ownerId, "object.move", `${bucketName}: ${sourceKey} -> ${destKey}`);
  return { ok: true as const, etag: copyRes.etag };
}

async function tagsFor(sql: Sql, objectId: string) {
  const tags = await sql<{ tag_key: string; tag_value: string }>`
    select tag_key, tag_value from mo_tags where object_id = ${objectId} order by tag_key
  `;
  return tags.map((tag) => ({ key: tag.tag_key, value: tag.tag_value }));
}

export async function objectDetail(ownerId: string, bucketName: string, key: string) {
  const sql = await getSql();
  const rows = await sql<ObjectRow>`
    select o.id, o.key, o.size, o.content_type, o.etag, o.updated_at, o.headers
    from mo_objects o
    join mo_buckets b on b.id = o.bucket_id
    where b.name = ${bucketName} and b.owner_id = ${ownerId} and o.key = ${key} and o.complete = true
  `;
  const row = rows[0];
  if (!row) return { ok: false as const, error: "Object not found." };
  const parts = await sql<{ n: unknown }>`select count(*)::int as n from mo_parts where object_id = ${row.id}`;
  return {
    ok: true as const,
    object: {
      id: row.id,
      key: row.key,
      size: asNum(row.size),
      contentType: row.content_type,
      etag: row.etag,
      updatedAt: iso(row.updated_at),
      partCount: asNum(parts[0]?.n),
      tags: await tagsFor(sql, row.id),
    },
  };
}

export async function readPartForOwner(ownerId: string, objectId: string, part: number) {
  const sql = await getSql();
  const rows = await sql<{ data: string }>`
    select p.data from mo_parts p
    join mo_objects o on o.id = p.object_id
    join mo_buckets b on b.id = o.bucket_id
    where p.object_id = ${objectId} and p.part = ${part} and b.owner_id = ${ownerId} and o.complete = true
  `;
  if (!rows[0]) return { ok: false as const, error: "Part not found." };
  return { ok: true as const, data: rows[0].data };
}

export async function setTags(ownerId: string, bucketName: string, key: string, tags: { key: string; value: string }[]) {
  if (tags.length > 10) return { ok: false as const, error: "Up to 10 tags." };
  for (const tag of tags) {
    if (!tag.key || tag.key.length > 32 || tag.value.length > 64) {
      return { ok: false as const, error: "Tag keys must be 1–32 characters and values up to 64." };
    }
  }
  const sql = await getSql();
  const rows = await sql<{ id: string }>`
    select o.id from mo_objects o
    join mo_buckets b on b.id = o.bucket_id
    where b.name = ${bucketName} and b.owner_id = ${ownerId} and o.key = ${key} and o.complete = true
  `;
  if (!rows[0]) return { ok: false as const, error: "Object not found." };
  await sql`delete from mo_tags where object_id = ${rows[0].id}`;
  for (const tag of tags) {
    await sql`insert into mo_tags (object_id, tag_key, tag_value) values (${rows[0].id}, ${tag.key}, ${tag.value})`;
  }
  return { ok: true as const };
}

export async function getObjectTags(ownerId: string | null, bucketName: string, key: string) {
  const sql = await getSql();
  const found = await readObjectFor(ownerId, bucketName, key);
  if ("error" in found) return { ok: false as const, error: found.error };
  const tags = await tagsFor(sql, found.object.id);
  return { ok: true as const, tags };
}

export async function deleteObjectTags(ownerId: string, bucketName: string, key: string) {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "NoSuchBucket" };
  const rows = await sql<{ id: string }>`
    select id from mo_objects where bucket_id = ${bucket.id} and key = ${key} and complete = true
  `;
  if (!rows[0]) return { ok: false as const, error: "NoSuchKey" };
  await sql`delete from mo_tags where object_id = ${rows[0].id}`;
  return { ok: true as const };
}

export async function listKeys(ownerId: string) {
  await ensureAccount(ownerId);
  const sql = await getSql();
  const rows = await sql<{ id: string; access_key_id: string; secret_last4: string; label: string; permission: string | null; bucket_scope: string | null; created_at: unknown }>`
    select id, access_key_id, secret_last4, label, permission, bucket_scope, created_at
    from mo_keys where owner_id = ${ownerId}
    order by created_at desc
  `;
  return rows.map((row) => ({
    id: row.id,
    accessKeyId: row.access_key_id,
    last4: row.secret_last4,
    label: row.label,
    permission: row.permission ?? "full",
    bucketScope: row.bucket_scope ?? null,
    createdAt: iso(row.created_at),
  }));
}

const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function randomToken(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += KEY_ALPHABET[(bytes[i] ?? 0) % KEY_ALPHABET.length];
  return out;
}

export async function createKey(
  ownerId: string,
  label: string,
  permission: "full" | "read-only" = "full",
  bucketScope: string | null = null,
) {
  await ensureAccount(ownerId);
  const sql = await getSql();
  const count = await sql<{ n: unknown }>`select count(*)::int as n from mo_keys where owner_id = ${ownerId}`;
  if (asNum(count[0]?.n) >= 16) return { ok: false as const, error: "You can keep up to 16 access keys." };
  const cleanScope = bucketScope ? normalizeBucketName(bucketScope) : null;
  if (cleanScope) {
    const b = await ownedBucket(sql, ownerId, cleanScope);
    if (!b) return { ok: false as const, error: "Scoped bucket does not exist." };
  }
  const perm = permission === "read-only" ? "read-only" : "full";
  const accessKeyId = `MO${randomToken(18)}`;
  const secret = randomToken(40);
  const clean = label.trim().slice(0, 40);
  await sql`insert into mo_keys (id, owner_id, access_key_id, secret_key, secret_last4, label, permission, bucket_scope)
    values (${randomUUID()}, ${ownerId}, ${accessKeyId}, ${secret}, ${secret.slice(-4)}, ${clean}, ${perm}, ${cleanScope})`;
  await audit(sql, ownerId, "key.create", `${accessKeyId} (${perm}${cleanScope ? `:${cleanScope}` : ""})`);
  return { ok: true as const, accessKeyId, secretKey: secret, permission: perm, bucketScope: cleanScope };
}

export async function revokeKey(ownerId: string, id: string) {
  const sql = await getSql();
  const rows = await sql<{ access_key_id: string }>`
    delete from mo_keys where id = ${id} and owner_id = ${ownerId} returning access_key_id
  `;
  if (!rows[0]) return { ok: false as const, error: "Key not found." };
  await audit(sql, ownerId, "key.revoke", rows[0].access_key_id);
  return { ok: true as const };
}

export async function listAudit(ownerId: string) {
  await ensureAccount(ownerId);
  const sql = await getSql();
  const rows = await sql<{ id: string; action: string; detail: string; created_at: unknown }>`
    select id, action, detail, created_at from mo_audit
    where owner_id = ${ownerId}
    order by created_at desc
    limit 100
  `;
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    detail: row.detail,
    createdAt: iso(row.created_at),
  }));
}

export async function getSettings(ownerId: string) {
  await ensureAccount(ownerId);
  const sql = await getSql();
  const rows = await sql<{ region: string }>`select region from mo_accounts where owner_id = ${ownerId}`;
  return { region: rows[0]?.region ?? "us-east-1", quota: MAX_ACCOUNT_BYTES, maxObject: MAX_OBJECT_BYTES };
}

export async function setRegion(ownerId: string, region: string) {
  const allowed = ["us-east-1", "us-west-2", "eu-west-1", "eu-central-1", "ap-southeast-1"];
  if (!allowed.includes(region)) return { ok: false as const, error: "Unknown region." };
  await ensureAccount(ownerId);
  const sql = await getSql();
  await sql`update mo_accounts set region = ${region} where owner_id = ${ownerId}`;
  return { ok: true as const };
}

export async function createLink(ownerId: string, bucketName: string, key: string, seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 60 || seconds > 30 * 86400) {
    return { ok: false as const, error: "Expiration must be between 1 minute and 30 days." };
  }
  const sql = await getSql();
  const rows = await sql<{ id: string }>`
    select o.id from mo_objects o
    join mo_buckets b on b.id = o.bucket_id
    where b.name = ${bucketName} and b.owner_id = ${ownerId} and o.key = ${key} and o.complete = true
  `;
  if (!rows[0]) return { ok: false as const, error: "Object not found." };
  const token = randomBytes(24).toString("hex");
  const expires = new Date(Date.now() + seconds * 1000).toISOString();
  await sql`insert into mo_links (token, object_id, owner_id, expires_at) values (${token}, ${rows[0].id}, ${ownerId}, ${expires})`;
  return { ok: true as const, token, expiresAt: expires };
}

export async function listShares(ownerId: string) {
  await ensureAccount(ownerId);
  const sql = await getSql();
  const rows = await sql<{ token: string; expires_at: unknown; created_at: unknown; key: string; bucket_name: string }>`
    select l.token, l.expires_at, l.created_at, o.key, b.name as bucket_name
    from mo_links l
    join mo_objects o on o.id = l.object_id
    join mo_buckets b on b.id = o.bucket_id
    where l.owner_id = ${ownerId} and l.expires_at > now()
    order by l.created_at desc
  `;
  return rows.map((row) => ({
    token: row.token,
    bucket: row.bucket_name,
    key: row.key,
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  }));
}

export async function revokeShare(ownerId: string, token: string) {
  const sql = await getSql();
  const rows = await sql<{ token: string }>`
    delete from mo_links where token = ${token} and owner_id = ${ownerId} returning token
  `;
  if (!rows[0]) return { ok: false as const, error: "Share link not found." };
  return { ok: true as const };
}

export async function readShare(token: string) {
  const sql = await getSql();
  const rows = await sql<{ object_id: string; expires_at: unknown; key: string; content_type: string; size: unknown; etag: string }>`
    select l.object_id, l.expires_at, o.key, o.content_type, o.size, o.etag
    from mo_links l
    join mo_objects o on o.id = l.object_id
    where l.token = ${token} and o.complete = true
  `;
  const row = rows[0];
  if (!row) return null;
  if (new Date(iso(row.expires_at)).getTime() < Date.now()) return null;
  return {
    key: row.key,
    contentType: row.content_type,
    size: asNum(row.size),
    etag: row.etag,
    bytes: await readAllBytes(sql, row.object_id),
  };
}

async function readAllBytes(sql: Sql, objectId: string): Promise<Buffer> {
  const parts = await sql<{ data: string }>`select data from mo_parts where object_id = ${objectId} order by part`;
  return Buffer.concat(parts.map((part) => Buffer.from(part.data, "base64")));
}

export async function publicListing(name: string, prefix: string, startAfter = "") {
  const sql = await getSql();
  const buckets = await sql<{ id: string; is_public: unknown }>`
    select id, is_public from mo_buckets where name = ${name}
  `;
  if (!buckets[0] || !asBool(buckets[0].is_public)) return { available: false as const };
  const rows = await sql<{ key: string; size: unknown; content_type: string; updated_at: unknown }>`
    select key, size, content_type, updated_at from mo_objects
    where bucket_id = ${buckets[0].id} and complete = true and key like ${likePrefix(prefix)} escape '\\' and key > ${startAfter}
    order by key
    limit 5000
  `;
  const mapped = rows.map((row) => ({
    key: row.key,
    size: asNum(row.size),
    contentType: row.content_type,
    updatedAt: iso(row.updated_at),
  }));
  const page = groupListing(mapped, { prefix, delimiter: "/", maxKeys: 50, rawCapped: rows.length === 5000 });
  return {
    available: true as const,
    name,
    prefix,
    folders: page.prefixes,
    objects: page.contents,
    truncated: page.truncated,
    nextStart: page.nextStart,
  };
}

export async function readPublicObject(bucketName: string, key: string) {
  const sql = await getSql();
  const rows = await sql<ObjectRow>`
    select o.id, o.key, o.size, o.content_type, o.etag, o.updated_at, o.headers
    from mo_objects o
    join mo_buckets b on b.id = o.bucket_id
    where b.name = ${bucketName} and b.is_public = true and o.key = ${key} and o.complete = true
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    key: row.key,
    size: asNum(row.size),
    contentType: row.content_type,
    etag: row.etag,
    updatedAt: iso(row.updated_at),
    headers: parseHeaders(row.headers),
    bytes: await readAllBytes(sql, row.id),
  };
}

export async function accessHint(ownerId: string, name: string) {
  const sql = await getSql();
  const rows = await sql<{ is_public: unknown }>`
    select is_public from mo_buckets where name = ${name} and owner_id = ${ownerId}
  `;
  if (!rows[0]) return { owned: false, isPublic: false };
  return { owned: true, isPublic: asBool(rows[0].is_public) };
}

function parseHeaders(raw: string): Record<string, string> {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string") out[k.toLowerCase()] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function authenticateAccessKey(accessKeyId: string, secret: string) {
  const sql = await getSql();
  const rows = await sql<{ owner_id: string; secret_key: string; permission: string | null; bucket_scope: string | null }>`
    select owner_id, secret_key, permission, bucket_scope from mo_keys where access_key_id = ${accessKeyId}
  `;
  const row = rows[0];
  if (!row || !safeEqual(row.secret_key, secret)) return null;
  return {
    ownerId: row.owner_id,
    permission: (row.permission === "read-only" ? "read-only" : "full") as "full" | "read-only",
    bucketScope: row.bucket_scope ?? null,
  };
}

export async function secretForAccessKey(accessKeyId: string) {
  const sql = await getSql();
  const rows = await sql<{ owner_id: string; secret_key: string; permission: string | null; bucket_scope: string | null }>`
    select owner_id, secret_key, permission, bucket_scope from mo_keys where access_key_id = ${accessKeyId}
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    owner_id: row.owner_id,
    secret_key: row.secret_key,
    permission: (row.permission === "read-only" ? "read-only" : "full") as "full" | "read-only",
    bucket_scope: row.bucket_scope ?? null,
  };
}

export type S3Object = {
  id: string;
  key: string;
  size: number;
  contentType: string;
  etag: string;
  updatedAt: string;
  headers: Record<string, string>;
  bytes: Buffer;
};

export async function readObjectFor(ownerId: string | null, bucketName: string, key: string) {
  const sql = await getSql();
  const buckets = await sql<{ id: string; owner_id: string; is_public: unknown; region: string }>`
    select id, owner_id, is_public, region from mo_buckets where name = ${bucketName}
  `;
  const bucket = buckets[0];
  if (!bucket) return { error: "NoSuchBucket" as const };
  const owns = ownerId !== null && bucket.owner_id === ownerId;
  const isPublic = asBool(bucket.is_public);
  if (!owns && !isPublic) return { error: "AccessDenied" as const };

  const rows = await sql<ObjectRow>`
    select id, key, size, content_type, etag, updated_at, headers
    from mo_objects where bucket_id = ${bucket.id} and key = ${key} and complete = true
  `;
  const row = rows[0];
  if (!row) return { error: "NoSuchKey" as const, bucket };
  return {
    bucket,
    object: {
      id: row.id,
      key: row.key,
      size: asNum(row.size),
      contentType: row.content_type,
      etag: row.etag,
      updatedAt: iso(row.updated_at),
      headers: parseHeaders(row.headers),
      bytes: await readAllBytes(sql, row.id),
    } satisfies S3Object,
  };
}

export async function listForS3(
  ownerId: string | null,
  bucketName: string,
  prefix: string,
  delimiter: string,
  maxKeys: number,
  startAfter: string,
) {
  const sql = await getSql();
  const buckets = await sql<{ id: string; owner_id: string; is_public: unknown; region: string; name: string }>`
    select id, owner_id, is_public, region, name from mo_buckets where name = ${bucketName}
  `;
  const bucket = buckets[0];
  if (!bucket) return { error: "NoSuchBucket" as const };
  const owns = ownerId !== null && bucket.owner_id === ownerId;
  if (!owns && !asBool(bucket.is_public)) return { error: "AccessDenied" as const };
  const cap = Math.min(1000, Math.max(0, maxKeys));
  const rows = await sql<{ key: string; size: unknown; etag: string; updated_at: unknown }>`
    select key, size, etag, updated_at from mo_objects
    where bucket_id = ${bucket.id} and complete = true
      and key like ${likePrefix(prefix)} escape '\\'
      and key > ${startAfter}
    order by key
    limit 5000
  `;
  const mapped = rows.map((row) => ({
    key: row.key,
    size: asNum(row.size),
    etag: row.etag,
    updatedAt: iso(row.updated_at),
  }));
  const page = groupListing(mapped, {
    prefix,
    delimiter,
    maxKeys: cap,
    rawCapped: rows.length === 5000,
  });
  return { bucket, ...page };
}

export async function listOwnedBuckets(ownerId: string) {
  const sql = await getSql();
  const rows = await sql<{ name: string; created_at: unknown }>`
    select name, created_at from mo_buckets where owner_id = ${ownerId} order by name
  `;
  return rows.map((row) => ({ name: row.name, createdAt: iso(row.created_at) }));
}

export async function bucketRecord(name: string) {
  const sql = await getSql();
  const rows = await sql<{ id: string; owner_id: string; is_public: unknown; region: string; name: string }>`
    select id, owner_id, is_public, region, name from mo_buckets where name = ${name}
  `;
  return rows[0] ? { ...rows[0], isPublic: asBool(rows[0].is_public) } : null;
}

export async function copyObject(ownerId: string, sourceBucket: string, sourceKey: string, destBucket: string, destKey: string) {
  const found = await readObjectFor(ownerId, sourceBucket, sourceKey);
  if ("error" in found) return { ok: false as const, error: found.error, code: found.error };
  if (!("object" in found) || !found.object) return { ok: false as const, error: "NoSuchKey", code: "NoSuchKey" };
  const written = await putBytes(ownerId, destBucket, destKey, found.object.bytes, found.object.contentType, found.object.headers);
  if (!written.ok) return written;
  return { ok: true as const, etag: written.etag, updatedAt: new Date().toISOString() };
}

// Multipart Uploads
export async function initiateMultipartUpload(
  ownerId: string,
  bucketName: string,
  key: string,
  contentType: string,
  headers: Record<string, string>,
) {
  const keyError = validateKey(key);
  if (keyError) return { ok: false as const, error: keyError, code: "InvalidArgument" };
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "Bucket not found.", code: "NoSuchBucket" };

  const uploadId = randomUUID().replace(/-/g, "");
  await sql`insert into mo_multipart_uploads (id, bucket_id, key, owner_id, content_type, headers)
    values (${uploadId}, ${bucket.id}, ${key}, ${ownerId}, ${contentType || "application/octet-stream"}, ${JSON.stringify(headers)})`;
  return { ok: true as const, uploadId, bucket: bucketName, key };
}

export async function uploadMultipartPart(
  ownerId: string,
  bucketName: string,
  key: string,
  uploadId: string,
  partNumber: number,
  data: Buffer,
) {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return { ok: false as const, error: "Part number must be an integer between 1 and 10000.", code: "InvalidArgument" };
  }
  if (data.length > MAX_OBJECT_BYTES) {
    return { ok: false as const, error: `Part exceeds maximum object size.`, code: "EntityTooLarge" };
  }
  const sql = await getSql();
  const rows = await sql<{ id: string; key: string }>`
    select u.id, u.key from mo_multipart_uploads u
    join mo_buckets b on b.id = u.bucket_id
    where u.id = ${uploadId} and b.name = ${bucketName} and u.owner_id = ${ownerId}
  `;
  if (!rows[0]) return { ok: false as const, error: "Upload not found.", code: "NoSuchUpload" };

  await lockAccountForQuota(sql, ownerId);
  const used = await accountBytes(sql, ownerId);
  const existingPart = await sql<{ size: unknown }>`
    select size from mo_multipart_parts where upload_id = ${uploadId} and part_number = ${partNumber}
  `;
  const prevSize = asNum(existingPart[0]?.size);
  if (used - prevSize + data.length > MAX_ACCOUNT_BYTES) {
    return { ok: false as const, error: "Account storage limit reached.", code: "QuotaExceeded" };
  }

  const etag = createHash("md5").update(data).digest("hex");
  const b64 = data.toString("base64");
  await sql`
    insert into mo_multipart_parts (upload_id, part_number, size, etag, data)
    values (${uploadId}, ${partNumber}, ${data.length}, ${etag}, ${b64})
    on conflict (upload_id, part_number) do update set size = excluded.size, etag = excluded.etag, data = excluded.data
  `;
  return { ok: true as const, etag, partNumber };
}

export async function completeMultipartUpload(
  ownerId: string,
  bucketName: string,
  key: string,
  uploadId: string,
  expectedParts: { partNumber: number; etag: string }[],
) {
  const sql = await getSql();
  const rows = await sql<{ id: string; bucket_id: string; key: string; content_type: string; headers: string }>`
    select u.id, u.bucket_id, u.key, u.content_type, u.headers
    from mo_multipart_uploads u
    join mo_buckets b on b.id = u.bucket_id
    where u.id = ${uploadId} and b.name = ${bucketName} and u.owner_id = ${ownerId}
  `;
  const upload = rows[0];
  if (!upload) return { ok: false as const, error: "Upload not found.", code: "NoSuchUpload" };

  const storedParts = await sql<{ part_number: unknown; size: unknown; etag: string; data: string }>`
    select part_number, size, etag, data
    from mo_multipart_parts
    where upload_id = ${uploadId}
    order by part_number
  `;
  const partMap = new Map<number, { size: number; etag: string; data: string }>();
  for (const p of storedParts) {
    partMap.set(asNum(p.part_number), { size: asNum(p.size), etag: p.etag, data: p.data });
  }

  let lastPartNum = 0;
  const buffers: Buffer[] = [];
  const md5s: Buffer[] = [];
  let totalSize = 0;

  for (const ep of expectedParts) {
    if (ep.partNumber <= lastPartNum) {
      return { ok: false as const, error: "Parts are not in ascending order.", code: "InvalidPartOrder" };
    }
    lastPartNum = ep.partNumber;
    const stored = partMap.get(ep.partNumber);
    if (!stored) {
      return { ok: false as const, error: `Part ${ep.partNumber} is missing.`, code: "InvalidPart" };
    }
    const cleanEtag = ep.etag.replace(/^"|"$/g, "").toLowerCase();
    if (cleanEtag && cleanEtag !== stored.etag.toLowerCase()) {
      return { ok: false as const, error: `Part ${ep.partNumber} etag mismatch.`, code: "InvalidPart" };
    }
    const buf = Buffer.from(stored.data, "base64");
    buffers.push(buf);
    md5s.push(createHash("md5").update(buf).digest());
    totalSize += buf.length;
  }

  if (totalSize > MAX_OBJECT_BYTES) {
    return { ok: false as const, error: `Object size exceeds maximum limit.`, code: "EntityTooLarge" };
  }

  const combinedMd5 = createHash("md5").update(Buffer.concat(md5s)).digest("hex");
  const multipartEtag = `${combinedMd5}-${expectedParts.length}`;

  const objectBytes = Buffer.concat(buffers);
  await sql`delete from mo_objects where bucket_id = ${upload.bucket_id} and key = ${upload.key}`;
  const objectId = randomUUID();
  await sql`
    insert into mo_objects (id, bucket_id, key, size, content_type, etag, complete, headers)
    values (${objectId}, ${upload.bucket_id}, ${upload.key}, ${totalSize}, ${upload.content_type}, ${multipartEtag}, ${true}, ${upload.headers})
  `;
  await insertBytes(sql, objectId, objectBytes);
  await sql`delete from mo_multipart_uploads where id = ${uploadId}`;
  await audit(sql, ownerId, "object.put", `${bucketName}/${upload.key} (multipart)`);

  return { ok: true as const, etag: multipartEtag, size: totalSize, location: `/api/s3/${bucketName}/${upload.key}` };
}

export async function abortMultipartUpload(ownerId: string, bucketName: string, key: string, uploadId: string) {
  const sql = await getSql();
  const rows = await sql<{ id: string }>`
    delete from mo_multipart_uploads u
    using mo_buckets b
    where u.id = ${uploadId} and b.id = u.bucket_id and b.name = ${bucketName} and u.owner_id = ${ownerId}
    returning u.id
  `;
  if (!rows[0]) return { ok: false as const, error: "Upload not found.", code: "NoSuchUpload" };
  return { ok: true as const };
}

export async function listMultipartParts(ownerId: string, bucketName: string, key: string, uploadId: string) {
  const sql = await getSql();
  const rows = await sql<{ id: string; key: string }>`
    select u.id, u.key from mo_multipart_uploads u
    join mo_buckets b on b.id = u.bucket_id
    where u.id = ${uploadId} and b.name = ${bucketName} and u.owner_id = ${ownerId}
  `;
  if (!rows[0]) return { ok: false as const, error: "Upload not found.", code: "NoSuchUpload" };
  const parts = await sql<{ part_number: unknown; size: unknown; etag: string; created_at: unknown }>`
    select part_number, size, etag, created_at
    from mo_multipart_parts
    where upload_id = ${uploadId}
    order by part_number
  `;
  return {
    ok: true as const,
    uploadId,
    bucket: bucketName,
    key,
    ownerId,
    parts: parts.map((p) => ({
      partNumber: asNum(p.part_number),
      size: asNum(p.size),
      etag: p.etag,
      updatedAt: iso(p.created_at),
    })),
  };
}

export async function listMultipartUploads(ownerId: string, bucketName: string, prefix = "") {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "Bucket not found.", code: "NoSuchBucket" };
  const rows = await sql<{ id: string; key: string; created_at: unknown }>`
    select id, key, created_at
    from mo_multipart_uploads
    where bucket_id = ${bucket.id} and key like ${likePrefix(prefix)} escape '\\'
    order by created_at desc
  `;
  return {
    ok: true as const,
    bucket: bucketName,
    uploads: rows.map((r) => ({
      uploadId: r.id,
      key: r.key,
      ownerId,
      createdAt: iso(r.created_at),
    })),
  };
}

// CORS & Policy
export async function getBucketCors(ownerId: string, bucketName: string) {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "NoSuchBucket" };
  const rows = await sql<{ cors_rules: string | null }>`select cors_rules from mo_buckets where id = ${bucket.id}`;
  const rules = rows[0]?.cors_rules;
  if (!rules || rules === "[]") return { ok: false as const, error: "NoSuchCORSConfiguration" };
  return { ok: true as const, corsRules: rules };
}

export async function setBucketCors(ownerId: string, bucketName: string, corsRules: string) {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "NoSuchBucket" };
  await sql`update mo_buckets set cors_rules = ${corsRules} where id = ${bucket.id}`;
  return { ok: true as const };
}

export async function deleteBucketCors(ownerId: string, bucketName: string) {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "NoSuchBucket" };
  await sql`update mo_buckets set cors_rules = '[]' where id = ${bucket.id}`;
  return { ok: true as const };
}

export async function getBucketPolicy(ownerId: string, bucketName: string) {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "NoSuchBucket" };
  const rows = await sql<{ policy: string | null }>`select policy from mo_buckets where id = ${bucket.id}`;
  const policy = rows[0]?.policy;
  if (!policy) return { ok: false as const, error: "NoSuchBucketPolicy" };
  return { ok: true as const, policy };
}

export async function setBucketPolicy(ownerId: string, bucketName: string, policy: string) {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "NoSuchBucket" };
  await sql`update mo_buckets set policy = ${policy} where id = ${bucket.id}`;
  return { ok: true as const };
}

export async function deleteBucketPolicy(ownerId: string, bucketName: string) {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  if (!bucket) return { ok: false as const, error: "NoSuchBucket" };
  await sql`update mo_buckets set policy = null where id = ${bucket.id}`;
  return { ok: true as const };
}

export async function getSystemMetrics() {
  const sql = await getSql();
  const buckets = await sql<{ n: unknown }>`select count(*)::int as n from mo_buckets`;
  const objects = await sql<{ n: unknown; bytes: unknown }>`
    select count(*)::int as n, coalesce(sum(size), 0)::bigint as bytes from mo_objects where complete = true
  `;
  const keys = await sql<{ n: unknown }>`select count(*)::int as n from mo_keys`;
  return {
    totalBuckets: asNum(buckets[0]?.n),
    totalObjects: asNum(objects[0]?.n),
    totalBytes: asNum(objects[0]?.bytes),
    totalKeys: asNum(keys[0]?.n),
  };
}

export async function ping() {
  const sql = await getSql();
  await sql`select 1 as ok`;
}
