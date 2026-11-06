import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import * as q from "./queries.server.ts";
import { getSql } from "../db.ts";
import { handleS3 } from "../s3/engine.server.ts";
import {
  LifecycleError,
  lifecycleExpiry,
  lifecycleMatches,
  validateLifecycleRules,
  type LifecycleRule,
} from "./lifecycle.ts";
import { parseLifecycleXml, lifecycleXml } from "./lifecycle-xml.ts";
import {
  deleteLifecycle,
  getLifecycle,
  LIFECYCLE_BATCH_SIZE,
  previewLifecycle,
  runLifecycleMaintenance,
  runLifecycleNow,
  setLifecycle,
} from "./lifecycle.server.ts";

const rule = (input: Partial<LifecycleRule> = {}): LifecycleRule => ({
  id: "expire-logs",
  status: "Enabled",
  prefix: "logs/",
  tags: [],
  expirationDays: 1,
  ...input,
});
const fixedNow = new Date("2030-02-10T12:00:00.000Z");
async function fixture(t: TestContext) {
  const suffix = randomUUID().slice(0, 8);
  const owner = `lifecycle-owner-${suffix}`,
    bucket = `lifecycle-${suffix}`;
  await q.createBucket(owner, bucket, "private");
  const sql = await getSql();
  t.after(async () => {
    await sql`delete from mo_buckets where owner_id = ${owner}`;
  });
  const [record] = await sql<{ id: string }>`select id from mo_buckets where name = ${bucket}`;
  const write = async (key: string, text = "data", date = "2030-02-01T10:30:00.000Z") => {
    const result = await q.putBytes(owner, bucket, key, Buffer.from(text), "text/plain", {});
    assert.ok(result.ok);
    await sql`update mo_objects set written_at = ${date} where id = ${result.id}`;
    return result.id!;
  };
  return { owner, bucket, id: record.id, sql, write };
}

test("lifecycle validation and XML round trips preserve every supported filter/action", () => {
  const rules = [
    rule({
      id: 'Retention & "logs" ü',
      prefix: " logs/&_%\r",
      tags: [
        { key: "class", value: "temporary" },
        { key: "spaces", value: " keep &amp;&#13; " },
      ],
      sizeGreaterThan: 0,
      sizeLessThan: 500,
    }),
    rule({
      id: "date",
      prefix: "",
      expirationDays: undefined,
      expirationDate: "2030-02-10T00:00:00.000Z",
      abortDays: 7,
    }),
    rule({ id: "off", status: "Disabled" }),
  ];
  const validated = validateLifecycleRules(rules);
  assert.deepEqual(parseLifecycleXml(lifecycleXml(validated)), validated);
  const legacy =
    "<LifecycleConfiguration><Rule><Prefix></Prefix><Status>Enabled</Status><AbortIncompleteMultipartUpload><DaysAfterInitiation>7</DaysAfterInitiation></AbortIncompleteMultipartUpload></Rule></LifecycleConfiguration>";
  assert.equal(parseLifecycleXml(legacy)[0].abortDays, 7);
  assert.equal(parseLifecycleXml(legacy)[0].id, "rule-1");
  const namespaced = lifecycleXml([rule()])
    .replace(
      /<(\/?)(LifecycleConfiguration|Rule|ID|Filter|Prefix|Status|Expiration|Days)/g,
      "<$1s3:$2",
    )
    .replace("xmlns=", "xmlns:s3=");
  assert.deepEqual(parseLifecycleXml(namespaced), [rule()]);
  assert.equal(
    validateLifecycleRules(Array.from({ length: 1000 }, (_, i) => rule({ id: `r-${i}` }))).length,
    1000,
  );
  const match = rule({
    tags: [{ key: "kind", value: "temp" }],
    sizeGreaterThan: 5,
    sizeLessThan: 10,
  });
  assert.equal(
    lifecycleMatches(match, { key: "logs/file", size: 6, tags: [{ key: "kind", value: "temp" }] }),
    true,
  );
  assert.equal(
    lifecycleMatches(match, { key: "logs/file", size: 5, tags: [{ key: "kind", value: "temp" }] }),
    false,
  );
  assert.equal(
    lifecycleMatches(match, { key: "logs/file", size: 10, tags: [{ key: "kind", value: "temp" }] }),
    false,
  );
  assert.equal(
    lifecycleExpiry(rule({ expirationDays: 3 }), "2030-01-15T10:30:00Z"),
    Date.parse("2030-01-19T00:00:00Z"),
  );
});

