/**
 * Tiny migration runner: applies schema.sql to the configured database.
 * Idempotent-ish (it uses BEGIN/COMMIT and CREATE TYPE / CREATE TABLE will
 * error if they already exist, so run it on a fresh database).
 *
 * Usage: npm run migrate
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { query, endPool, execPglite } from './pool';

/**
 * Apply schema.sql to the configured database.
 *
 * Under DB_DRIVER=pglite the schema file must be run via PGlite's exec()
 * (multi-statement, no prepared statements) — sending it as a single
 * prepared query fails with `cannot insert multiple commands into a
 * prepared statement`. The standard `pg` driver accepts multi-statement
 * queries, so the web/PostgreSQL target uses the regular query() path.
 */
async function run(): Promise<void> {
  const schemaPath = join(__dirname, 'schema.sql');
  const sql = readFileSync(schemaPath, 'utf8');
  try {
    if (process.env.DB_DRIVER === 'pglite') {
      await execPglite(sql);
    } else {
      await query(sql);
    }
    // eslint-disable-next-line no-console
    console.log('[migrate] schema.sql applied successfully.');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[migrate] Failed to apply schema:', err);
    process.exitCode = 1;
  } finally {
    await endPool();
  }
}

run();
