import { config as loadEnv } from 'dotenv';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

loadEnv({ path: [resolve(process.cwd(), '.env'), resolve(repoRoot, '.env')] });

export type Dialect = 'sqlite' | 'postgres';

interface DbConfig {
  dialect: Dialect;
  sqliteFile: string;
  postgresUrl: string;
}

function parseDatabase(url: string): DbConfig {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return { dialect: 'postgres', sqliteFile: '', postgresUrl: url };
  }
  // file:./data/x.sqlite -> absolute path under repoRoot.
  const raw = url.replace(/^file:/, '');
  const sqliteFile = resolve(repoRoot, raw);
  const dir = dirname(sqliteFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return { dialect: 'sqlite', sqliteFile, postgresUrl: '' };
}

const databaseUrl = process.env.DATABASE_URL ?? 'file:./data/observability.sqlite';

export const config = {
  repoRoot,
  port: Number(process.env.INGESTION_PORT ?? 4000),
  host: process.env.INGESTION_HOST ?? '0.0.0.0',
  // Blank disables bearer-auth on write endpoints.
  apiKey: process.env.INGESTION_API_KEY ?? '',
  db: parseDatabase(databaseUrl),
  queue: {
    driver: (process.env.QUEUE_DRIVER ?? 'memory') as 'memory' | 'redis',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  },
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
} as const;

export type AppConfig = typeof config;
