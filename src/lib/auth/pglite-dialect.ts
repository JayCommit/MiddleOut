/**
 * Kysely dialect for Better Auth over the app's embedded PGLite instance.
 * Lazy: resolves `getClient` on first connection so migrations can finish first.
 */
import type { PGlite } from "@electric-sql/pglite";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";

type Client = PGlite;

/** Factory used by `auth/server.ts`: `pgliteDialect(() => getPglite())`. */
export function pgliteDialect(getClient: () => Promise<Client> | Client): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new LazyPGliteDriver(getClient),
    createQueryCompiler: (): QueryCompiler => new PostgresQueryCompiler(),
    createIntrospector: (db: Kysely<unknown>): DatabaseIntrospector => new PostgresIntrospector(db),
  };
}

class LazyPGliteDriver implements Driver {
  private client: Client | undefined;
  private connection: PGliteConnection | undefined;
  private queue: Array<(con: PGliteConnection) => void> = [];

  constructor(private readonly getClient: () => Promise<Client> | Client) {}

  async init(): Promise<void> {
    this.client = await this.getClient();
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    if (this.client === undefined) {
      this.client = await this.getClient();
    }
    if (this.connection !== undefined) {
      return new Promise((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.connection = new PGliteConnection(this.client);
    return this.connection;
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    if (connection !== this.connection) {
      throw new Error("Invalid connection");
    }
    const next = this.queue.shift();
    if (next === undefined) {
      this.connection = undefined;
      return;
    }
    next(this.connection);
  }

  async beginTransaction(conn: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    if (settings.isolationLevel && settings.isolationLevel !== "read committed") {
      throw new Error("Embedded auth supports the default transaction isolation only.");
    }
    await (conn as PGliteConnection).begin();
  }

  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as PGliteConnection).finish(false);
  }

  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as PGliteConnection).finish(true);
  }

  async destroy(): Promise<void> {
    // Do not close the client: it is the shared getPglite() singleton used by
    // app SQL (getSql). Only drop our local handle so auth teardown cannot
    // poison the rest of the process.
    this.client = undefined;
    this.connection = undefined;
    this.queue = [];
  }
}

class PGliteConnection implements DatabaseConnection {
  private active: Pick<Client, "query">;
  private settle?: (rollback: boolean) => void;
  private pending?: Promise<void>;
  constructor(private readonly client: Client) {
    this.active = client;
  }

  async begin(): Promise<void> {
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    const entered = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    const done = new Promise<boolean>((resolve) => {
      this.settle = resolve;
    });
    const rollbackSignal = new Error("auth rollback");
    this.pending = this.client
      .transaction(async (tx) => {
        this.active = tx;
        ready();
        if (await done) throw rollbackSignal;
      })
      .catch((error) => {
        failed(error);
        if (error !== rollbackSignal) throw error;
      });
    await entered;
  }

  async finish(rollback: boolean): Promise<void> {
    this.settle?.(rollback);
    try {
      await this.pending;
    } finally {
      this.active = this.client;
      this.settle = undefined;
      this.pending = undefined;
    }
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const result = await this.active.query(compiledQuery.sql, [...compiledQuery.parameters]);
    if (result.affectedRows) {
      return {
        numAffectedRows: BigInt(result.affectedRows),
        rows: result.rows as O[],
      };
    }
    return { rows: result.rows as O[] };
  }

  async *streamQuery<O>(
    compiledQuery: CompiledQuery,
    chunkSize: number,
  ): AsyncIterableIterator<QueryResult<O>> {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
      throw new Error("chunkSize must be a positive integer");
    }
    const result = await this.active.query(compiledQuery.sql, [...compiledQuery.parameters]);
    for (let i = 0; i < result.rows.length; i += chunkSize) {
      yield { rows: result.rows.slice(i, i + chunkSize) as O[] };
    }
  }
}
