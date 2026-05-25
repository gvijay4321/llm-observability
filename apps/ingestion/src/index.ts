// Init telemetry first so the meter provider is registered before any module
// that calls getMeter() at import time runs.
import { initTelemetry, registerQueueDepthGauge, shutdownTelemetry } from './telemetry.js';
initTelemetry();

import { sql } from 'kysely';
import { config } from './config.js';
import { closeDb, getDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { getPendingRawEvents } from './db/repository.js';
import { createQueue } from './queue/index.js';
import { buildServer } from './server.js';
import { processEvent } from './worker.js';

// Postgres in compose/k8s sometimes isn't accepting connections yet when we boot.
async function waitForDatabase(): Promise<void> {
  if (config.db.dialect !== 'postgres') return;
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await sql`select 1`.execute(getDb());
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function main(): Promise<void> {
  await waitForDatabase();
  await runMigrations();

  const queue = createQueue();
  await queue.consume(processEvent);
  registerQueueDepthGauge(() => queue.depth());

  // Re-publish anything persisted-but-unprocessed from a previous crash.
  const pending = await getPendingRawEvents();
  if (pending.length > 0) {
    for (const row of pending) await queue.publish({ rawEventId: row.id });
  }

  const app = await buildServer(queue);
  await app.listen({ port: config.port, host: config.host });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
      await queue.close();
      await closeDb();
      await shutdownTelemetry();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch(() => {
  process.exit(1);
});