test("invalid/unsupported lifecycle XML and filters fail closed", () => {
  const invalidRules: unknown[] = [
    [],
    Array.from({ length: 1001 }, (_, i) => rule({ id: String(i) })),
    [rule(), rule()],
    [rule({ expirationDays: 0 })],
    [rule({ expirationDays: 1.5 })],
    [rule({ expirationDays: -1 })],
    [rule({ expirationDays: undefined })],
    [rule({ expirationDays: undefined, expirationDate: "2030-02-30T00:00:00Z" })],
    [rule({ expirationDate: "2030-02-01T00:00:00Z" })],
    [rule({ expirationDays: undefined, expirationDate: "2030-02-01T01:00:00Z" })],
    [rule({ sizeGreaterThan: 4, sizeLessThan: 4 })],
    [rule({ abortDays: 1, tags: [{ key: "x", value: "y" }] })],
    [
      rule({
        tags: [
          { key: "x", value: "a" },
          { key: "x", value: "b" },
        ],
      }),
    ],
    [rule({ id: "bad\n\u0000" })],
    [{ ...rule(), typoFilter: "keep/" }],
  ];
  for (const invalid of invalidRules)
    assert.throws(() => validateLifecycleRules(invalid), LifecycleError);
  const valid = lifecycleXml([rule()]);
  for (const xml of [
    valid.replace("<Filter><Prefix>logs/</Prefix></Filter>", "<Filter><Typo>logs/</Typo></Filter>"),
    valid.replace("<Days>1</Days>", "<Days>1</Days><Days>2</Days>"),
    valid.replace("<Days>1</Days>", "<Days>1.5</Days>"),
    valid.replace("<Days>1</Days>", "<Days>-1</Days>"),
    valid.replace("<Status>Enabled</Status>", ""),
    valid.replace(
      "<Filter><Prefix>logs/</Prefix></Filter>",
      "<Filter><Prefix>logs/</Prefix><Tag><Key>x</Key><Value>y</Value></Tag></Filter>",
    ),
    valid + "<extra/>",
    "<LifecycleConfiguration><Rule>",
    '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + valid,
  ])
    assert.throws(() => parseLifecycleXml(xml), LifecycleError);
  assert.throws(
    () =>
      parseLifecycleXml(
        valid.replace(
          "<Expiration><Days>1</Days></Expiration>",
          "<Transition><Days>1</Days><StorageClass>GLACIER</StorageClass></Transition>",
        ),
      ),
    (error: unknown) => error instanceof LifecycleError && error.code === "NotImplemented",
  );
});

