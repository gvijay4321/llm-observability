// ISO-8601 TEXT + 0/1 INTEGER for SQLite/Postgres portability.
// No FKs: logs can arrive before their message row, so the worker upserts a stub conversation.

export interface RawEventsTable {
  id: string;
  event_id: string | null;
  kind: string;
  payload: string;
  status: string;
  error: string | null;
  received_at: string;
  processed_at: string | null;
}

export interface ConversationsTable {
  id: string;
  title: string;
  status: string;
  provider: string | null;
  model: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface MessagesTable {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  sequence: number;
  token_count: number | null;
  redacted: number;
  inference_event_id: string | null;
  metrics_window_minutes: number | null;
  created_at: string;
}

export interface InferenceLogsTable {
  id: string;
  event_id: string;
  conversation_id: string;
  message_id: string | null;
  session_id: string;
  provider: string;
  model: string;
  status: string;
  streaming: number;
  latency_ms: number;
  ttft_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  finish_reason: string | null;
  error_type: string | null;
  error_message: string | null;
  input_preview: string;
  output_preview: string;
  estimated_cost_usd: number | null;
  pii_redaction_count: number;
  extra: string;
  request_timestamp: string;
  response_timestamp: string;
  created_at: string;
}

export interface Database {
  raw_events: RawEventsTable;
  conversations: ConversationsTable;
  messages: MessagesTable;
  inference_logs: InferenceLogsTable;
}
