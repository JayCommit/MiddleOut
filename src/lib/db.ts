import { AsyncLocalStorage } from "node:async_hooks";
import { pendingMigrations } from "../../scripts/migration-plan.mjs";

/** Which database backend is active. */
export type DbSource = "postgres" | "pglite";

// An empty/whitespace DATABASE_URL (an easy misconfig in deploy UIs) must mean
// "unset" — otherwise production would silently run on the PGLite fallback.
const rawDatabaseUrl = typeof process !== "undefined" ? process.env.DATABASE_URL : undefined;
const databaseUrl = rawDatabaseUrl && rawDatabaseUrl.trim() ? rawDatabaseUrl : undefined;

/** External Postgres when configured; otherwise durable single-process PGLite. */
export const dbSource: DbSource = databaseUrl ? "postgres" : "pglite";

/**
 * Minimal shared SQL surface, satisfied by both Postgres and PGLite. Both the
 * tagged-template and `.query()` forms resolve to an array of row objects:
 *
 *   const sql = await getSql();
 *   const rows = await sql`select * from todos where id = ${id}`; // parameterized
 *   const rows2 = await sql.query("select * from todos where id = $1", [id]);
 */
export interface Sql {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Init state lives on globalThis as promises: dev HMR creates new instances of
 * this module, and two instances racing module-level state would open a second
 * pool or run two concurrent PGLite migration passes (whose duplicate
 * `_migrations` insert rejects — and would get memoized, poisoning every later
 * `getSql()`). A failed init clears its slot so the next call retries.
 */
const globalRef = globalThis as typeof globalThis & {
  __sqlTransactionContext__?: AsyncLocalStorage<Sql>;
  __pgSqlPromise__?: Promise<Sql>;
  __pgliteInstance__?: Promise<import("@electric-sql/pglite").PGlite>;
  __pgliteMigrateChain__?: Promise<void>;
};

/**
 * Result-type parity: Postgres sends every value as text plus a type OID — the
 * JS value is the DRIVER's parsing choice, and pg and PGLite disagree (pg:
 * int8 -> string, date -> local-midnight Date; PGLite: int8 -> BigInt, which
 * JSON.stringify rejects, date -> UTC Date). Normalize both so preview and
 * production return identical, JSON-safe shapes:
 *   int8/bigint (incl. count(*)) -> number (past 2^53 loses precision — cast
 *                                   `::text` if you ever need huge integers)
 *   date                         -> 'YYYY-MM-DD' string
 *   interval                     -> Postgres interval text
 * numeric already comes back as a string on both (arbitrary precision).
 */
const OID_INT8 = 20;
const OID_DATE = 1082;
const OID_INTERVAL = 1186;
const identity = (v: string) => v;

const transactionContext = (globalRef.__sqlTransactionContext__ ??= new AsyncLocalStorage<Sql>());

type Run = <T>(text: string, params: unknown[]) => Promise<T[]>;

/** Wrap a query runner in the tagged-template + `.query()` `Sql` surface. */
function toSql(run: Run, transaction: Sql["transaction"]): Sql {
  const sql = (async <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> => {
    // Rebuild with $1, $2, … placeholders so values stay parameterized.
    let text = strings[0];
    for (let i = 0; i < values.length; i += 1) text += `$${i + 1}${strings[i + 1]}`;
    return run<T>(text, values);
  }) as unknown as Sql;
  sql.query = <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    run<T>(text, params);
  sql.transaction = (fn) => transaction((tx) => transactionContext.run(tx, () => fn(tx)));
  return sql;
}

function createPostgresSql(): Promise<Sql> {
  globalRef.__pgSqlPromise__ ??= (async () => {
    // Generic node-postgres pool. Transactions pin a single connection.
    const { Pool, types } = await import("pg");
    types.setTypeParser(OID_INT8, Number);
    types.setTypeParser(OID_DATE, identity);
    types.setTypeParser(OID_INTERVAL, identity);
    const pool = new Pool({ connectionString: databaseUrl });
    const run: Run = async <T>(text: string, params: unknown[]) =>
      (await pool.query(text, params)).rows as T[];
    return toSql(run, async (fn) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = toSql(
          async <T>(text: string, params: unknown[]) =>
            (await client.query(text, params)).rows as T[],
          async (nested) => nested(tx),
        );
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  })().catch((err) => {
    globalRef.__pgSqlPromise__ = undefined;
    throw err;
  });
  return globalRef.__pgSqlPromise__;
}

/** WASM + filesystem bundle live beside the package, not the bundled server chunk. */
async function pgliteAssets(): Promise<{
  fsBundle: Blob;
  pgliteWasmModule: WebAssembly.Module;
  initdbWasmModule: WebAssembly.Module;
}> {
  const { createRequire } = await import("node:module");
  const { readFile } = await import("node:fs/promises");
  const { dirname, join } = await import("node:path");
  let dist = join(process.cwd(), "node_modules/@electric-sql/pglite/dist");
  try {
    dist = dirname(createRequire(import.meta.url).resolve("@electric-sql/pglite"));
  } catch {
    // Bundled preview: resolution walks up to the workspace node_modules.
  }
  const [data, wasm, initdb] = await Promise.all([
    readFile(join(dist, "pglite.data")),
    readFile(join(dist, "pglite.wasm")),
    readFile(join(dist, "initdb.wasm")),
  ]);
  const compile = (buf: Uint8Array) =>
    WebAssembly.compile(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
  return {
    fsBundle: new Blob([new Uint8Array(data)]),
    pgliteWasmModule: await compile(wasm),
    initdbWasmModule: await compile(initdb),
  };
}

async function createPgliteSql(): Promise<Sql> {
  // Embedded Postgres, imported on demand so it never loads on the Postgres path.
  // One persistent instance per process, shared across HMR module instances, so
  // data survives process restarts in DATA_DIR/db.
  globalRef.__pgliteInstance__ ??= (async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const assets = await pgliteAssets();
    const { resolve } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    const dataDir =
      process.env.DATA_DIR === ":memory:"
        ? undefined
        : resolve(process.env.DATA_DIR || "data", "db");
    if (dataDir) await mkdir(dataDir, { recursive: true });
    const pg = new PGlite({
      dataDir,
      ...assets,
      parsers: {
        [OID_INT8]: Number,
        [OID_DATE]: identity,
        [OID_INTERVAL]: identity,
      },
    });
    await pg.waitReady;
    await pg.exec(
      "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    return pg;
  })().catch((err) => {
    globalRef.__pgliteInstance__ = undefined;
    throw err;
  });
  const pg = await globalRef.__pgliteInstance__;

  // Apply migrations/ (the single schema source) so preview matches production.
  // SQL is inlined by the bundler via import.meta.glob (no runtime fs); applied
  // files are tracked in _migrations. The glob does not descend, so the opt-in
  // auth schema under migrations/auth/ stays out. Runs once per module instance
  // — so an HMR reload after adding a migration file applies it live — with
  // passes serialized on a global chain so concurrent callers never
  // double-apply.
  const migrate = async (): Promise<void> => {
    let migrations: Record<string, string> = {};
    if (typeof (import.meta as unknown as { glob?: unknown }).glob === "function") {
      migrations = (
        import.meta as unknown as {
          glob: (pattern: string, options: unknown) => Record<string, string>;
        }
      ).glob("/migrations/*.sql", {
        query: "?raw",
        import: "default",
        eager: true,
      });
    } else {
      const { readdirSync, readFileSync, existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const dir = join(process.cwd(), "migrations");
      if (existsSync(dir)) {
        for (const file of readdirSync(dir)) {
          if (file.endsWith(".sql")) {
            migrations[`/migrations/${file}`] = readFileSync(join(dir, file), "utf8");
          }
        }
      }
    }
    const doneRows = await pg.query<{ name: string }>("select name from _migrations");
    const done = doneRows.rows.map((r) => r.name);
    for (const { name, path } of pendingMigrations(Object.keys(migrations), done)) {
      // Apply + record atomically (parity with scripts/migrate.mjs) so a failed
      // statement can't leave a file half-applied but untracked.
      await pg.transaction(async (tx) => {
        await tx.exec(migrations[path]);
        await tx.query("insert into _migrations (name) values ($1)", [name]);
      });
    }
  };
  const pass = (globalRef.__pgliteMigrateChain__ ?? Promise.resolve())
    .catch(() => undefined) // an earlier failed pass must not wedge the chain
    .then(migrate);
  globalRef.__pgliteMigrateChain__ = pass;
  await pass;

  return toSql(
    async <T>(text: string, params: unknown[]) => {
      const result = await pg.query<T>(text, params);
      return result.rows;
    },
    async (fn) =>
      pg.transaction(async (client) => {
        const tx = toSql(
          async <T>(text: string, params: unknown[]) => (await client.query<T>(text, params)).rows,
          async (nested) => nested(tx),
        );
        return fn(tx);
      }),
  );
}

let sqlPromise: Promise<Sql> | null = null;

async function createSql(): Promise<Sql> {
  if (typeof window !== "undefined") {
    throw new Error(
      "@/lib/db is server-only — call getSql() from a createServerFn handler " +
        "or a server route loader, never from client code.",
    );
  }
  return dbSource === "postgres" ? createPostgresSql() : createPgliteSql();
}

/**
 * Get the shared, **server-only** SQL client. Postgres when `DATABASE_URL` is set,
 * otherwise the local PGLite fallback. Memoized — safe to call per request.
 *
 * Schema comes from `migrations/*.sql`, auto-applied before the first query on
 * both backends — define tables there, never inline in server functions.
 */
export function getSql(): Promise<Sql> {
  const active = transactionContext.getStore();
  if (active) return Promise.resolve(active);
  sqlPromise ??= createSql().catch((err) => {
    sqlPromise = null; // don't memoize failures — let the next call retry
    throw err;
  });
  return sqlPromise;
}

/**
 * The shared PGLite instance (preview only), with `migrations/*.sql` applied.
 * Lets Better Auth persist to the SAME embedded DB as app data in preview (via a
 * Kysely dialect). Throws when `DATABASE_URL` is set (that path uses Postgres).
 */
export async function getPglite(): Promise<import("@electric-sql/pglite").PGlite> {
  if (dbSource !== "pglite") {
    throw new Error("getPglite() is only available on the PGLite fallback (no DATABASE_URL)");
  }
  await getSql();
  const pg = await globalRef.__pgliteInstance__;
  if (!pg) throw new Error("PGLite instance failed to initialize");
  return pg;
}

/**
 * Finish DB bootstrap before the server handles traffic.
 *
 * - **PGLite** (preview / no `DATABASE_URL`): open the persistent DB and apply
 *   `migrations/*.sql`. Idempotent — concurrent callers share one promise.
 * - **Postgres**: no-op (pool is created lazily on first query).
 *
 * Vite `configureServer` awaits this at dev startup; production imports of this
 * module kick it off immediately (see bottom of file).
 */
export function ensureDbReady(): Promise<void> {
  if (dbSource !== "pglite") return Promise.resolve();
  return getSql().then(() => undefined);
}

// Server-only eager start: kick PGLite bootstrap as soon as this module loads in
// Node. Client bundles never hit this path (`getSql` throws in the browser).
const globalBoot = globalThis as typeof globalThis & {
  __pgBootstrapPromise__?: Promise<void>;
};
if (typeof window === "undefined" && dbSource === "pglite") {
  globalBoot.__pgBootstrapPromise__ ??= ensureDbReady().catch((err) => {
    globalBoot.__pgBootstrapPromise__ = undefined;
    console.error("[db] PGLite bootstrap failed:", err);
    throw err;
  });
}
