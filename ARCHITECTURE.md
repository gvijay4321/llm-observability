# Architecture Notes

This document covers the ingestion flow, logging strategy, scaling
considerations and failure-handling assumptions of the system.

---

## 1. Components

| Component | Responsibility |
|-----------|----------------|
| **Chatbot** (`apps/chatbot`) | Next.js app - chat UI, streaming `/api/chat`, dashboards, and thin proxy routes to the ingestion API. Owns the conversation experience. |
| **SDK** (`packages/sdk`) | `ObservableLLM` wraps any provider, measures every call, and ships inference logs. Providers (`gemini`, `groq`, `openrouter`, `hf`, `ollama`) implement one small interface. |
| **Ingestion service** (`apps/ingestion`) | Fastify API that accepts logs and messages, an event queue, a processing worker, and the database layer. Owns all storage. |
| **Shared** (`packages/shared`) | Zod wire contracts, shared TypeScript types, PII redaction, cost estimation. The single source of truth for the data model. |

The chatbot never touches the database directly — it goes through the ingestion service so storage ownership stays in one place.

---

## 2. Ingestion flow

There are two write paths, chosen by volume and latency needs.

### 2a. Inference logs - asynchronous (the hot path)

```
SDK                  Ingestion API            Queue            Worker              DB
 │  buffer N logs        │                       │                │                 │
 │──POST /v1/logs───────►│                       │                │                 │
 │                       │ 1. validate envelope  │                │                 │
 │                       │ 2. INSERT raw_events  │                │                 │
 │                       │    (status=pending) ──┼── persisted ───┼─────────────────►│
 │                       │ 3. publish(rawId) ───►│                │                 │
 │◄────── 202 Accepted ──│                       │── deliver ────►│                 │
 │                       │                       │                │ 4. load raw     │
 │                       │                       │                │ 5. Zod validate │
 │                       │                       │                │ 6. redact PII   │
 │                       │                       │                │ 7. extract meta │
 │                       │                       │                │ 8. INSERT log ─►│
 │                       │                       │                │ 9. mark processed
```

The endpoint does the **minimum** synchronously - an envelope check, a durable
write to `raw_events`, and a queue publish - then returns `202`. All expensive
work (full schema validation, PII redaction, metadata extraction, the final
insert) happens in the worker, off the request path.

Why persist to `raw_events` *before* publishing: it means the `202` actually
guarantees durability. Even if the queue, the worker, or the whole process dies
immediately after, the payload is on disk and will be reprocessed.

### 2b. Chat messages - synchronous (the warm path)

Messages are written directly by `POST /v1/conversations/:id/messages`. They
are low-volume (one or two per turn) and the chatbot needs an immediate result
(the message ID, confirmation) to keep the UI consistent and to support resume.
Routing them through the async queue would add latency for no benefit.

### 2c. Event-based architecture

The queue between the API and the worker is an interface (`EventQueue`) with
two interchangeable drivers:

- **`memory`** - in-process, bounded-concurrency FIFO. Zero infrastructure;
  the default for local development.
- **`redis`** - BullMQ on Redis. Durable, supports many competing consumers,
  and provides retries with exponential backoff. Used by Docker Compose and
  Kubernetes.

Because the API only *publishes* and the worker only *consumes*, the two scale
independently and a slow database never slows down the ingest endpoint.

---

## 3. Logging strategy

**What is captured.** For every LLM call the SDK records: provider, model,
streaming flag, status, error type/message, end-to-end latency, time-to-first-
token (streaming), prompt/completion/total tokens, finish reason, request and
response timestamps, session and conversation IDs, and truncated input/output
previews. The ingestion worker then derives `estimated_cost_usd` and
`pii_redaction_count`.

**Instrumentation point.** Logging lives in the SDK wrapper, around the
provider call - not inside each provider and not in the chatbot. One
implementation instruments every provider uniformly, and application code stays
clean.

**Logging should not break the product.** A few choices follow from that:

- `enqueue()` is fire-and-forget; it never blocks the LLM response.
- The shipper batches (this app: 5 logs / 1.5 s; SDK default: 10 / 2 s) to amortise HTTP overhead.
- Shipping failures are caught, logged and dropped after retries - they never
  surface to the caller.
- A cancelled or failed LLM call is still logged (with `status='error'` or
  `finishReason='cancelled'`), so failures are observable, not invisible.

**Previews, not payloads.** Only the first ~500 characters of input/output are
logged, and they are PII-redacted before storage. Full prompts/responses are
never sent to the telemetry pipeline - that keeps log volume bounded and limits
sensitive-data exposure.

**Cancellation semantics.** A cancellation that produced partial output is
recorded as `success` with `finishReason='cancelled'` - it is a normal user
action, not a server error, and conflating the two would inflate error-rate
dashboards. A cancellation before any output is recorded as an error.

---

## 4. Scaling considerations

