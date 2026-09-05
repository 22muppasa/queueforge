import pg from 'pg';
import { schemaSql } from './schema.js';
import { sleep } from './util.js';

const { Pool } = pg;

export type PoolClient = pg.PoolClient;
export type DatabasePool = pg.Pool;

export function createPool(connectionString: string, max: number): DatabasePool {
  const pool = new Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'queueforge',
  });
  pool.on('error', (error) => console.error(JSON.stringify({ level: 'error', event: 'postgres_pool_error', message: error.message })));
  return pool;
}

export async function waitForDatabase(pool: DatabasePool, attempts = 30): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      lastError = error;
      await sleep(Math.min(2_000, attempt * 200));
    }
  }
  throw lastError;
}

export async function migrate(pool: DatabasePool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [0x51554647]);
    await client.query('BEGIN');
    await client.query(schemaSql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [0x51554647]).catch(() => undefined);
    client.release();
  }
}

export async function transaction<T>(pool: DatabasePool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
