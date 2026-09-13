import { Pool, QueryResultRow } from 'pg';
import dotenv from 'dotenv';
import {
  pgliteQuery,
  pgliteWithTransaction,
  endPglite,
  initPglite,
  execPglite,
} from './pglitePool';

dotenv.config();

const USE_PGLITE = process.env.DB_DRIVER === 'pglite';

/**
 * Minimal transaction-client interface that both `pg.PoolClient` and the
 * PGlite transaction client satisfy. Services only use `client.query()`.
 */
export interface TxClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }>;
}

// ---- PostgreSQL (server) implementation ----------------------------------
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.PG_HOST || 'localhost',
      port: Number(process.env.PG_PORT) || 5432,
      user: process.env.PG_USER || 'obe_admin',
      password: process.env.PG_PASSWORD || '',
      database: process.env.PG_DATABASE || 'obe_system',
      max: 10,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[db] Unexpected idle client error', err);
      process.exit(-1);
    });
  }
  return pool;
}

/**
 * Execute a query. Delegates to PGlite (embedded PostgreSQL via WASM) when
 * DB_DRIVER=pglite, otherwise uses the standard pg connection pool.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  if (USE_PGLITE) {
    return pgliteQuery<T>(text, params);
  }
  const r = await getPool().query<T>(text, params as unknown[]);
  return { rows: r.rows, rowCount: r.rowCount ?? 0 };
}

/**
 * Run `fn` inside a single transaction. Commits on success, rolls back on
 * error. Delegates to PGlite when DB_DRIVER=pglite.
 */
export async function withTransaction<T>(
  fn: (client: TxClient) => Promise<T>
): Promise<T> {
  if (USE_PGLITE) {
    return pgliteWithTransaction(fn);
  }
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client as unknown as TxClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function endPool(): Promise<void> {
  if (USE_PGLITE) {
    await endPglite();
  } else if (pool) {
    await pool.end();
  }
}

export { initPglite, execPglite };
