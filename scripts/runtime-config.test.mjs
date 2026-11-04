import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
for (const value of ["-1", "1.5", "garbage", "134217729"])
  test(`reject invalid object limit ${value}`, () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", "import './scripts/runtime-config.mjs'"],
      { env: { ...process.env, MAX_OBJECT_BYTES: value }, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /MAX_OBJECT_BYTES/);
  });

test("object limit cannot exceed even the default account quota", () => {
  const result=spawnSync(process.execPath,["--input-type=module","-e","import './scripts/runtime-config.mjs'"],{env:{...process.env,MAX_OBJECT_BYTES:"134217728",ACCOUNT_QUOTA_BYTES:""},encoding:"utf8"});
  assert.notEqual(result.status,0); assert.match(result.stderr,/ACCOUNT_QUOTA_BYTES/);
});
