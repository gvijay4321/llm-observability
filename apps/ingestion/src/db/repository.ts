import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type {
  ConversationRecord,
  ConversationStatus,
  InferenceLogRecord,
  MessageRecord,
  Provider,
  Role,
} from '@obs/shared';
import { getDb } from './index.js';
import type { ConversationsTable, InferenceLogsTable, MessagesTable } from './schema.js';

const now = (): string => new Date().toISOString();

// Durability boundary: payload lands here before any processing.
export async function insertRawEvent(kind: string, eventId: string | null, payload: unknown): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insertInto('raw_events')
    .values({
      id,
      event_id: eventId,
      kind,
      payload: JSON.stringify(payload),
      status: 'pending',
      error: null,
      received_at: now(),
      processed_at: null,
    })
    .execute();
  return id;
}

export async function getRawEvent(id: string) {
  return getDb().selectFrom('raw_events').selectAll().where('id', '=', id).executeTakeFirst();
}

export async function markRawEvent(id: string, status: 'processed' | 'failed', error?: string): Promise<void> {
  await getDb()
    .updateTable('raw_events')
    .set({ status, error: error ?? null, processed_at: now() })
    .where('id', '=', id)
    .execute();
}

// Crash recovery on boot.
export async function getPendingRawEvents(limit = 500) {
  return getDb()
    .selectFrom('raw_events')
    .selectAll()
    .where('status', '=', 'pending')
    .orderBy('received_at', 'asc')
    .limit(limit)
    .execute();
}