| Concern | Approach |
|---------|----------|
| **Ingest throughput** | The endpoint does one indexed insert + one queue publish. It is stateless - run N replicas behind a load balancer (HPA: 2-8 pods in `infra/k8s`). |
| **Processing throughput** | Switch the queue to Redis and run multiple workers as competing consumers; BullMQ distributes jobs. Worker concurrency is also tunable per process. |
| **Database writes** | Logs are the write-heavy table. At scale: batch inserts in the worker, move to a columnar/timeseries store (ClickHouse, Timescale), and partition `inference_logs` by time. |
| **Dashboard reads** | Percentiles are currently computed in-process over the window. The scale path is pre-aggregated rollup tables (per-minute buckets) or a timeseries DB, so dashboard cost is independent of traffic. |
| **Chatbot** | Stateless (session lives in the browser, conversation state in the DB) - scale horizontally. SSE streaming requires proxy buffering to be disabled (done in the k8s ingress). |
| **Back-pressure** | The Redis queue absorbs spikes; the API stays fast while the worker drains at its own rate. Queue depth is the natural autoscaling signal. |

---

## 5. Failure-handling assumptions

| Failure | Behaviour |
|---------|-----------|
| **Ingestion service is down/slow** | The SDK retries with exponential backoff (default 3 attempts), then drops the batch with a warning. The chat reply is unaffected. |
| **Bad payload (poison message)** | The worker dead-letters it: `raw_events.status='failed'` with the error stored. One bad record never blocks the pipeline. |
| **Infrastructure error during processing** (DB down) | The worker throws; the Redis driver retries the job with backoff. With the memory driver the raw event stays `pending`. |
| **Duplicate / retried delivery** | Idempotent. `inference_logs.event_id` is unique; the worker also skips already-`processed` raw events. |
| **Process crash mid-processing** | On startup the service re-scans `raw_events` for `pending` rows and re-publishes them - at-least-once processing, made safe by idempotency. |
| **Log arrives before its message row** | The worker calls `ensureConversation` to create the row if missing, so the log is never orphaned; the message row fills in later. |
| **Client disconnects mid-stream** | The request's `AbortSignal` propagates to the provider; partial output is saved and a cancellation log is emitted. |
| **No API key configured** | The provider picker only lists providers with keys set (plus Ollama, which is always shown). With no keys at all and no Ollama daemon, the chat surface shows the picker disabled — the SDK and ingestion pipeline still run. |

**Delivery guarantee:** at-least-once, made effectively exactly-once for stored
rows by the `event_id` idempotency key. The known gap is the SDK's in-memory
buffer - logs queued but not yet shipped are lost if the chatbot process dies.
The fix (a persistent client-side spool) is listed under "what I would improve".

---

## 6. Data model summary

```
conversations 1───* messages
      │                  │
      │ 1                │ (soft link via inference_event_id)
      *                  *
inference_logs ◄──────────┘        raw_events  (landing zone / dead-letter)
```

- `raw_events` - immutable landing zone; the durability boundary and DLQ.
- `conversations` - chat metadata + status + denormalised `message_count`.
- `messages` - full conversation content, ordered by `sequence`.
- `inference_logs` - processed telemetry; core metrics as columns, extracted
  metadata alongside, provider extras in JSON.

Rationale for each column type, index and the raw-vs-processed split is in the
**Schema design decisions** section of the [README](./README.md).

---

## 7. Self-telemetry

The ingestion service and chatbot are instrumented with the OpenTelemetry
meter API ([`@opentelemetry/sdk-metrics`](https://www.npmjs.com/package/@opentelemetry/sdk-metrics)).
Two exporters ship; one is selected at boot from env:

- **Prometheus scrape** ([`@opentelemetry/exporter-prometheus`](https://www.npmjs.com/package/@opentelemetry/exporter-prometheus))
  binds `/metrics` on a separate port per service (`9464` ingestion, `9465`
  chatbot). Default for local dev and Kubernetes.
- **OTLP HTTP/protobuf push** ([`@opentelemetry/exporter-metrics-otlp-proto`](https://www.npmjs.com/package/@opentelemetry/exporter-metrics-otlp-proto))
  pushes to whatever `OTEL_EXPORTER_OTLP_ENDPOINT` points at, on
  `OTEL_METRIC_EXPORT_INTERVAL`. Used on Railway because secondary container
  ports aren't routable there; works with any OTLP backend.

The instruments themselves answer operational questions the inference-logs
table can't: how deep is the queue, are events dead-lettering, how long the
worker takes per event, how many guardrail refusals fired in the last hour.
The inference-logs table is per-call event data; these are per-service
gauges and rates.

The SDK package is deliberately not instrumented with OTel — its zero-
runtime-dependency contract takes precedence. The per-call numbers that
matter (latency, TTFT, tokens, cost) are already emitted as inference logs;
the worker lifts those into counters and histograms in the same step that
writes them to Postgres. Result: per-LLM-call metrics reach the dashboard
without pulling the OTel SDK into the chatbot bundle.

See the **Telemetry** section of the [README](./README.md) for the metric
catalog and showcase steps.
