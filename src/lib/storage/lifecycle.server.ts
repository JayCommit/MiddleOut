import { maintenanceSeconds } from "../../../scripts/runtime-config.mjs";
import { randomUUID } from "node:crypto";
import { getSql, type Sql } from "../db.ts";
import {
  LifecycleError,
  lifecycleExpiry,
  lifecycleMatches,
  validateLifecycleRules,
  type LifecycleRule,
} from "./lifecycle.ts";

type Bucket = {
  id: string;
  name: string;
  owner_id: string;
  provider: string;
  policy: string | null;
};
type Configuration = {
  configuration: string;
  revision: string;
  last_error: string | null;
  last_evaluated_at: string | Date | null;
  expired_objects: number;
  expired_bytes: number;
  aborted_uploads: number;
};
export const LIFECYCLE_BATCH_SIZE = 200;
export const LIFECYCLE_BUCKET_BATCH = 25;
const iso = (value: string | Date | null) => (value ? new Date(value).toISOString() : null);

async function ownedBucket(sql: Sql, ownerId: string, name: string) {
  const [bucket] =
    await sql<Bucket>`select id, name, owner_id, provider, policy from mo_buckets where name = ${name} and owner_id = ${ownerId}`;
  if (!bucket) throw new LifecycleError("Bucket not found.", "NoSuchBucket", 404);
  if (bucket.provider !== "local")
    throw new LifecycleError(
      "Lifecycle rules are supported only for local buckets; mounted Drive folders are not modified.",
      "NotImplemented",
      501,
    );
  if (bucket.policy !== null)
    throw new LifecycleError(
      "Remove the unsupported bucket policy before configuring lifecycle rules.",
      "AccessDenied",
      403,
    );
  return bucket;
}
async function lockOwner(sql: Sql, ownerId: string) {
  await sql`select owner_id from mo_accounts where owner_id = ${ownerId} for update`;
}
async function configuration(sql: Sql, bucketId: string) {
  const [value] =
    await sql<Configuration>`select configuration, revision, last_error, last_evaluated_at, expired_objects, expired_bytes, aborted_uploads from mo_bucket_lifecycle where bucket_id = ${bucketId}`;
  return value;
}
function checkRevision(current: Configuration | undefined, expected: string | null | undefined) {
  if (expected !== undefined && (current?.revision ?? null) !== expected)
    throw new LifecycleError(
      "Lifecycle rules changed. Reload before saving or running cleanup.",
      "OperationAborted",
      409,
    );
}
async function audit(sql: Sql, ownerId: string, action: string, detail: string) {
  await sql`insert into mo_audit(id, owner_id, action, detail) values(${randomUUID()}, ${ownerId}, ${action}, ${detail.slice(0, 500)})`;
}
export async function getLifecycle(ownerId: string, bucketName: string) {
  const sql = await getSql();
  const bucket = await ownedBucket(sql, ownerId, bucketName);
  const current = await configuration(sql, bucket.id);
  return {
    intervalSeconds: maintenanceSeconds,
    lastError: current?.last_error ?? null,
    rules: current ? validateLifecycleRules(JSON.parse(current.configuration)) : [],
    revision: current?.revision ?? null,
    lastEvaluatedAt: iso(current?.last_evaluated_at ?? null),
    expiredObjects: Number(current?.expired_objects ?? 0),
    expiredBytes: Number(current?.expired_bytes ?? 0),
    abortedUploads: Number(current?.aborted_uploads ?? 0),
  };
}
export async function setLifecycle(
  ownerId: string,
  bucketName: string,
  input: unknown,
  expectedRevision?: string | null,
) {
  const rules = validateLifecycleRules(input);
  const json = JSON.stringify(rules);
  if (Buffer.byteLength(json) > 512 * 1024)
    throw new LifecycleError("Lifecycle configuration exceeds 512 KiB.", "EntityTooLarge", 413);
  return (await getSql()).transaction(async (sql) => {
    await lockOwner(sql, ownerId);
    const bucket = await ownedBucket(sql, ownerId, bucketName);
    checkRevision(await configuration(sql, bucket.id), expectedRevision);
    const revision = randomUUID();
    await sql`insert into mo_bucket_lifecycle(bucket_id, configuration, revision) values(${bucket.id}, ${json}, ${revision})
      on conflict(bucket_id) do update set configuration = excluded.configuration, revision = excluded.revision, updated_at = now(), last_evaluated_at = null, last_error = null`;
    await audit(sql, ownerId, "lifecycle.update", `${bucketName}: ${rules.length} rules`);
    return { revision };
  });
}
export async function deleteLifecycle(
  ownerId: string,
  bucketName: string,
  expectedRevision?: string | null,
) {
  return (await getSql()).transaction(async (sql) => {
    await lockOwner(sql, ownerId);
    const bucket = await ownedBucket(sql, ownerId, bucketName);
    const current = await configuration(sql, bucket.id);
    checkRevision(current, expectedRevision);
    await sql`delete from mo_bucket_lifecycle where bucket_id = ${bucket.id}`;
    if (current) await audit(sql, ownerId, "lifecycle.delete", bucketName);
    return { revision: null };
  });
}

