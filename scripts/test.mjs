import { spawnSync } from "node:child_process";
const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--test",
    "--test-concurrency=1",
    "src/lib/s3/sigv4.test.ts",
    "src/lib/s3/security.test.ts",
    "src/lib/s3/s3-engine.test.ts",
    "src/lib/storage/pure.test.ts",
    "src/lib/storage/features.test.ts",
    "src/lib/storage/regressions.test.ts",
    "scripts/persistence.test.mjs",
    "scripts/recovery.test.mjs",
    "scripts/upgrade.test.mjs",
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      DATA_DIR: ":memory:",
      DATABASE_URL: process.env.TEST_DATABASE_URL || "",
    },
  },
);
process.exit(result.status ?? 1);
