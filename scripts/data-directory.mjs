import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import lockfile from "proper-lockfile";
export const dataDirectory = () => resolve(process.env.DATA_DIR || "data");
/** Heartbeat locks survive PID reuse and container namespaces. A crashed node's
 * lock becomes stale after 10 seconds; a live node keeps renewing it. */
export async function acquireDataLock(directory = dataDirectory(), wait = false) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return lockfile.lock(directory, {
    lockfilePath: join(directory, ".middleout-lock"),
    realpath: true,
    stale: 10000,
    update: 2000,
    retries: wait ? { retries: 20, minTimeout: 1000, maxTimeout: 1000 } : 0,
  });
}
