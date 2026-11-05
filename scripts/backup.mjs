import {
  cp,
  access,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rename,
  lstat,
  chmod,
  rm,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { resolve, join, relative, sep, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { acquireDataLock, dataDirectory } from "./data-directory.mjs";
const [action, destination] = process.argv.slice(2);
if (!["backup", "restore"].includes(action) || !destination)
  throw new Error(
    "Usage: node scripts/backup.mjs backup|restore <backup-directory>; DATA_DIR selects the node data directory.",
  );
if (process.env.DATABASE_URL?.trim())
  throw new Error(
    "External Postgres requires pg_dump/pg_restore and a separately retained BETTER_AUTH_SECRET; this tool is for embedded storage.",
  );
const data = dataDirectory();
const backup = resolve(destination);
if (backup === data || backup.startsWith(data + sep) || data.startsWith(backup + sep))
  throw new Error("Backup and data directories must be separate, non-nested paths.");
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
};
async function inventory(root, path = root) {
  if ((await lstat(path)).isSymbolicLink())
    throw new Error("Symbolic links are not allowed in node backups.");
  const files = {};
  for (const item of await readdir(path)) {
    if (item === ".middleout-lock" || (path === root && item === "backup-manifest.json")) continue;
    const full = join(path, item);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new Error("Symbolic links are not allowed in node backups.");
    if (info.isDirectory()) Object.assign(files, await inventory(root, full));
    else if (info.isFile()) {
      const hash = createHash("sha256");
      for await (const bytes of createReadStream(full)) hash.update(bytes);
      files[relative(root, full).split(sep).join("/")] = hash.digest("hex");
    } else throw new Error("Unsupported file in node backup.");
  }
  return files;
}
let release;
try {
  if (action === "backup") {
    if (!(await exists(join(data, "db")))) throw new Error("No embedded database found.");
    if (await exists(backup))
      throw new Error("Backup destination already exists; choose a new directory.");
    release = await acquireDataLock(data);
    await inventory(data); // Reject links before copying, as well as in the copy.
    await cp(data, backup, {
      recursive: true,
      filter: (path) => !path.endsWith(sep + ".middleout-lock"),
    });
    await chmod(backup, 0o700);
    await writeFile(
      join(backup, "backup-manifest.json"),
      JSON.stringify(
        { format: 1, createdAt: new Date().toISOString(), files: await inventory(backup) },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log("Backup created and checksummed.");
  } else {
    if (await exists(data))
      throw new Error("Restore requires an absent DATA_DIR. Existing data is never overwritten.");
    const manifest = JSON.parse(await readFile(join(backup, "backup-manifest.json"), "utf8"));
    if (
      manifest.format !== 1 ||
      JSON.stringify(Object.entries(await inventory(backup)).sort()) !==
        JSON.stringify(Object.entries(manifest.files).sort())
    )
      throw new Error("Backup checksum verification failed.");
    await mkdir(dirname(data), { recursive: true });
    const staging = data + ".restore-" + randomUUID();
    try {
      await cp(backup, staging, {
        recursive: true,
        filter: (path) => !path.endsWith(sep + "backup-manifest.json"),
      });
      await chmod(staging, 0o700);
      if (await exists(data)) throw new Error("Restore target changed during restore.");
      await rename(staging, data);
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    console.log(
      "Backup verified and restored. Keep the original backup until the restored node has been checked.",
    );
  }
} finally {
  await release?.();
}
