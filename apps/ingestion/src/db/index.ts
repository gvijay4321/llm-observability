import SQLite from 'better-sqlite3';
import { Kysely, PostgresDialect, SqliteDialect } from 'kysely';
import pg from 'pg';
import { config } from '../config.js';
import type { Database } from './schema.js';

let instance: Kysely<Database> | null = null;

export function getDb(): Kysely<Database> {
  if (instance) return instance;

  if (config.db.dialect === 'postgres') {
    instance = new Kysely<Database>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({ connectionString: config.db.postgresUrl, max: 10 }),
      }),
    });
  } else {
    const sqlite = new SQLite(config.db.sqliteFile);
    // WAL so the worker's writes don't block API reads.
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    instance = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  }
  return instance;
}

export const isPostgres = (): boolean => config.db.dialect === 'postgres';

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.destroy();
    instance = null;
  }
}
