import type {
  ConversationRecord,
  ConversationStatus,
  InferenceLogRecord,
  MessageRecord,
  MetricsSummary,
  Role,
} from '@obs/shared';
import { serverConfig } from './config';

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${serverConfig.ingestionUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(serverConfig.ingestionApiKey ? { authorization: `Bearer ${serverConfig.ingestionApiKey}` } : {}),
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ingestion ${path} -> HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export function createConversation(input: {
  id: string;
  title?: string;
  provider?: string;
  model?: string;
}): Promise<{ conversation: ConversationRecord }> {
  return call('/v1/conversations', { method: 'POST', body: JSON.stringify(input) });
}

export function listConversations(status?: ConversationStatus): Promise<{ conversations: ConversationRecord[] }> {
  const qs = status ? `?status=${status}` : '';
  return call(`/v1/conversations${qs}`);
}

export function getConversation(
  id: string,
): Promise<{ conversation: ConversationRecord; messages: MessageRecord[] }> {
  return call(`/v1/conversations/${encodeURIComponent(id)}`);
}

export function getConversationLogs(id: string): Promise<{ logs: InferenceLogRecord[] }> {
  return call(`/v1/conversations/${encodeURIComponent(id)}/logs`);
}

export function patchConversation(
  id: string,
  patch: { status?: ConversationStatus; title?: string },
): Promise<{ conversation: ConversationRecord }> {
  return call(`/v1/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function postMessage(
  conversationId: string,
  msg: {
    id?: string;
    role: Role;
    content: string;
    // Omit to let the server derive the next slot. Client-claimed sequences
    // desync after aborted retries, see route.ts.
    sequence?: number;
    tokenCount?: number;
    inferenceEventId?: string;
    metricsWindowMinutes?: number;
  },
): Promise<{ message: MessageRecord }> {
  return call(`/v1/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(msg),
  });
}

export function getMetrics(windowMinutes: number): Promise<{ metrics: MetricsSummary }> {
  return call(`/v1/metrics?windowMinutes=${windowMinutes}`);
}
