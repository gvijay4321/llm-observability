import { Kysely, Migrator, sql, type Migration, type MigrationProvider } from 'kysely';
import { config } from '../config.js';
import { closeDb, getDb } from './index.js';
import type { Database } from './schema.js';

// jsonb on Postgres, TEXT on SQLite.
const JSON_TYPE = config.db.dialect === 'postgres' ? 'jsonb' : 'text';

const migrations: Record<string, Migration> = {
  '001_initial_schema': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .createTable('raw_events')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('event_id', 'text')
        .addColumn('kind', 'text', (c) => c.notNull())
        .addColumn('payload', JSON_TYPE, (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull().defaultTo('pending'))
        .addColumn('error', 'text')
        .addColumn('received_at', 'text', (c) => c.notNull())
        .addColumn('processed_at', 'text')
        .execute();

      await db.schema
        .createTable('conversations')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('title', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
        .addColumn('provider', 'text')
        .addColumn('model', 'text')
        .addColumn('message_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('created_at', 'text', (c) => c.notNull())
        .addColumn('updated_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('messages')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('conversation_id', 'text', (c) => c.notNull())
        .addColumn('role', 'text', (c) => c.notNull())
        .addColumn('content', 'text', (c) => c.notNull())
        .addColumn('sequence', 'integer', (c) => c.notNull())
        .addColumn('token_count', 'integer')
        .addColumn('redacted', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('inference_event_id', 'text')
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createTable('inference_logs')
        .ifNotExists()
        .addColumn('id', 'text', (c) => c.primaryKey())
        .addColumn('event_id', 'text', (c) => c.notNull().unique())
        .addColumn('conversation_id', 'text', (c) => c.notNull())
        .addColumn('message_id', 'text')
        .addColumn('session_id', 'text', (c) => c.notNull())
        .addColumn('provider', 'text', (c) => c.notNull())
        .addColumn('model', 'text', (c) => c.notNull())
        .addColumn('status', 'text', (c) => c.notNull())
        .addColumn('streaming', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('latency_ms', 'integer', (c) => c.notNull())
        .addColumn('ttft_ms', 'integer')
        .addColumn('prompt_tokens', 'integer')
        .addColumn('completion_tokens', 'integer')
        .addColumn('total_tokens', 'integer')
        .addColumn('finish_reason', 'text')
        .addColumn('error_type', 'text')
        .addColumn('error_message', 'text')
        .addColumn('input_preview', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('output_preview', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('estimated_cost_usd', 'real')
        .addColumn('pii_redaction_count', 'integer', (c) => c.notNull().defaultTo(0))
        .addColumn('extra', JSON_TYPE, (c) => c.notNull().defaultTo('{}'))
        .addColumn('request_timestamp', 'text', (c) => c.notNull())
        .addColumn('response_timestamp', 'text', (c) => c.notNull())
        .addColumn('created_at', 'text', (c) => c.notNull())
        .execute();

      await db.schema
        .createIndex('idx_messages_conversation')
        .ifNotExists()
        .on('messages')
        .columns(['conversation_id', 'sequence'])
        .execute();
      await db.schema
        .createIndex('idx_logs_conversation')
        .ifNotExists()
        .on('inference_logs')
        .column('conversation_id')
        .execute();
      // Dashboards filter/sort on time.
      await db.schema
        .createIndex('idx_logs_created_at')
        .ifNotExists()
        .on('inference_logs')
        .column('created_at')
        .execute();
      await db.schema
        .createIndex('idx_logs_status')
        .ifNotExists()
        .on('inference_logs')
        .column('status')
        .execute();
      await db.schema
        .createIndex('idx_conversations_updated')
        .ifNotExists()
        .on('conversations')
        .columns(['status', 'updated_at'])
        .execute();
      await db.schema
        .createIndex('idx_raw_events_status')
        .ifNotExists()
        .on('raw_events')
        .column('status')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      for (const t of ['inference_logs', 'messages', 'conversations', 'raw_events']) {
        await db.schema.dropTable(t).ifExists().execute();
      }
    },
  },
  // Backstop against duplicate turn slots from regressions or races.
  '002_messages_unique_sequence': {
    async up(db: Kysely<unknown>): Promise<void> {
      // Old non-unique index is subsumed.
      await db.schema.dropIndex('idx_messages_conversation').ifExists().execute();
      await db.schema
        .createIndex('idx_messages_conversation_sequence')
        .ifNotExists()
        .unique()
        .on('messages')
        .columns(['conversation_id', 'sequence'])
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.dropIndex('idx_messages_conversation_sequence').ifExists().execute();
      await db.schema
        .createIndex('idx_messages_conversation')
        .ifNotExists()
        .on('messages')
        .columns(['conversation_id', 'sequence'])
        .execute();
    },
  },
  // Window the assistant turn's numbers came from; nullable on user turns.
  '003_messages_metrics_window': {
    async up(db: Kysely<unknown>): Promise<void> {
      await db.schema
        .alterTable('messages')
        .addColumn('metrics_window_minutes', 'integer')
        .execute();
    },
    async down(db: Kysely<unknown>): Promise<void> {
      await db.schema.alterTable('messages').dropColumn('metrics_window_minutes').execute();
    },
  },
};

const provider: MigrationProvider = {
  async getMigrations() {
    return migrations;
  },
};

export async function runMigrations(db: Kysely<Database> = getDb()): Promise<void> {
  // Probe so DSN/auth errors surface early on Postgres.
  if (config.db.dialect === 'postgres') {
    await sql`select 1`.execute(db);
  }
  const migrator = new Migrator({ db, provider });
  const { error } = await migrator.migrateToLatest();
  if (error) throw error;
}

// CLI: npm run migrate
if (process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1])) {
  runMigrations()
    .then(() => process.stdout.write(`[migrate] up to date (${config.db.dialect})\n`))
    .catch((err) => {
      process.stderr.write(`[migrate] error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
