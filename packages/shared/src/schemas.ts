import { z } from 'zod';

// Wire contracts shared by SDK, chatbot, and ingestion. Types inferred in ./types.ts.

export const PROVIDERS = ['gemini', 'groq', 'openrouter', 'hf', 'ollama'] as const;
export const providerSchema = z.enum(PROVIDERS);

export const roleSchema = z.enum(['user', 'assistant', 'system']);
export const inferenceStatusSchema = z.enum(['success', 'error']);
export const conversationStatusSchema = z.enum(['active', 'cancelled', 'archived']);

export const tokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

// One per LLM call, success or failure.
export const inferenceLogSchema = z.object({
  // Idempotency key.
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  conversationId: z.string().min(1),
  messageId: z.string().min(1).optional(),
  provider: providerSchema,
  model: z.string().min(1),
  status: inferenceStatusSchema,
  streaming: z.boolean().default(false),
  latencyMs: z.number().nonnegative(),
  ttftMs: z.number().nonnegative().optional(),
  usage: tokenUsageSchema.optional(),
  finishReason: z.string().optional(),
  // Previews only; never the full prompt/response.
  inputPreview: z.string().default(''),
  outputPreview: z.string().default(''),
  error: z
    .object({
      type: z.string(),
      message: z.string(),
    })
    .optional(),
  requestTimestamp: z.string().datetime(),
  responseTimestamp: z.string().datetime(),
  sdkVersion: z.string().default('unknown'),
  metadata: z.record(z.unknown()).default({}),
});

export const inferenceLogBatchSchema = z.object({
  logs: z.array(inferenceLogSchema).min(1).max(100),
});

export const chatMessageInputSchema = z.object({
  id: z.string().min(1).optional(),
  conversationId: z.string().min(1),
  role: roleSchema,
  content: z.string(),
  // Omit to derive server-side from max(sequence).
  sequence: z.number().int().nonnegative().optional(),
  tokenCount: z.number().int().nonnegative().optional(),
  inferenceEventId: z.string().min(1).optional(),
  metricsWindowMinutes: z.number().int().positive().max(60 * 24 * 365).optional(),
});

export const conversationUpsertSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(200).optional(),
  status: conversationStatusSchema.optional(),
  provider: providerSchema.optional(),
  model: z.string().optional(),
});

export type InferenceLogInput = z.input<typeof inferenceLogSchema>;