test("S3 lifecycle API enforces ownership, scopes, read-only keys and missing-config semantics", async (t) => {
  const f = await fixture(t);
  const key = await q.createKey(f.owner, "lifecycle-full");
  const readonly = await q.createKey(f.owner, "lifecycle-read", "read-only");
  const outsiderBucket = `${f.bucket}-other`;
  const outsider = `${f.owner}-other`;
  await q.createBucket(outsider, outsiderBucket);
  t.after(async () => {
    await f.sql`delete from mo_buckets where owner_id = ${outsider}`;
  });
  const otherKey = await q.createKey(outsider, "outsider");
  const restricted = await q.createKey(f.owner, "bucket-scoped", "full", `${f.bucket}`);
  const auth = (record: typeof key) => ({
    authorization: `MO ${record.accessKeyId}:${record.secretKey}`,
  });
  const endpoint = `http://localhost/api/s3/${f.bucket}?lifecycle`;
  const send = (method: string, record = key, body?: string) =>
    handleS3(new Request(endpoint, { method, headers: auth(record), body }));
  assert.equal((await send("GET")).status, 404);
  assert.match(await (await send("GET")).text(), /NoSuchLifecycleConfiguration/);
  const xml = lifecycleXml([rule()]);
  assert.equal((await handleS3(new Request(endpoint, { method: "PUT", body: xml }))).status, 403);
  assert.equal((await send("PUT", otherKey, xml)).status, 403);
  assert.equal((await send("PUT", readonly, xml)).status, 403);
  assert.equal((await send("PUT", key, xml)).status, 200);
  assert.deepEqual(parseLifecycleXml(await (await send("GET", readonly)).text()), [rule()]);
  const denied = await handleS3(
    new Request(`http://localhost/api/s3/${outsiderBucket}?lifecycle`, {
      method: "PUT",
      headers: auth(restricted),
      body: xml,
    }),
  );
  assert.equal(denied.status, 403);
  assert.equal(
    (await send("PUT", key, xml.replace("<Days>1</Days>", "<Days>0</Days>"))).status,
    400,
  );
  assert.deepEqual(
    (await getLifecycle(f.owner, f.bucket)).rules,
    [rule()],
    "Invalid replacement must leave old config intact",
  );
  assert.equal((await send("DELETE", readonly)).status, 403);
  assert.equal((await send("DELETE")).status, 204);
  assert.equal((await send("DELETE")).status, 204);
  assert.equal((await send("GET")).status, 404);
  assert.equal(
    (
      await handleS3(
        new Request(`http://localhost/api/s3/${f.bucket}`, { method: "HEAD", headers: auth(key) }),
      )
    ).status,
    200,
    "Deleting rules must not delete the bucket",
  );
  await q.createBucket(f.owner, `${f.bucket}-drive`, "private", {
    provider: "gdrive",
    providerConfig: { folderId: "unused", mountMode: "rw" },
  });
  assert.equal(
    (
      await handleS3(
        new Request(`http://localhost/api/s3/${f.bucket}-drive?lifecycle`, {
          method: "PUT",
          headers: auth(key),
          body: xml,
        }),
      )
    ).status,
    501,
  );
  await assert.rejects(getLifecycle(outsider, f.bucket), LifecycleError);
  await assert.rejects(previewLifecycle(outsider, f.bucket, [rule()]), LifecycleError);
});

test("preview and execution agree on literal prefixes, tags, sizes, cascades and quota", async (t) => {
  const f = await fixture(t);
  const matching = await f.write("logs%_/match", "123456");
  await f.write("logsXX/match", "123456");
  await f.write("logs%_/small", "12345");
  await f.write("logs%_/large", "1234567890");
  await f.write("logs%_/untagged", "123456");
  for (const key of ["logs%_/match", "logs%_/small", "logs%_/large"])
    await q.setTags(f.owner, f.bucket, key, [{ key: "kind", value: "temp" }]);
  const link = await q.createLink(f.owner, f.bucket, "logs%_/match", 3600);
  const rules = [
    rule({
      prefix: "logs%_/",
      tags: [{ key: "kind", value: "temp" }],
      sizeGreaterThan: 5,
      sizeLessThan: 10,
    }),
  ];
  const before = await q.overview(f.owner);
  const preview = await previewLifecycle(f.owner, f.bucket, rules, fixedNow);
  assert.equal(preview.objectCount, 1);
  assert.equal(preview.objectBytes, 6);
  assert.deepEqual(
    preview.sample.map((object) => object.key),
    ["logs%_/match"],
  );
  assert.ok(
    "object" in (await q.readObjectFor(f.owner, f.bucket, "logs%_/match")),
    "Preview must not delete",
  );
  const { revision } = await setLifecycle(f.owner, f.bucket, rules);
  const result = await runLifecycleNow(f.owner, f.bucket, revision, fixedNow);
  assert.equal(result.expiredObjects, 1);
  assert.equal(result.expiredBytes, 6);
  assert.equal(await q.readShare(link.token!), null);
  const [parts] = await f.sql<{
    n: number;
  }>`select count(*)::int as n from mo_parts where object_id = ${matching}`;
  const [tags] = await f.sql<{
    n: number;
  }>`select count(*)::int as n from mo_tags where object_id = ${matching}`;
  assert.equal(parts.n + tags.n, 0);
  const after = await q.overview(f.owner);
  assert.equal(before.stats.bytes - after.stats.bytes, 6);
  assert.equal((await getLifecycle(f.owner, f.bucket)).expiredObjects, 1);
  assert.ok(
    (await q.listAudit(f.owner)).some(
      (event) => event.action === "lifecycle.expire" && event.detail.includes("logs%_/match"),
    ),
  );
});

