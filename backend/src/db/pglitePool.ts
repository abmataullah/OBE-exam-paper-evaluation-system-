/**
 * PGlite-backed database adapter.
 *
 * PGlite is full PostgreSQL compiled to WASM. It supports enums, triggers,
 * RETURNING, and every other PG feature we use — so the existing schema.sql
 * and all service queries run unchanged. This adapter exposes the same
 * `query()` / `withTransaction()` interface as pool.ts, so the rest of the
 * backend never knows which driver is active.
 *
 * Activated by setting DB_DRIVER=pglite in the environment (used by the
 * Electron desktop app). Data is stored in a local directory (file-backed),
 * so it persists between app launches with zero server configuration.
 */
import type { PGlite as PGliteType } from '@electric-sql/pglite';

type PGlite = PGliteType;
type PGliteCtor = typeof PGliteType;

/**
 * Resolve the PGlite module. Inside an Electron asar archive, Emscripten's
 * WASM loader can't read `postgres.wasm` / `postgres.data` through the asar
 * virtual FS and the process dies silently. electron-builder's `asarUnpack`
 * mirrors the package to `app.asar.unpacked/`, so when we detect we're inside
 * an asar we require from that real on-disk path instead.
 */
function loadPGlite(): PGliteCtor {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const resolved = require.resolve('@electric-sql/pglite');
  const unpacked = resolved.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const target = unpacked !== resolved ? unpacked : '@electric-sql/pglite';
  // eslint-disable-next-line no-console
  console.log('[pglite] loading from', target);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(target);
  return mod.PGlite as PGliteCtor;
}

let db: PGlite | null = null;
let initPromise: Promise<PGlite> | null = null;

/**
 * Lazily initialise the PGlite instance. The data directory comes from
 * PGLITE_DATA_DIR (set by the Electron main process to a path under
 * the user's app-data folder).
 */
async function getDb(): Promise<PGlite> {
  if (db) return db;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const dataDir = process.env.PGLITE_DATA_DIR;
    // If no data dir is configured, use in-memory (data lost on exit).
    // The desktop app always sets PGLITE_DATA_DIR before starting.
    const PGliteImpl = loadPGlite();
    const instance = dataDir
      ? new PGliteImpl({ dataDir })
      : new PGliteImpl();
    await instance.waitReady;
    db = instance;
    return instance;
  })();

  return initPromise;
}

/** Pre-warm the database (call at startup so the first request is fast). */
export async function initPglite(dataDir: string): Promise<void> {
  process.env.PGLITE_DATA_DIR = dataDir;
  await getDb();
}

/**
 * Execute raw SQL (multiple statements allowed). Uses PGlite's exec() which
 * does NOT use prepared statements, so it can run a full schema file with
 * BEGIN/COMMIT, CREATE TYPE, functions, triggers, etc. Does not return rows.
 */
export async function execPglite(sql: string): Promise<void> {
  const conn = await getDb();
  await conn.exec(sql);
}

interface PgliteResult {
  rows: Record<string, unknown>[];
  affectedRows?: number;
}

/**
 * Mirror pg's rowCount semantics: for statements that return rows (SELECT,
 * INSERT ... RETURNING) it's the number of rows; otherwise affectedRows.
 * PGlite reports affectedRows = 0 for SELECT, which would wrongly look like
 * "no rows" to callers that check `rowCount === 0`.
 */
function rowCountOf(r: PgliteResult): number {
  return r.rows.length > 0 ? r.rows.length : (r.affectedRows ?? 0);
}

export async function pgliteQuery<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number }> {
  const conn = await getDb();
  const result = (await conn.query(text, params as unknown[])) as unknown as PgliteResult;
  return { rows: result.rows as T[], rowCount: rowCountOf(result) };
}

export async function pgliteWithTransaction<T>(
  fn: (client: { query: <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params?: unknown[]) => Promise<{ rows: R[]; rowCount: number }> }) => Promise<T>
): Promise<T> {
  const conn = await getDb();
  // PGlite's transaction() callback gives a tx with the same query() API.
  // It auto-commits on return and auto-rolls-back on throw.
  return conn.transaction(async (tx) => {
    const client = {
      query<R extends Record<string, unknown> = Record<string, unknown>>(
        text: string,
        params?: unknown[]
      ): Promise<{ rows: R[]; rowCount: number }> {
        return (tx.query(text, params as unknown[]) as Promise<PgliteResult>).then(
          (r) => ({ rows: r.rows as R[], rowCount: rowCountOf(r) })
        );
      },
    };
    return fn(client);
  });
}

export async function endPglite(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
    initPromise = null;
  }
}
