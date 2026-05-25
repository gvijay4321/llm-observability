import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  chatMessageInputSchema,
  containsPii,
  conversationStatusSchema,
  conversationUpsertSchema,
} from '@obs/shared';
import { config } from './config.js';
import { computeMetrics } from './metrics.js';
import type { EventQueue } from './queue/index.js';
import { logsReceived } from './telemetry.js';
import {
  deleteConversation,
  getConversation,
  getLogsForConversation,
  getMessages,
  insertMessage,
  insertRawEvent,
  listConversations,
  setConversationStatus,
  upsertConversation,
} from './db/repository.js';

// Per-log validation runs in the worker.
const logBatchEnvelope = z.object({
  logs: z.array(z.object({ eventId: z.string().min(1) }).passthrough()).min(1).max(100),
});

export function registerRoutes(app: FastifyInstance, queue: EventQueue): void {
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async () => ({ status: 'ready', dialect: config.db.dialect, queue: config.queue.driver }));

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/') || !config.apiKey) return;
    const header = req.headers.authorization ?? '';
    if (header !== `Bearer ${config.apiKey}`) {
      // Must return the reply so Fastify halts the lifecycle.
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // Accept fast: write raw_events, publish, return 202. Worker does the rest.
  app.post('/v1/logs', async (req, reply) => {
    const parsed = logBatchEnvelope.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_batch', detail: parsed.error.issues });
    }
    const rawIds = await Promise.all(
      parsed.data.logs.map((log) => insertRawEvent('inference_log', log.eventId, log)),
    );
    await Promise.all(rawIds.map((rawEventId) => queue.publish({ rawEventId })));
    logsReceived.add(rawIds.length);
    return reply.code(202).send({ accepted: rawIds.length });
  });

  app.post('/v1/conversations', async (req, reply) => {
    const parsed = conversationUpsertSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_conversation', detail: parsed.error.issues });
    }
    await upsertConversation(parsed.data);
    const conversation = await getConversation(parsed.data.id);
    return reply.code(201).send({ conversation });
  });

  app.get('/v1/conversations', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const status = conversationStatusSchema.safeParse(q.status);
    const limit = clamp(Number(q.limit ?? 50), 1, 200);
    const offset = Math.max(0, Number(q.offset ?? 0));
    const conversations = await listConversations({
      status: status.success ? status.data : undefined,
      limit,
      offset,
    });
    return reply.send({ conversations });
  });

  app.get('/v1/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const conversation = await getConversation(id);
    if (!conversation) return reply.code(404).send({ error: 'not_found' });
    const messages = await getMessages(id);
    return reply.send({ conversation, messages });
  });

  app.patch('/v1/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { status?: string; title?: string };
    const conversation = await getConversation(id);
    if (!conversation) return reply.code(404).send({ error: 'not_found' });

    if (body.status) {
      const status = conversationStatusSchema.safeParse(body.status);
      if (!status.success) return reply.code(400).send({ error: 'invalid_status' });
      await setConversationStatus(id, status.data);
    }
    if (body.title) {
      await upsertConversation({ id, title: body.title });
    }
    return reply.send({ conversation: await getConversation(id) });
  });

  app.delete('/v1/conversations/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const deleted = await deleteConversation(id);
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ deleted: true });
  });

  app.get('/v1/conversations/:id/logs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const logs = await getLogsForConversation(id);
    return reply.send({ logs });
  });

  app.post('/v1/conversations/:id/messages', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = chatMessageInputSchema.safeParse({ ...(req.body as object), conversationId: id });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_message', detail: parsed.error.issues });
    }
    const msg = parsed.data;
    await upsertConversation({ id });
    const record = await insertMessage({
      id: msg.id,
      conversationId: id,
      role: msg.role,
      content: msg.content,
      sequence: msg.sequence,
      tokenCount: msg.tokenCount,
      // Content stays verbatim for resume; the flag records detection only.
      redacted: containsPii(msg.content),
      inferenceEventId: msg.inferenceEventId,
      metricsWindowMinutes: msg.metricsWindowMinutes,
    });
    return reply.code(201).send({ message: record });
  });

  app.get('/v1/metrics', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const windowMinutes = clamp(Number(q.windowMinutes ?? 60), 1, 60 * 24 * 365);
    const metrics = await computeMetrics(windowMinutes);
    return reply.send({ metrics });
  });
}

function clamp(n: number, min: number, max: number): number {
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