test("UTC eligibility boundaries, disabled/date rules, ACL edits and new publication clocks", async (t) => {
  const f = await fixture(t);
  await f.write("logs/boundary", "old", "2030-02-08T10:30:00Z");
  const rules = [rule()];
  const beforeMidnight = await previewLifecycle(
    f.owner,
    f.bucket,
    rules,
    new Date("2030-02-09T23:59:59.999Z"),
  );
  assert.equal(beforeMidnight.objectCount, 0);
  assert.equal(
    (await previewLifecycle(f.owner, f.bucket, rules, new Date("2030-02-10T00:00:00Z")))
      .objectCount,
    1,
  );
  await q.setObjectAcl(f.owner, f.bucket, "logs/boundary", "public-read");
  const key = await q.createKey(f.owner, "header");
  const { revision } = await setLifecycle(f.owner, f.bucket, [rule({ id: 'expiry "id" ü' })]);
  const head = await handleS3(
    new Request(`http://localhost/api/s3/${f.bucket}/logs/boundary`, {
      method: "HEAD",
      headers: { authorization: `MO ${key.accessKeyId}:${key.secretKey}` },
    }),
  );
  assert.equal(head.status, 200);
  assert.match(head.headers.get("x-amz-expiration")!, /Sun, 10 Feb 2030 00:00:00 GMT/);
  assert.match(head.headers.get("x-amz-expiration")!, /expiry%20%22id%22%20%C3%BC/);
  assert.equal(
    (await previewLifecycle(f.owner, f.bucket, [rule({ status: "Disabled" })], fixedNow))
      .objectCount,
    0,
  );
  assert.equal(
    (
      await previewLifecycle(
        f.owner,
        f.bucket,
        [rule({ expirationDays: undefined, expirationDate: "2030-02-11T00:00:00Z" })],
        fixedNow,
      )
    ).objectCount,
    0,
  );
  assert.equal(
    (
      await previewLifecycle(
        f.owner,
        f.bucket,
        [rule({ expirationDays: undefined, expirationDate: "2030-02-10T00:00:00Z" })],
        fixedNow,
      )
    ).objectCount,
    1,
  );
  await deleteLifecycle(f.owner, f.bucket, revision);
  // Overwriting or completing a staged upload starts a new lifetime; metadata edits do not.
  await q.putBytes(f.owner, f.bucket, "logs/boundary", Buffer.from("fresh"), "text/plain", {});
  const read = await q.readObjectFor(f.owner, f.bucket, "logs/boundary");
  assert.ok("object" in read);
  assert.ok(Date.parse(read.object!.writtenAt!) > Date.parse("2020-01-01T00:00:00Z"));
  const staged = await q.beginUpload(f.owner, {
    bucket: f.bucket,
    key: "logs/staged",
    size: 3,
    contentType: "text/plain",
  });
  assert.ok(staged.ok);
  await q.writePart(f.owner, staged.id!, 0, Buffer.from("new").toString("base64"));
  await f.sql`update mo_objects set written_at = '2020-01-01T00:00:00Z' where id = ${staged.id}`;
  assert.equal(
    (await previewLifecycle(f.owner, f.bucket, rules)).objectCount,
    0,
    "Pending objects never expire as completed files",
  );
  assert.ok((await q.finishUpload(f.owner, staged.id!)).ok);
  const completed = await q.readObjectFor(f.owner, f.bucket, "logs/staged");
  assert.ok("object" in completed);
  assert.ok(Date.parse(completed.object!.writtenAt!) > Date.parse("2020-01-01T00:00:00Z"));
});