export async function upsertConversation(input: {
  id: string;
  title?: string;
  status?: ConversationStatus;
  provider?: Provider;
  model?: string;
}): Promise<void> {
  const ts = now();
  await getDb()
    .insertInto('conversations')
    .values({
      id: input.id,
      title: input.title ?? 'New conversation',
      status: input.status ?? 'active',
      provider: input.provider ?? null,
      model: input.model ?? null,
      message_count: 0,
      created_at: ts,
      updated_at: ts,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet((eb) => ({
        title: input.title ?? eb.ref('conversations.title'),
        status: input.status ?? eb.ref('conversations.status'),
        provider: input.provider ?? eb.ref('conversations.provider'),
        model: input.model ?? eb.ref('conversations.model'),
        updated_at: ts,
      })),
    )
    .execute();
}

export async function ensureConversation(id: string, provider?: Provider, model?: string): Promise<void> {
  const ts = now();
  await getDb()
    .insertInto('conversations')
    .values({
      id,
      title: 'New conversation',
      status: 'active',
      provider: provider ?? null,
      model: model ?? null,
      message_count: 0,
      created_at: ts,
      updated_at: ts,
    })
    .onConflict((oc) => oc.column('id').doNothing())
    .execute();
}

export async function setConversationStatus(id: string, status: ConversationStatus): Promise<boolean> {
  const res = await getDb()
    .updateTable('conversations')
    .set({ status, updated_at: now() })
    .where('id', '=', id)
    .executeTakeFirst();
  return Number(res.numUpdatedRows) > 0;
}

// Inference logs are kept as audit data.
export async function deleteConversation(id: string): Promise<boolean> {
  return getDb()
    .transaction()
    .execute(async (trx) => {
      await trx.deleteFrom('messages').where('conversation_id', '=', id).execute();
      const res = await trx.deleteFrom('conversations').where('id', '=', id).executeTakeFirst();
      return Number(res.numDeletedRows) > 0;
    });
}

export async function listConversations(opts: {
  status?: ConversationStatus;
  limit: number;
  offset: number;
}): Promise<ConversationRecord[]> {
  let q = getDb().selectFrom('conversations').selectAll();
  if (opts.status) q = q.where('status', '=', opts.status);
  const rows = await q.orderBy('updated_at', 'desc').limit(opts.limit).offset(opts.offset).execute();
  return rows.map(toConversationRecord);
}

export async function getConversation(id: string): Promise<ConversationRecord | null> {
  const row = await getDb().selectFrom('conversations').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? toConversationRecord(row) : null;
}

export async function insertMessage(input: {
  id?: string;
  conversationId: string;
  role: Role;
  content: string;
  // Omit to derive from max(sequence) in the same txn; client history can
  // drift after aborted retries. UNIQUE index in 002 is the backstop.
  sequence?: number;
  tokenCount?: number;
  redacted: boolean;
  inferenceEventId?: string;
  metricsWindowMinutes?: number;
}): Promise<MessageRecord> {
  const id = input.id ?? randomUUID();
  const ts = now();
  const db = getDb();

  // max(sequence)+insert in one txn so concurrent callers can't race onto UNIQUE.
  return db.transaction().execute(async (trx) => {
    let sequence = input.sequence;
    if (sequence === undefined) {
      const row = await trx
        .selectFrom('messages')
        .select((eb) => eb.fn.max<number>('sequence').as('max_seq'))
        .where('conversation_id', '=', input.conversationId)
        .executeTakeFirst();
      const maxSeq = row?.max_seq ?? null;
      sequence = (maxSeq ?? -1) + 1;
    }

    const insertRes = await trx
      .insertInto('messages')
      .values({
        id,
        conversation_id: input.conversationId,
        role: input.role,
        content: input.content,
        sequence,
        token_count: input.tokenCount ?? null,
        redacted: input.redacted ? 1 : 0,
        inference_event_id: input.inferenceEventId ?? null,
        metrics_window_minutes: input.metricsWindowMinutes ?? null,
        created_at: ts,
      })
      .onConflict((oc) => oc.column('id').doNothing())
      .executeTakeFirst();

    // Only bump message_count when the row actually landed; retries with the
    // same id must not double-count.
    if (Number(insertRes.numInsertedOrUpdatedRows ?? 0) > 0) {
      await trx
        .updateTable('conversations')
        .set({ message_count: sql<number>`message_count + 1`, updated_at: ts })
        .where('id', '=', input.conversationId)
        .execute();
    }

    return {
      id,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      sequence,
      tokenCount: input.tokenCount ?? null,
      redacted: input.redacted,
      metricsWindowMinutes: input.metricsWindowMinutes ?? null,
      createdAt: ts,
    };
  });
}

export async function getMessages(conversationId: string): Promise<MessageRecord[]> {
  const rows = await getDb()
    .selectFrom('messages')
    .selectAll()
    .where('conversation_id', '=', conversationId)
    .orderBy('sequence', 'asc')
    .execute();
  return rows.map(toMessageRecord);
}

export interface InferenceLogInsert {
  eventId: string;
  conversationId: string;
  messageId: string | null;
  sessionId: string;
  provider: string;
  model: string;
  status: string;
  streaming: boolean;
  latencyMs: number;
  ttftMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  finishReason: string | null;
  errorType: string | null;
  errorMessage: string | null;
  inputPreview: string;
  outputPreview: string;
  estimatedCostUsd: number | null;
  piiRedactionCount: number;
  extra: Record<string, unknown>;
  requestTimestamp: string;
  responseTimestamp: string;
}

// Idempotent on event_id.
export async function insertInferenceLog(log: InferenceLogInsert): Promise<void> {
  await getDb()
    .insertInto('inference_logs')
    .values({
      id: randomUUID(),
      event_id: log.eventId,
      conversation_id: log.conversationId,
      message_id: log.messageId,
      session_id: log.sessionId,
      provider: log.provider,
      model: log.model,
      status: log.status,
      streaming: log.streaming ? 1 : 0,
      latency_ms: Math.round(log.latencyMs),
      ttft_ms: log.ttftMs === null ? null : Math.round(log.ttftMs),
      prompt_tokens: log.promptTokens,
      completion_tokens: log.completionTokens,
      total_tokens: log.totalTokens,
      finish_reason: log.finishReason,
      error_type: log.errorType,
      error_message: log.errorMessage,
      input_preview: log.inputPreview,
      output_preview: log.outputPreview,
      estimated_cost_usd: log.estimatedCostUsd,
      pii_redaction_count: log.piiRedactionCount,
      extra: JSON.stringify(log.extra ?? {}),
      request_timestamp: log.requestTimestamp,
      response_timestamp: log.responseTimestamp,
      created_at: now(),
    })
    .onConflict((oc) => oc.column('event_id').doNothing())
    .execute();
}

export async function getLogsForConversation(conversationId: string): Promise<InferenceLogRecord[]> {
  const rows = await getDb()
    .selectFrom('inference_logs')
    .selectAll()
    .where('conversation_id', '=', conversationId)
    .orderBy('created_at', 'asc')
    .execute();
  return rows.map(toInferenceLogRecord);
}

export async function getLogsSince(sinceIso: string) {
  return getDb()
    .selectFrom('inference_logs')
    .select([
      'provider',
      'model',
      'status',
      'latency_ms',
      'ttft_ms',
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'estimated_cost_usd',
      'output_preview',
      'created_at',
    ])
    .where('created_at', '>=', sinceIso)
    .orderBy('created_at', 'asc')
    .execute();
}

function toConversationRecord(r: ConversationsTable): ConversationRecord {
  return {
    id: r.id,
    title: r.title,
    status: r.status as ConversationStatus,
    provider: r.provider as Provider | null,
    model: r.model,
    messageCount: r.message_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toMessageRecord(r: MessagesTable): MessageRecord {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role as Role,
    content: r.content,
    sequence: r.sequence,
    tokenCount: r.token_count,
    redacted: r.redacted === 1,
    metricsWindowMinutes: r.metrics_window_minutes,
    createdAt: r.created_at,
  };
}

function toInferenceLogRecord(r: InferenceLogsTable): InferenceLogRecord {
  return {
    id: r.id,
    eventId: r.event_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    sessionId: r.session_id,
    provider: r.provider as Provider,
    model: r.model,
    status: r.status as InferenceLogRecord['status'],
    streaming: r.streaming === 1,
    latencyMs: r.latency_ms,
    ttftMs: r.ttft_ms,
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    totalTokens: r.total_tokens,
    finishReason: r.finish_reason,
    errorType: r.error_type,
    errorMessage: r.error_message,
    inputPreview: r.input_preview,
    outputPreview: r.output_preview,
    estimatedCostUsd: r.estimated_cost_usd,
    piiRedactionCount: r.pii_redaction_count,
    requestTimestamp: r.request_timestamp,
    responseTimestamp: r.response_timestamp,
    createdAt: r.created_at,
  };
}
