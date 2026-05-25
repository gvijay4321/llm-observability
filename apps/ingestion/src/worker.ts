import { estimateCostUsd, inferenceLogSchema, redact } from '@obs/shared';
import type { IngestionEvent } from './queue/index.js';
import { ensureConversation, getRawEvent, insertInferenceLog, markRawEvent } from './db/repository.js';
import {
  inferenceCost,
  inferenceLatency,
  inferenceRequests,
  inferenceTokens,
  inferenceTtft,
  logsFailed,
  logsProcessed,
  piiRedactions,
  processingDuration,
} from './telemetry.js';

// Bad payloads dead-letter (status='failed'); infra errors throw so the queue retries.
export async function processEvent(event: IngestionEvent): Promise<void> {
  const start = process.hrtime.bigint();
  let outcome: 'processed' | 'failed' | 'skipped' = 'skipped';
  try {
    outcome = await processInner(event);
  } finally {
    const elapsedSec = Number(process.hrtime.bigint() - start) / 1e9;
    processingDuration.record(elapsedSec, { outcome });
  }
}

async function processInner(event: IngestionEvent): Promise<'processed' | 'failed' | 'skipped'> {
  const raw = await getRawEvent(event.rawEventId);
  if (!raw) return 'skipped';
  if (raw.status === 'processed') return 'skipped';

  let parsed: unknown;
  try {
    parsed = typeof raw.payload === 'string' ? JSON.parse(raw.payload) : raw.payload;
  } catch {
    await markRawEvent(raw.id, 'failed', 'payload is not valid JSON');
    logsFailed.add(1, { reason: 'invalid_json' });
    return 'failed';
  }

  const result = inferenceLogSchema.safeParse(parsed);
  if (!result.success) {
    await markRawEvent(raw.id, 'failed', `schema validation failed: ${result.error.message.slice(0, 500)}`);
    logsFailed.add(1, { reason: 'schema_validation' });
    return 'failed';
  }
  const log = result.data;

  const redactedInput = redact(log.inputPreview);
  const redactedOutput = redact(log.outputPreview);
  const piiCount = redactedInput.count + redactedOutput.count;

  const estimatedCost = estimateCostUsd(log.model, log.usage);

  // Logs can arrive before the conversation row exists.
  await ensureConversation(log.conversationId, log.provider, log.model);

  await insertInferenceLog({
    eventId: log.eventId,
    conversationId: log.conversationId,
    messageId: log.messageId ?? null,
    sessionId: log.sessionId,
    provider: log.provider,
    model: log.model,
    status: log.status,
    streaming: log.streaming,
    latencyMs: log.latencyMs,
    ttftMs: log.ttftMs ?? null,
    promptTokens: log.usage?.promptTokens ?? null,
    completionTokens: log.usage?.completionTokens ?? null,
    totalTokens: log.usage?.totalTokens ?? null,
    finishReason: log.finishReason ?? null,
    errorType: log.error?.type ?? null,
    errorMessage: log.error?.message ?? null,
    inputPreview: redactedInput.text,
    outputPreview: redactedOutput.text,
    estimatedCostUsd: estimatedCost,
    piiRedactionCount: piiCount,
    extra: { ...log.metadata, sdkVersion: log.sdkVersion },
    requestTimestamp: log.requestTimestamp,
    responseTimestamp: log.responseTimestamp,
  });

  await markRawEvent(raw.id, 'processed');

  const labels = { provider: log.provider, model: log.model, status: log.status };
  logsProcessed.add(1, labels);
  inferenceRequests.add(1, labels);
  inferenceLatency.record(log.latencyMs, { provider: log.provider, model: log.model });
  if (log.ttftMs != null) {
    inferenceTtft.record(log.ttftMs, { provider: log.provider, model: log.model });
  }
  if (log.usage?.promptTokens) {
    inferenceTokens.add(log.usage.promptTokens, { provider: log.provider, model: log.model, kind: 'prompt' });
  }
  if (log.usage?.completionTokens) {
    inferenceTokens.add(log.usage.completionTokens, { provider: log.provider, model: log.model, kind: 'completion' });
  }
  if (estimatedCost) {
    inferenceCost.add(estimatedCost, { provider: log.provider, model: log.model });
  }
  if (piiCount) {
    piiRedactions.add(piiCount);
  }

  return 'processed';
}
