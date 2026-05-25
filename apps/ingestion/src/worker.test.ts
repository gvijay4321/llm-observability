import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { getLogsForConversation, getRawEvent, insertRawEvent } from './db/repository.js';
import { computeMetrics } from './metrics.js';
import { processEvent } from './worker.js';

// End-to-end against the throwaway SQLite DB from vitest.config.ts.

let counter = 0;
const uniqueId = (prefix: string) => `${prefix}-${Date.now()}-${counter++}`;

function logPayload(overrides: Record<string, unknown> = {}) {
  return {
    eventId: uniqueId('evt'),
    sessionId: 'sess-it',
    conversationId: uniqueId('conv'),
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    status: 'success',
    streaming: true,
    latencyMs: 250,
    ttftMs: 90,
    usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    inputPreview: 'my email is leak@example.com please help',
    outputPreview: 'sure, happy to help',
    requestTimestamp: new Date().toISOString(),
    responseTimestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  await runMigrations();
});

afterAll(async () => {
  await closeDb();
});

describe('ingestion worker', () => {
  it('validates, redacts PII, extracts metadata and stores the log', async () => {
    const conversationId = uniqueId('conv');
    const payload = logPayload({ conversationId });
    const rawId = await insertRawEvent('inference_log', payload.eventId, payload);

    await processEvent({ rawEventId: rawId });

    const logs = await getLogsForConversation(conversationId);
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.status).toBe('success');
    expect(log.inputPreview).toContain('[REDACTED_EMAIL]');
    expect(log.inputPreview).not.toContain('leak@example.com');
    expect(log.piiRedactionCount).toBeGreaterThan(0);
    expect(log.estimatedCostUsd).toBeGreaterThan(0);
    expect(log.totalTokens).toBe(150);

    const raw = await getRawEvent(rawId);
    expect(raw?.status).toBe('processed');
  });

  it('is idempotent: a duplicate eventId never creates a second row', async () => {
    const conversationId = uniqueId('conv');
    const eventId = uniqueId('evt');
    const first = await insertRawEvent('inference_log', eventId, logPayload({ conversationId, eventId }));
    const second = await insertRawEvent('inference_log', eventId, logPayload({ conversationId, eventId }));

    await processEvent({ rawEventId: first });
    await processEvent({ rawEventId: second });

    const logs = await getLogsForConversation(conversationId);
    expect(logs).toHaveLength(1);
  });

  it('dead-letters an invalid payload instead of throwing', async () => {
    const rawId = await insertRawEvent('inference_log', 'bad-evt', { eventId: 'bad-evt', garbage: true });

    await expect(processEvent({ rawEventId: rawId })).resolves.toBeUndefined();

    const raw = await getRawEvent(rawId);
    expect(raw?.status).toBe('failed');
    expect(raw?.error).toBeTruthy();
  });

  it('surfaces processed logs in the metrics aggregation', async () => {
    const metrics = await computeMetrics(60);
    expect(metrics.totalRequests).toBeGreaterThanOrEqual(2);
    expect(metrics.latency.p50).toBeGreaterThanOrEqual(0);
    expect(metrics.byProvider.some((p) => p.provider === 'gemini')).toBe(true);
  });
});