test("abort rules use initiation age, remove uploaded parts and preserve completed objects", async (t) => {
  const f = await fixture(t);
  await f.write("logs/committed", "keep");
  const upload = await q.initiateMultipartUpload(
    f.owner,
    f.bucket,
    "logs/incomplete",
    "text/plain",
    {},
  );
  assert.ok(upload.ok);
  await q.uploadMultipartPart(
    f.owner,
    f.bucket,
    "logs/incomplete",
    upload.uploadId!,
    1,
    Buffer.from("parts"),
  );
  await f.sql`update mo_multipart_uploads set created_at = '2030-02-01T12:00:00Z', updated_at = '2030-02-10T11:59:00Z' where id = ${upload.uploadId}`;
  const rules = [rule({ expirationDays: undefined, abortDays: 7 })];
  const preview = await previewLifecycle(f.owner, f.bucket, rules, fixedNow);
  assert.equal(preview.objectCount, 0);
  assert.equal(preview.uploadCount, 1);
  assert.equal(preview.uploadBytes, 5);
  const { revision } = await setLifecycle(f.owner, f.bucket, rules);
  assert.equal((await runLifecycleNow(f.owner, f.bucket, revision, fixedNow)).abortedUploads, 1);
  assert.equal(
    (await q.listMultipartParts(f.owner, f.bucket, "logs/incomplete", upload.uploadId!)).ok,
    false,
  );
  const [parts] = await f.sql<{
    n: number;
  }>`select count(*)::int as n from mo_multipart_parts where upload_id = ${upload.uploadId}`;
  assert.equal(parts.n, 0);
  assert.ok("object" in (await q.readObjectFor(f.owner, f.bucket, "logs/committed")));
});

test("bounded concurrent cleanup drains backlog once and rejects stale config edits/runs", async (t) => {
  const f = await fixture(t);
  await f.sql`insert into mo_objects(id,bucket_id,key,size,content_type,complete,written_at) select ${f.id} || n, ${f.id}, 'logs/' || n, 0, 'text/plain', true, '2030-02-01T00:00:00Z' from generate_series(1, ${LIFECYCLE_BATCH_SIZE + 5}) n`;
  const { revision } = await setLifecycle(f.owner, f.bucket, [rule()], null);
  const results = await Promise.all([
    runLifecycleNow(f.owner, f.bucket, revision, fixedNow),
    runLifecycleNow(f.owner, f.bucket, revision, fixedNow),
  ]);
  assert.equal(
    results.reduce((sum, result) => sum + result.expiredObjects, 0),
    LIFECYCLE_BATCH_SIZE + 5,
  );
  assert.ok(results.some((result) => result.morePending));
  assert.equal((await getLifecycle(f.owner, f.bucket)).expiredObjects, LIFECYCLE_BATCH_SIZE + 5);
  const next = await setLifecycle(f.owner, f.bucket, [rule({ status: "Disabled" })], revision);
  for (const action of [
    () => setLifecycle(f.owner, f.bucket, [rule()], revision),
    () => deleteLifecycle(f.owner, f.bucket, revision),
    () => runLifecycleNow(f.owner, f.bucket, revision),
  ])
    await assert.rejects(
      action,
      (error: unknown) => error instanceof LifecycleError && error.status === 409,
    );
  assert.equal((await getLifecycle(f.owner, f.bucket)).revision, next.revision);
  // The full 1,000-rule configuration executes and overlapping matches count only once.
  await f.write("logs/max-rules", "data");
  const maximal = Array.from({ length: 1000 }, (_, index) =>
    rule({ id: `rule-${index}`, expirationDays: index === 999 ? 1 : 30 }),
  );
  const configured = await setLifecycle(f.owner, f.bucket, maximal, next.revision);
  assert.equal((await previewLifecycle(f.owner, f.bucket, maximal, fixedNow)).objectCount, 1);
  assert.equal(
    (await runLifecycleNow(f.owner, f.bucket, configured.revision, fixedNow)).expiredObjects,
    1,
  );
});