/** Values are bound parameters; the two table/alias choices are internal constants. */
function duePredicate(
  bucketId: string,
  rules: LifecycleRule[],
  now: Date,
  kind: "object" | "upload",
) {
  const values: unknown[] = [bucketId];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  const clauses: string[] = [];
  for (const rule of rules) {
    if (rule.status !== "Enabled") continue;
    const filters: string[] = [];
    if (kind === "object") {
      if (rule.expirationDays !== undefined) {
        const day = 86400000;
        const cutoff = new Date(
          Math.floor(now.getTime() / day) * day - rule.expirationDays * day,
        ).toISOString();
        filters.push(`o.written_at <= ${bind(cutoff)}::timestamptz`);
      } else if (!rule.expirationDate || Date.parse(rule.expirationDate) > now.getTime()) continue;
      if (rule.sizeGreaterThan !== undefined)
        filters.push(`o.size > ${bind(rule.sizeGreaterThan)}::bigint`);
      if (rule.sizeLessThan !== undefined)
        filters.push(`o.size < ${bind(rule.sizeLessThan)}::bigint`);
      if (rule.tags.length)
        filters.push(
          `not exists (select 1 from jsonb_array_elements(${bind(JSON.stringify(rule.tags))}::jsonb) f where not exists (select 1 from mo_tags t where t.object_id = o.id and t.tag_key = f->>'key' and t.tag_value = f->>'value'))`,
        );
    } else {
      if (rule.abortDays === undefined) continue;
      filters.push(
        `o.created_at <= ${bind(new Date(now.getTime() - rule.abortDays * 86400000).toISOString())}::timestamptz`,
      );
    }
    if (rule.prefix)
      filters.push(
        `o.key like ${bind(rule.prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_") + "%")} escape '\\'`,
      );
    clauses.push(`(${filters.join(" and ") || "true"})`);
  }
  return {
    where: `o.bucket_id = $1 ${kind === "object" ? "and o.complete = true" : ""} and (${clauses.join(" or ") || "false"})`,
    values,
  };
}

export async function previewLifecycle(
  ownerId: string,
  bucketName: string,
  input: unknown,
  now = new Date(),
) {
  const rules = Array.isArray(input) && input.length === 0 ? [] : validateLifecycleRules(input);
  return (await getSql()).transaction(async (sql) => {
    await lockOwner(sql, ownerId);
    const bucket = await ownedBucket(sql, ownerId, bucketName);
    const object = duePredicate(bucket.id, rules, now, "object");
    const upload = duePredicate(bucket.id, rules, now, "upload");
    const [objects] = await sql.query<{ count: number; bytes: number }>(
      `select count(*)::int as count, coalesce(sum(o.size),0)::bigint as bytes from mo_objects o where ${object.where}`,
      object.values,
    );
    const [uploads] = await sql.query<{ count: number; bytes: number }>(
      `select count(*)::int as count, coalesce(sum((select coalesce(sum(p.size),0) from mo_multipart_parts p where p.upload_id = o.id)),0)::bigint as bytes from mo_multipart_uploads o where ${upload.where}`,
      upload.values,
    );
    const sample = await sql.query<{ key: string; size: number }>(
      `select o.key, o.size from mo_objects o where ${object.where} order by o.key limit 20`,
      object.values,
    );
    return {
      asOf: now.toISOString(),
      objectCount: Number(objects.count),
      objectBytes: Number(objects.bytes),
      uploadCount: Number(uploads.count),
      uploadBytes: Number(uploads.bytes),
      sample,
    };
  });
}

