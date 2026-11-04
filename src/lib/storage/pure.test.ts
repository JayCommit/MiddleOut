import assert from "node:assert/strict";
import test from "node:test";
import { groupListing, validateBucketName } from "./pure.ts";

test("groupListing folds keys under a delimiter", () => {
  const rows = [{ key: "a.txt" }, { key: "b/c.txt" }, { key: "b/d.txt" }, { key: "b/" }, { key: "e.txt" }];
  const page = groupListing(rows, { prefix: "", delimiter: "/", maxKeys: 100, rawCapped: false });
  assert.deepEqual(page.prefixes, ["b/"]);
  assert.deepEqual(
    page.contents.map((row) => row.key),
    ["a.txt", "e.txt"],
  );
  assert.equal(page.truncated, false);
});

test("groupListing pages with max keys", () => {
  const rows = [{ key: "a.txt" }, { key: "b.txt" }, { key: "c.txt" }];
  const page = groupListing(rows, { prefix: "", delimiter: "", maxKeys: 2, rawCapped: false });
  assert.deepEqual(
    page.contents.map((row) => row.key),
    ["a.txt", "b.txt"],
  );
  assert.equal(page.truncated, true);
  assert.equal(page.nextStart, "b.txt");
});

test("bucket names follow S3 shape", () => {
  assert.equal(validateBucketName("public-samples"), null);
  assert.ok(validateBucketName("A"));
  assert.ok(validateBucketName("bad_name"));
});
