import { z } from 'zod';
import {
  inferenceLogSchema,
  tokenUsageSchema,
  chatMessageInputSchema,
  conversationUpsertSchema,
  providerSchema,
  roleSchema,
  inferenceStatusSchema,
  conversationStatusSchema,
} from './schemas.js';

export type Provider = z.infer<typeof providerSchema>;
export type Role = z.infer<typeof roleSchema>;
export type InferenceStatus = z.infer<typeof inferenceStatusSchema>;
export type ConversationStatus = z.infer<typeof conversationStatusSchema>;
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export type InferenceLog = z.infer<typeof inferenceLogSchema>;
export type ChatMessageInput = z.infer<typeof chatMessageInputSchema>;
export type ConversationUpsert = z.infer<typeof conversationUpsertSchema>;

export interface ConversationRecord {
  id: string;
  title: string;
  status: ConversationStatus;
  provider: Provider | null;
  model: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  sequence: number;
  tokenCount: number | null;
  redacted: boolean;
  metricsWindowMinutes: number | null;
  createdAt: string;
}

export interface InferenceLogRecord {
  id: string;
  eventId: string;
  conversationId: string;
  messageId: string | null;
  sessionId: string;
  provider: Provider;
  model: string;
  status: InferenceStatus;
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
  requestTimestamp: string;
  responseTimestamp: string;
  createdAt: string;
}

export interface MetricsSummary {
  windowMinutes: number;
  totalRequests: number;
  failedRequests: number;
  errorRate: number;
  lastActivityAt: string | null;
  throughputPerMin: number;
  latency: { p50: number; p95: number; p99: number; avg: number };
  ttft: { p50: number; p95: number };
  tokens: { prompt: number; completion: number; total: number };
  estimatedCostUsd: number;
  byProvider: Array<{
    provider: string;
    model: string;
    requests: number;
    errorRate: number;
    avgLatencyMs: number;
    costUsd: number;
    lastOutput: string;
    lastAt: string | null;
  }>;
  timeseries: Array<{
    bucket: string;
    requests: number;
    errors: number;
    avgLatencyMs: number;
    p50: number;
    p95: number;
    p99: number;
    costUsd: number;
    byProvider: Array<{ provider: string; requests: number; errors: number }>;
  }>;
}

export const PREVIEW_MAX_LEN = 500;

export function makePreview(text: string, max = PREVIEW_MAX_LEN): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}... (+${text.length - max} chars)`;
}