async function processBucket(sql: Sql, bucket: Bucket, current: Configuration, now: Date) {
  const rules = validateLifecycleRules(JSON.parse(current.configuration));
  const object = duePredicate(bucket.id, rules, now, "object");
  const upload = duePredicate(bucket.id, rules, now, "upload");
  const expired = await sql.query<{ key: string; size: number }>(
    `delete from mo_objects where id in (select o.id from mo_objects o where ${object.where} order by o.written_at, o.id limit ${LIFECYCLE_BATCH_SIZE}) returning key, size`,
    object.values,
  );
  const aborted = await sql.query<{ key: string; id: string }>(
    `delete from mo_multipart_uploads where id in (select o.id from mo_multipart_uploads o where ${upload.where} order by o.created_at, o.id limit ${LIFECYCLE_BATCH_SIZE}) returning key, id`,
    upload.values,
  );
  const expiredBytes = expired.reduce((sum, item) => sum + Number(item.size), 0);
  const events = [
    ...expired.map((item) => ({
      id: randomUUID(),
      action: "lifecycle.expire",
      detail: `${bucket.name}/${item.key}`.slice(0, 500),
    })),
    ...aborted.map((item) => ({
      id: randomUUID(),
      action: "lifecycle.abort",
      detail: `${bucket.name}/${item.key} (upload ${item.id})`.slice(0, 500),
    })),
  ];
  if (events.length)
    await sql`insert into mo_audit(id, owner_id, action, detail) select e.id, ${bucket.owner_id}, e.action, e.detail from jsonb_to_recordset(${JSON.stringify(events)}::jsonb) as e(id text, action text, detail text)`;
  await sql`update mo_bucket_lifecycle set last_evaluated_at = ${now.toISOString()}, last_error = null, expired_objects = expired_objects + ${expired.length}, expired_bytes = expired_bytes + ${expiredBytes}, aborted_uploads = aborted_uploads + ${aborted.length} where bucket_id = ${bucket.id}`;
  return {
    expiredObjects: expired.length,
    expiredBytes,
    abortedUploads: aborted.length,
    morePending: expired.length === LIFECYCLE_BATCH_SIZE || aborted.length === LIFECYCLE_BATCH_SIZE,
  };
}

export async function runLifecycleNow(
  ownerId: string,
  bucketName: string,
  expectedRevision: string | null,
  now = new Date(),
) {
  return (await getSql()).transaction(async (sql) => {
    await lockOwner(sql, ownerId);
    const bucket = await ownedBucket(sql, ownerId, bucketName);
    const current = await configuration(sql, bucket.id);
    checkRevision(current, expectedRevision);
    if (!current)
      return { expiredObjects: 0, expiredBytes: 0, abortedUploads: 0, morePending: false };
    return processBucket(sql, bucket, current, now);
  });
}

/** Oldest-evaluated buckets run first; each pass has a bounded per-bucket budget. */
export async function runLifecycleMaintenance(now = new Date()) {
  const sql = await getSql();
  const buckets =
    await sql<Bucket>`select b.id, b.name, b.owner_id, b.provider, b.policy from mo_bucket_lifecycle l join mo_buckets b on b.id = l.bucket_id where b.provider = 'local' and b.policy is null order by l.last_evaluated_at nulls first, b.id limit ${LIFECYCLE_BUCKET_BATCH}`;
  let expiredObjects = 0,
    expiredBytes = 0,
    abortedUploads = 0;
  for (const candidate of buckets) {
    try {
      const result = await sql.transaction(async (tx) => {
        await lockOwner(tx, candidate.owner_id);
        // Recheck config and bucket state after acquiring the same lock as uploads/config edits.
        const [bucket] =
          await tx<Bucket>`select id, name, owner_id, provider, policy from mo_buckets where id = ${candidate.id} and owner_id = ${candidate.owner_id} and provider = 'local' and policy is null`;
        if (!bucket) return null;
        const current = await configuration(tx, bucket.id);
        return current ? processBucket(tx, bucket, current, now) : null;
      });
      if (result) {
        expiredObjects += result.expiredObjects;
        expiredBytes += result.expiredBytes;
        abortedUploads += result.abortedUploads;
      }
    } catch {
      console.error(JSON.stringify({ event: "lifecycle_failed", bucketId: candidate.id }));
      await sql`update mo_bucket_lifecycle set last_evaluated_at = ${now.toISOString()}, last_error = 'Cleanup failed; retry after checking server logs.' where bucket_id = ${candidate.id}`;
    }
  }
  return { expiredObjects, expiredBytes, abortedUploads };
}

/** S3 HEAD/GET exposes the earliest matching enabled expiration, even before cleanup. */
export async function objectExpirationHeader(
  bucketId: string,
  object: { key: string; size: number; writtenAt: string; id: string },
) {
  const sql = await getSql();
  const current = await configuration(sql, bucketId);
  if (!current) return null;
  const tags = await sql<{
    key: string;
    value: string;
  }>`select tag_key as key, tag_value as value from mo_tags where object_id = ${object.id}`;
  let earliest: { time: number; id: string } | null = null;
  for (const rule of validateLifecycleRules(JSON.parse(current.configuration))) {
    if (!lifecycleMatches(rule, { ...object, tags })) continue;
    const time = lifecycleExpiry(rule, object.writtenAt);
    if (time !== null && (!earliest || time < earliest.time)) earliest = { time, id: rule.id };
  }
  return earliest
    ? `expiry-date="${new Date(earliest.time).toUTCString()}", rule-id="${encodeURIComponent(earliest.id)}"`
    : null;
}