test("cleanup and overwrites serialize so newly published bytes survive", async (t) => {
  const f = await fixture(t);
  await f.write("logs/race", "old", "2020-01-01T00:00:00Z");
  const { revision } = await setLifecycle(f.owner, f.bucket, [rule()]);
  await Promise.all([
    runLifecycleNow(f.owner, f.bucket, revision),
    q.putBytes(f.owner, f.bucket, "logs/race", Buffer.from("new"), "text/plain", {}),
  ]);
  const result = await q.readObjectFor(f.owner, f.bucket, "logs/race");
  assert.ok("object" in result);
  assert.equal(result.object!.bytes.toString(), "new");
});

test("scheduled maintenance is fair and failure rolls back deletion without blocking other buckets", async (t) => {
  const f = await fixture(t);
  await f.write("logs/failure", "keep me");
  await setLifecycle(f.owner, f.bucket, [rule()]);
  const good = await fixture(t);
  await good.write("logs/success", "delete me");
  await setLifecycle(good.owner, good.bucket, [rule()]);
  const trigger = `lifecycle_fail_${randomUUID().replaceAll("-", "")}`;
  await f.sql.query(
    `create function ${trigger}() returns trigger language plpgsql as $$ begin if new.action = 'lifecycle.expire' and new.owner_id = '${f.owner}' then raise exception 'simulated audit failure'; end if; return new; end $$`,
  );
  await f.sql.query(
    `create trigger ${trigger} before insert on mo_audit for each row execute function ${trigger}()`,
  );
  try {
    const result = await runLifecycleMaintenance(fixedNow);
    assert.equal(result.expiredObjects, 1);
    assert.ok("object" in (await q.readObjectFor(f.owner, f.bucket, "logs/failure")));
    assert.ok("error" in (await q.readObjectFor(good.owner, good.bucket, "logs/success")));
    assert.ok((await getLifecycle(f.owner, f.bucket)).lastError);
    assert.equal((await getLifecycle(f.owner, f.bucket)).expiredObjects, 0);
  } finally {
    await f.sql.query(`drop trigger if exists ${trigger} on mo_audit`);
    await f.sql.query(`drop function if exists ${trigger}()`);
  }
  await runLifecycleMaintenance(fixedNow);
  assert.equal((await getLifecycle(f.owner, f.bucket)).lastError, null);
  const names: string[] = [];
  for (let n = 0; n < 26; n++) {
    const name = `${f.bucket}-${n}`;
    names.push(name);
    await q.createBucket(f.owner, name);
    await setLifecycle(f.owner, name, [rule({ status: "Disabled" })]);
  }
  await runLifecycleMaintenance(fixedNow);
  await runLifecycleMaintenance(fixedNow);
  for (const name of names) assert.ok((await getLifecycle(f.owner, name)).lastEvaluatedAt);
  await f.write("logs/scheduled", "scheduled bytes");
  await setLifecycle(f.owner, f.bucket, [
    rule({ expirationDays: undefined, expirationDate: "2000-01-01T00:00:00Z" }),
  ]);
  const scheduled = await q.cleanupExpired();
  assert.equal(
    scheduled.lifecycle.expiredObjects,
    1,
    "The production maintenance entry point must invoke lifecycle execution",
  );
  assert.ok("error" in (await q.readObjectFor(f.owner, f.bucket, "logs/scheduled")));
});
