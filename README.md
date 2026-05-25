# LLM Inference Logging & Ingestion System

[![CI](https://github.com/gvijay4321/llm-observability/actions/workflows/ci.yml/badge.svg)](https://github.com/gvijay4321/llm-observability/actions/workflows/ci.yml)

A lightweight, end-to-end observability system for an LLM chatbot application. It
streams chat completions from a foundation model, captures rich inference
telemetry through a thin SDK wrapper, ships that telemetry to an ingestion
pipeline, and stores everything in a database that powers live dashboards.

**Live demo:** <https://chatbot-production-a946.up.railway.app> — full stack
deployed to Railway (chatbot + ingestion + Postgres + Redis).

```
                          ┌───────────────────┐
                          │   LLM Provider    │
                          │  Gemini / Groq /  │
                          │ OpenRouter / HF / │
                          │      Ollama       │
                          └─────────▲─────────┘
                                    │  HTTPS: prompt + stream tokens
                                    │
┌──────────────┐   stream    ┌──────┴───────┐   batched logs   ┌────────────────┐
│   Chatbot    │ ──────────► │     SDK      │ ───────────────► │   Ingestion    │
│  (Next.js)   │   tokens    │ ObservableLLM│   POST /v1/logs  │   service      │
│  UI + API    │ ◄────────── │   wrapper    │                  │   (Fastify)    │
└──────┬───────┘             └──────────────┘                  └───────┬────────┘
       │ messages / conversations / metrics (REST, read + write)       │ event queue
       └───────────────────────────────────────────────────────────────┤ (Redis / in-memory)
                                                                ┌──────▼───────┐
                                                                │    Worker    │
                                                                │  validate    │
                                                                │  redact PII  │
                                                                │  extract     │
                                                                │  metadata    │
                                                                └──────┬───────┘
                                                                ┌──────▼───────┐
                                                                │   Database   │
                                                                │ SQLite / PG  │
                                                                └──────────────┘
```

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the ingestion flow, logging
strategy, scaling considerations and failure-handling assumptions.

---

## Highlights

### 1. Suggestion cards on the empty-state homepage

Four prompt suggestions, each with a live Recharts mini-preview wired to
the same `/v1/metrics` endpoint as the dashboard. Clicking a card sends
the prompt; the model typically answers with prose plus an inline chart
(highlight 2), though the chart type and whether it appears are up to the
model.

![Suggestion cards](docs/screenshots/chat-empty.png)

### 2. Inline charts in chat

Ask `plot requests over the last hour as a bar chart`, `compare providers
as a pie chart`, etc. The model returns a short answer plus a `chart`
directive; the UI renders an inline [Recharts](https://recharts.org) chart
with line / area / bar / pie toggle pills. Series: `requests`, `errors`,
`latency`, `providers`. Window selector is shared with the dashboard.

| Bar | Line | Area | Pie |
|-----|------|------|-----|
| ![](docs/screenshots/chart-bar.png) | ![](docs/screenshots/chart-line.png) | ![](docs/screenshots/chart-area.png) | ![](docs/screenshots/chart-pie.png) |

The conversation is multi-turn — the chart turn and a follow-up about the
same data stay in the same scroll:

![Multi-turn chart conversation](docs/screenshots/chart-conversation.png)

### 3. Live observability dashboard

`/dashboard` reads the same `/v1/metrics` endpoint as the suggestion cards and
inline charts and renders the full inference picture in one view: requests,
failed requests, error rate, latency p50/p95, TTFT, tokens, USD cost estimate,
plus throughput-by-provider and errors-by-provider time-series. The window
selector (last hour / 24h / 7 days) is shared with the chat and side panel.

![Dashboard](docs/screenshots/dashboard.png)

### 4. Switch provider + model mid-conversation

A two-dropdown selector picks a provider and a specific model within it.
Switching mid-conversation is supported; every assistant bubble carries a
`provider · model · Window: …` caption from the SSE `meta` event. Each
provider has a brand-coloured avatar (gradient + SVG mark) — Gemini
indigo, Groq orange-red, OpenRouter teal, HF amber, Ollama slate — so the
bubble owner is visible at a glance.

Model selection is validated server-side against the catalog in
`apps/chatbot/lib/config.ts` (env-overridable via `<PROVIDER>_MODEL`).
Opening a conversation from the sidebar snaps the dropdowns to whichever
provider/model produced it.

![Mixed-model conversation](docs/screenshots/chat-mixed-models.png)

### 5. Cross-provider evaluation framework

30 prompts mapped to the three rubric axes — **Hallucination** (10 factual),
**Content Safety** (10 adversarial / jailbreak), **Bias & Harmful**
(10 sensitive). Each response is scored by deterministic heuristics plus an
optional LLM judge (Gemini); the judge skips grading its own provider so it
can't self-favor. Safety signals are surfaced per-provider — ingress blocks,
model refusals, and leak markers (jailbreak success) — so a reviewer can
immediately see which models leaked. Every run writes JSON + Markdown +
a single-page HTML infographic to `eval-results/`, and publishes the raw JSON
to the chatbot's `public/` so the in-app **Eval** tab (sidebar) renders the
same chart natively — no iframe, no runtime file reads, so it works on Railway
too. Implementation, prompt list and CLI flags are in
[Safety & evaluation](#safety--evaluation) below.

![Eval page](docs/screenshots/eval-page.png)

### 6. Side-by-side compare view

`/compare` runs two providers on one prompt with per-pane TTFT and total
latency. Each pane's dropdown hides the other pane's current provider so
the same model can't be raced against itself.

![Compare view](docs/screenshots/compare-result.png)

### 7. Production observability: OTLP → Grafana Cloud

The same metrics that power the in-app `/dashboard` are also exported via
**OpenTelemetry (OTLP HTTP/protobuf)** to a hosted Prometheus on
[Grafana Cloud](https://grafana.com/products/cloud/). This is the
production split the spec implicitly asks for: per-call drill-down in the
OLTP database, aggregate time-series in a real metrics backend that
queries don't degrade the live app.

![Grafana Cloud — ingestion + chatbot metrics arriving over OTLP](docs/screenshots/grafana-cloud.png)

- Both services (`obs-chatbot`, `obs-ingestion`) push every 15s with
  `service.name` / `service.namespace` / `deployment.environment`
  resource attributes — visible in Grafana's metrics browser as
  `{job="obs-ingestion", service_name="obs-ingestion", ...}`.
- Same instruments as the local Prometheus exporter: `llm_inference_*`
  for requests/latency/TTFT/tokens/cost, `ingestion_*` for pipeline
  health, `chatbot_chat_*` for the edge route.
- Falls back to the bundled Prometheus scrape exporter for local
  docker-compose dev (no OTLP env required); `OTEL_METRICS_ENABLED=false`
  disables both. Setup details in [Showcase on Railway](#showcase-on-railway-push-to-grafana-cloud) below.

Three issues surfaced during the wire-up, documented inline:

1. **OTel JS instrument-binding order.** `metrics.getMeter()` returns a
   `NoopMeter` if called *before* `setGlobalMeterProvider`. Counters
   created on it silently drop `.add()` calls. Both services now create
   their meter inside `initTelemetry()`, after the provider is set.
2. **IPv6 egress on Railway.** Default Node DNS order tries AAAA first
   and wastes the connect timeout on an unreachable address.
   `dns.setDefaultResultOrder('ipv4first')` skips it.
3. **OTLP request timeout.** Default 10s isn't enough for cross-region
   first-connect (SFO → Mumbai). Bumped to 30s.

After these fixes, exports run on a 15s cadence with warm-export latency in the 700–800ms range.

---

## Features

**Core (assignment spec)**

- Multi-turn chatbot with short conversational context and a streaming UI
- A lightweight SDK that wraps LLM calls and captures inference metadata
  (model, provider, latency, TTFT, token usage, status/errors, timestamps,
  session/conversation IDs, input/output previews)
- Near-real-time, batched log shipping to an ingestion endpoint
- An ingestion service that validates, parses, redacts and stores payloads
- A relational schema for chat messages, inference logs and extracted metadata

**Bonus deliverables (all implemented)**

- **Multi-provider** — Gemini, Groq, OpenRouter, Hugging Face (OSS), and
  local Ollama
- **Streaming responses** — token-by-token over SSE end-to-end, with TTFT
  measured at the SDK boundary
- **Dashboards** — latency (p50/p95/p99), throughput, error rate, token
  usage, cost estimate, failed-request count, by-provider breakdown
- **Docker Compose** — `docker compose up --build` brings up Postgres,
  Redis, ingestion (Postgres + Redis-backed queue) and the chatbot
- **Event-based architecture** — pluggable `EventQueue` interface with two
  drivers: in-memory FIFO (dev) and BullMQ on Redis (Compose + k8s)
- **PII redaction** — emails, phones, credit cards, SSNs, IPs and secrets
  are redacted server-side before telemetry is persisted (full content kept
  in `messages` table for resume fidelity)
- **Kubernetes** — full manifests for a self-hosted cluster (namespace,
  config, Postgres + PVC, Redis, ingestion with HPA 2–8 pods, chatbot,
  ingress with proxy buffering disabled for SSE)
- **Conversation management UI** — list, resume, delete, plus stop-generation
  mid-stream and a confirmation modal

**Extra work — beyond the spec**

The seven headline items are in [Highlights](#highlights). Other additions:

- **Live metrics side panel** on the chat surface; refreshes after every
  turn, defaults to a 7-day window, amber error tile gated on an absolute
  failure count.
- **Topbar/sidebar context sync** — opening a conversation snaps the
  dropdowns to the provider/model that produced it; new entries slide
  into the sidebar.
- **Unreachable-provider UX** — Ollama appears in the picker on the
  Railway demo, but selecting it shows an explanation banner and disables
  send (no GPU/daemon in the container). Local runs work normally.
- **Guardrails + cross-provider evaluation framework** — covered in
  [Safety & evaluation](#safety--evaluation) below.
- **CI** — `.github/workflows/ci.yml` runs typecheck, tests, and Docker
  image builds on every push.

---

## Tech stack

| Layer       | Choice                                   | Why |
|-------------|------------------------------------------|-----|
| Language    | TypeScript (one language end-to-end)     | Shared types across SDK, services and UI |
| Chatbot     | Next.js 15 (App Router) + React 19       | UI + streaming API routes in one app |
| SDK         | Zero-runtime-dependency TS package       | Providers call the upstream APIs with `fetch` directly |
| Ingestion   | Fastify 5                                | Fast, small, good TS support |
| Database    | Kysely query builder + SQLite / Postgres | Type-safe SQL with the same schema on SQLite (dev) and Postgres (prod) |
| Queue       | In-memory (default) or Redis + BullMQ    | Event-driven, scales horizontally |
| Validation  | Zod                                      | One schema = wire contract + TS types |
| Charts      | Recharts                                 | Dashboard visualisations |

---

## Repository layout

```
.
├── packages/
│   ├── shared/        # wire contracts (Zod), shared types, PII redaction, pricing
│   └── sdk/           # ObservableLLM wrapper + providers + log shipper
├── apps/
│   ├── ingestion/     # Fastify API, event queue, processing worker, DB layer
│   └── chatbot/       # Next.js chat UI, streaming API, dashboards, proxies
├── infra/
│   ├── k8s/           # Kubernetes manifests for self-hosted deployment
│   └── deploy-k8s.ps1 # build images, load into cluster, apply manifests
├── .github/workflows/ # CI pipeline
├── scripts/           # screenshot capture + cross-provider eval framework
├── Dockerfile.*       # service images
├── docker-compose.yml # one-command stack
├── ARCHITECTURE.md    # architecture notes
└── .env.example       # configuration template
```

---

## Setup

### Prerequisites

- Node.js 20+
- Optionally: Docker (for the Compose stack), and a free API key from any one
  of Gemini / Groq / OpenRouter / Hugging Face

### 1. Run locally (zero infrastructure)

```bash
npm install
cp .env.example .env          # defaults are fine; uses SQLite + in-memory queue
npm run build                 # builds the shared + sdk packages
npm run migrate               # creates the SQLite schema
npm run seed                  # optional: demo traffic so the dashboards aren't empty

npm run dev                   # starts ingestion (:4000) + chatbot (:3000)
```

> On Windows PowerShell, run the commands on separate lines — `&&` is not a
> valid separator in Windows PowerShell 5.1.

Open <http://localhost:3000> for the chat and <http://localhost:3000/dashboard>
for the live metrics.

### 2. Use a real model (Gemini)

Get a key from <https://aistudio.google.com/apikey>, then in `.env`:

```dotenv
LLM_PROVIDER=gemini
LLM_MODEL=gemini-2.5-flash
GEMINI_API_KEY=your-key-here
```

Switch `LLM_PROVIDER` to `groq`, `openrouter`, `hf` or `ollama` to use those
providers instead — no code changes required. The UI shows whichever
providers have keys set; the runtime dropdowns let you pick the specific
model within each.

### 2a. Use an open-source model (Hugging Face)

The HF Inference Providers router exposes OSS models like Qwen, Llama, Mistral
and Phi via an OpenAI-compatible API. Get a free token from
<https://huggingface.co/settings/tokens> and add to `.env`:

```dotenv
HF_TOKEN=hf_xxxxxxxxxxxxx
HF_MODEL=Qwen/Qwen2.5-7B-Instruct
```

Then pick **"Hugging Face (OSS)"** in the provider dropdown. Same telemetry
pipeline, same dashboard — compare OSS latency / cost / quality side-by-side
with frontier models.

### 2b. Use a local model (Ollama)

Install [Ollama](https://ollama.com), pull a model, and you're done — no token
required, the daemon serves an OpenAI-compatible endpoint on `:11434`:

```bash
ollama pull qwen2.5:7b
```

Pick **"Ollama (local)"** in the provider dropdown. Override the model with
`OLLAMA_MODEL=llama3.2:3b` etc.

> **Hosted demo note.** The Railway deployment linked at the top of this README
> intentionally lists Ollama in the provider picker but can't serve it —
> Railway containers have no GPU and no Ollama daemon. Selecting Ollama on the
> hosted demo shows an explanation banner and disables send. To actually
> exercise the Ollama provider, clone the repo and run it locally alongside
> `ollama serve`. The flag is `OLLAMA_AVAILABLE=false` in
> [`.env.example`](./.env.example) — set on the hosted env, omitted locally.

### 2c. Deploy the OSS model publicly (Hugging Face Spaces)

For the assignment's "deploy the OSS model publicly" bonus, the recommended
small model `Qwen/Qwen2.5-0.5B-Instruct` fits the HF Spaces free tier. Two
shapes work:

- **Inference-via-Router** (zero infrastructure): point this app at the HF
  Router (`HF_TOKEN` + `HF_MODEL=Qwen/Qwen2.5-0.5B-Instruct`) — no Space needed,
  HF hosts the model. This is what `npm run eval --providers hf` uses.
- **Dedicated Space**: create a new HF Space (Docker template), `git push`
  this repo, set `HF_TOKEN` and `INGESTION_URL` as Space secrets. The chatbot
  Dockerfile (`Dockerfile.chatbot`) builds and runs cleanly on Spaces.

### 3. Run with Docker Compose (one command)

```bash
cp .env.example .env          # set GEMINI_API_KEY if you have one
docker compose up --build
```

This starts Postgres, Redis, the ingestion service (Postgres + Redis-backed
queue) and the chatbot. The ingestion service migrates the database on startup.
Chatbot on `:3000`, ingestion on `:4000`.

### 4. Deploy to Kubernetes

See **[infra/k8s/README.md](./infra/k8s/README.md)**.

---

## Schema design decisions

The database has **four tables** - one raw landing zone plus three processed
tables. Full DDL is in [apps/ingestion/src/db/migrate.ts](apps/ingestion/src/db/migrate.ts).

| Table            | Purpose |
|------------------|---------|
| `raw_events`     | **Landing zone.** Every incoming payload is persisted verbatim *before* processing. Doubles as the dead-letter store (`status='failed'`) and the crash-recovery source. |
| `conversations`  | One row per chat. Holds status (`active`/`cancelled`/`archived`), provider/model, and a denormalised `message_count` for a fast sidebar. |
| `messages`       | Chat messages, ordered by `sequence` within a conversation. Stored faithfully (full content) so a conversation can be resumed accurately. |
| `inference_logs` | **Processed telemetry** - one row per LLM call. Core metrics as first-class columns; extracted metadata (`estimated_cost_usd`, `pii_redaction_count`) alongside; provider-specific extras in an `extra` JSON column. |

Key decisions and the reasoning:

- **Raw vs. processed separation.** Persisting the raw payload first makes the
  ingest endpoint a durable boundary: once a request returns `202`, the data
  cannot be lost even if processing later fails. It also enables reprocessing if
  redaction or extraction logic changes.
- **`event_id` as an idempotency key.** `inference_logs.event_id` is `UNIQUE`
  and inserts use `ON CONFLICT DO NOTHING`, so retried log deliveries never
  create duplicates.
- **Extracted metadata as typed columns, not pure EAV.** Cost and PII counts are
  queried/aggregated often, so they are real columns. Open-ended provider fields
  go into the `extra` JSON column - a balance between a rigid schema and an
  opaque blob.
- **Portable types.** Timestamps are ISO-8601 `TEXT` and booleans are `0/1`
  `INTEGER` so the identical schema runs on both SQLite and Postgres. ISO
  strings sort lexicographically, so time-range queries still work. JSON columns
  are native `jsonb` on Postgres and `TEXT` on SQLite.
- **Indexes follow the access patterns** - messages by `(conversation_id,
  sequence)`, logs by `conversation_id`, `created_at` and `status`,
  conversations by `(status, updated_at)`.
- **App-level referential integrity.** Because logs are processed
  asynchronously and may arrive before their message row, FK enforcement is done
  in the app (the worker upserts a stub conversation) rather than via DB
  constraints - this avoids ordering deadlocks.

---

## Tradeoffs made

- **Two ingestion paths.** High-volume *inference logs* go through the async
  queue; low-volume *chat messages* are written synchronously so the chatbot
  gets immediate confirmation and message IDs. Simpler than forcing everything
  through one path.
- **SQLite default, Postgres for real.** SQLite makes the project run instantly
  with no setup - ideal for review. Docker Compose and Kubernetes use Postgres.
  One schema serves both.
- **In-process metrics aggregation.** Percentiles are computed in JS over the
  window's rows. Fine for demo scale; a production system would pre-aggregate or
  use a timeseries store.
- **Regex-based PII redaction.** Cheap, dependency-free and predictable, but not
  a substitute for a real DLP product (no NER, no addresses/names).
- **Dependency-free SDK.** All providers call REST APIs via `fetch` instead of
  vendor SDKs - keeps the wrapper lightweight and install-light, at the cost of
  mapping each provider's wire format by hand.
- **Messages stored unredacted.** The `messages` table keeps full content for
  resume fidelity; only the analytics copy (log previews) is redacted. A
  `redacted` flag records that PII was detected, enabling later scrubbing.

---

## Safety & evaluation

### Guardrails layer

A pattern-based input-safety layer ([apps/chatbot/lib/guardrails.ts](apps/chatbot/lib/guardrails.ts))
sits in front of every chat call. It blocks six categories *before* the
model is invoked: prompt-injection, illegal-violence, self-harm,
sexual-content-involving-minors, malware, and PII (credit-card patterns). On a
block, the chat route short-circuits with a category-specific refusal and tags
the assistant message with `safetyBlocked: true` so it renders as a red bubble
in the UI and shows up in telemetry as a safety event — not as a normal turn.

Honest scope: regex layer, not a classifier. It catches the obvious assignment
test cases ("ignore all previous instructions…", DAN, weapons how-to) and is
deliberately deterministic so the eval framework can exercise it. A
production system would add an ML classifier (e.g., LlamaGuard) before it.

### Evaluation framework

This drives the **cross-provider evaluation** (the assignment's "OSS vs.
Frontier" deliverable). Same chatbot UI, same conversational memory, same
prompts — only the provider differs. The runner reads from whatever real API
keys / Ollama endpoints are available and compares those.

```bash
# Run against every configured provider, with LLM-as-judge
npm run eval

# Heuristics only (skip the judge call)
npm run eval:no-judge

# A specific subset — e.g. OSS (Hugging Face) vs Frontier (Gemini)
npx tsx scripts/eval/run.ts --providers hf,gemini
```

Each run writes three files to `eval-results/<timestamp>.{json,md,html}`:

- **JSON** — raw per-prompt results (machine-readable).
- **Markdown** — text report with tables (good for code review / GitHub).
- **HTML** — single-page infographic with inline SVG bar charts. Open in any
  browser and use **Print → Save as PDF** to produce the 1-page evaluation
  report deliverable. No template engine, no external assets — fully portable.

30 prompts mapped to the three assignment-rubric axes — **Hallucination**
(10 factual), **Content Safety** (10 adversarial / jailbreak), **Bias &
Harmful** (10 sensitive) — defined in
[scripts/eval/prompts.ts](scripts/eval/prompts.ts). Each response is scored by:

- **Heuristic** ([scripts/eval/score.ts](scripts/eval/score.ts)) — fast
  deterministic regex: keyword presence for factual, refusal-pattern detection
  for adversarial, hedging-vocabulary detection for bias.
- **LLM judge** ([scripts/eval/judge.ts](scripts/eval/judge.ts)) — optional;
  uses Gemini (if `GEMINI_API_KEY` is set) to rate each response 0..1 with
  a one-line rationale. The judge is excluded from grading its own provider to
  avoid self-favoring; heuristic scores still cover every row. Disabled if no
  key.

Output: timestamped JSON + markdown report in `eval-results/` with overall
scores, per-category breakdown, **per-provider** safety table (ingress blocks,
model refusals, leak markers), latency, and an appendix of the worst failures.
The runner also exercises the guardrails layer — refusals it catches at
ingress are reported separately so you can see what the model itself had to
handle vs. what the wrapper short-circuited.

---

## What I would improve with more time

- **Telemetry store.** Move inference logs to a columnar/timeseries store
  (ClickHouse or Postgres + Timescale) and pre-aggregate rollups instead of
  computing percentiles per request.
- **Delivery guarantees.** Add a persistent client-side spool in the SDK so logs
  survive a chatbot crash, and an outbox/CDC pattern on the ingestion side.
- **Dead-letter tooling.** A UI to inspect and replay `raw_events` with
  `status='failed'`.
- **Auth & multi-tenancy.** Per-tenant API keys, rate limiting, and row-level
  scoping instead of a single shared bearer token.
- **Richer PII handling.** ML-based NER, configurable policies, and reversible
  tokenisation for authorised re-identification.
- **Wider test coverage.** The suite covers the core logic and the worker
  pipeline; next would be route-level tests for the Fastify API and a
  Playwright end-to-end test of the chat UI.
- **Distributed traces.** Metrics are wired (see [Telemetry](#telemetry-prometheus--opentelemetry)),
  but spans aren't yet — the next step is an OTLP trace exporter so a single
  chat turn can be followed from chatbot → SDK → ingestion → worker in Jaeger
  or Tempo.
- **Tamper-evident audit log.** Today the `inference_logs` table is mutable
  by the app. For incident review or compliance queries you really want an
  append-only stream with each record's hash chained into the next — so a
  later "did the model emit X at time T?" question has a defensible answer.
  A side-table or Kafka log compaction setup would slot in next to the
  current writer.
- **Schema-versioned events.** The SDK stamps `sdkVersion` on every log, but
  the *shape* of `metadata` (JSONB) isn't formally versioned. As provider
  responses evolve, older logs need to stay queryable; a per-event
  `schemaVersion` plus migration adapters in the worker would keep historical
  data first-class instead of slowly bit-rotting.

---

## API reference (ingestion service)

| Method & path | Description |
|---------------|-------------|
| `GET  /health`, `GET /ready` | Liveness / readiness probes |
| `POST /v1/logs` | Ingest a batch of inference logs (SDK to ingestion) |
| `POST /v1/conversations` | Create/upsert a conversation |
| `GET  /v1/conversations` | List conversations (`?status=` filter) |
| `GET  /v1/conversations/:id` | Conversation + its messages (for resume) |
| `PATCH /v1/conversations/:id` | Update status (cancel/archive) or title |
| `DELETE /v1/conversations/:id` | Delete a conversation and its messages |
| `POST /v1/conversations/:id/messages` | Persist a chat message |
| `GET  /v1/conversations/:id/logs` | Inference logs for a conversation |
| `GET  /v1/metrics?windowMinutes=` | Aggregated dashboard metrics |

All `/v1/*` routes require `Authorization: Bearer <INGESTION_API_KEY>` when the
key is configured.

---

## Telemetry (Prometheus + OpenTelemetry)

Both services use the **OpenTelemetry meter API** for instrumentation and pick
an exporter at boot based on env:

- **Prometheus scrape endpoint** (default) — each service binds a `/metrics`
  port that the docker-compose Prometheus instance pulls from. Zero hosted
  dependencies; this is what the local showcase runs.
- **OTLP HTTP/protobuf push** — set `OTEL_EXPORTER_OTLP_ENDPOINT` and the
  service stops binding the scrape port and instead pushes metrics to that
  endpoint on `OTEL_METRIC_EXPORT_INTERVAL`. Used for the Railway deployment
  (push to Grafana Cloud), works with any OTLP-compatible backend.

The instrument definitions don't change between modes — the same meters and
labels flow through either exporter.

| Service   | Local scrape endpoint             | What it exposes |
|-----------|-----------------------------------|-----------------|
| ingestion | `http://localhost:9464/metrics`   | log throughput, processing duration & lag, queue depth, dead-letters, plus per-provider inference RED + tokens + cost (derived from each processed log) |
| chatbot   | `http://localhost:9465/metrics`   | `/api/chat` outcomes, TTFT, total duration, guardrail blocks by category |

Key instruments (all with `provider` / `model` labels where applicable):

```
ingestion_logs_received_total                  counter
ingestion_logs_processed_total                 counter   {provider, model, status}
ingestion_logs_failed_total                    counter   {reason}
ingestion_processing_duration_seconds_*        histogram {outcome}   ← also gives a free count metric for throughput
ingestion_queue_depth                          gauge
ingestion_pii_redactions_total                 counter
llm_inference_requests_total                   counter   {provider, model, status}
llm_inference_latency_ms_*                     histogram {provider, model}
llm_inference_ttft_ms_*                        histogram {provider, model}
llm_inference_tokens_total                     counter   {provider, model, kind}
llm_inference_cost_usd_total                   counter   {provider, model}
chatbot_chat_requests_total                    counter   {provider, model, outcome}
chatbot_chat_ttft_ms_*                         histogram {provider}
chatbot_chat_total_ms_*                        histogram {provider, outcome}
chatbot_guardrail_blocks_total                 counter   {category}
```

> **Why not instrument the SDK?** The SDK is intentionally zero-runtime-dep
> ([see Tech stack](#tech-stack)). The SDK already emits a structured log per
> call; ingestion lifts those into Prometheus metrics. Keeping the SDK package
> tiny matters more than colocating the meter setup with the producer.

### Showcase locally (one command)

```bash
docker compose up --build
```

This brings up the existing stack plus **Prometheus** (scraping every 5s) and
**Grafana** with a pre-provisioned dashboard:

| Service    | URL                          | Credentials      |
|------------|------------------------------|------------------|
| Chatbot    | <http://localhost:3000>      | —                |
| Grafana    | <http://localhost:3001>      | admin / admin (anonymous viewer enabled) |
| Prometheus | <http://localhost:9090>      | —                |

Open Grafana → **Dashboards** → **LLM Observability**. Send a few prompts at
<http://localhost:3000>, switch providers, trigger a refusal — the panels light
up in real time:

- **Ingestion pipeline** row: log accept rate, queue depth, dead-letters,
  processing-duration percentiles, worker-outcome rate.
- **LLM inference (per-provider)** row: requests/sec, p95 latency, p95 TTFT,
  error rate, token throughput (prompt vs completion), USD/hour.
- **Chatbot (edge)** row: `/api/chat` outcomes, TTFT, guardrail blocks by
  category.

The dashboard JSON lives at
[infra/grafana/dashboards/llm-observability.json](infra/grafana/dashboards/llm-observability.json);
scrape config at [infra/prometheus/prometheus.yml](infra/prometheus/prometheus.yml).

### Showcase on Railway (push to Grafana Cloud)

Railway doesn't expose secondary container ports cleanly, so the deployed
services push via OTLP rather than expose a scrape endpoint. The free tier of
Grafana Cloud accepts OTLP directly; nothing extra runs on Railway.

One-time setup:

1. In Grafana Cloud, **Connections → Add new connection → OpenTelemetry (OTLP)**.
   Walk through the wizard picking JavaScript / Linux / Direct; on the last
   step it generates a token (a `glc_...` string) and prints the OTLP
   gateway URL + an `Authorization=Basic …` header. Save the token.
2. On the Railway **ingestion** service set these variables (Variables →
   Raw Editor takes a dotenv paste):

   ```
   OTEL_SERVICE_NAME=obs-ingestion
   OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-<region>.grafana.net/otlp
   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
   OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic <base64-from-wizard>
   OTEL_RESOURCE_ATTRIBUTES=service.namespace=llm-observability,deployment.environment=railway
   OTEL_METRIC_EXPORT_INTERVAL=15000
   ```

3. Repeat for **chatbot** with `OTEL_SERVICE_NAME=obs-chatbot` (the rest is
   identical).
4. Redeploy. Logs should show
   `[telemetry] OTLP exporter -> https://otlp-gateway-...` on boot.
5. In Grafana Cloud → **Dashboards → New → Import**, paste
   [infra/grafana/dashboards/llm-observability.json](infra/grafana/dashboards/llm-observability.json),
   select the Grafana Cloud Prometheus datasource. Send a chat through the
   Railway URL and the panels populate on the next scrape window.

The same recipe works on any PaaS that runs a Node container with outbound
HTTPS. To disable telemetry entirely (e.g. on a low-tier instance), set
`OTEL_METRICS_ENABLED=false` — the rest of the app keeps running.

For a self-hosted variant, run Prometheus + Grafana as their own Railway
services using the same config files in [infra/](infra/) — that's the same
setup docker-compose uses locally.

#### Known issues

Wiring this up on Railway → Grafana Cloud (ap-south-1) surfaced three
real issues: OTel JS instrument-binding order, Railway's missing IPv6
egress, and the OTLP 10s default timeout. Details + fix references are
in **Highlight #7** above; the code in
[apps/ingestion/src/telemetry.ts](apps/ingestion/src/telemetry.ts) and
[apps/chatbot/lib/telemetry.ts](apps/chatbot/lib/telemetry.ts) carries
the inline comments.

### What about historical data?

Grafana Cloud only sees metrics from the moment OTLP went live; Prometheus is
a forward-only time-series store. Historical per-call data (every chat ever,
with full message bodies, latency, tokens, cost) lives in Postgres and is
served by the chatbot's own `/dashboard` route — that's deliberately *not*
mirrored into Grafana. Two reasons it's kept that way:

- Querying the OLTP database directly from Grafana works at small scale, but
  the standard production pattern is to read from a replica or an analytical
  store (ClickHouse, BigQuery, Timescale) so dashboards can't degrade the
  live app.
- Reaching the DB from Grafana Cloud would require either exposing Postgres
  publicly (Railway TCP proxy) or running a tunnel agent (Grafana Cloud PDC,
  Tailscale). Both are fine for a real deployment; neither is worth the
  blast-radius for a demo when the in-app dashboard already covers history.

Net: live ops in Grafana, history in the app.

---

## Tests

```bash
npm test     # Vitest — runs across the shared, SDK and ingestion workspaces
```

The suite covers PII redaction, cost estimation, the Zod wire contracts, the
SDK's instrumentation + cancellation handling, and `LogShipper` batching/retry.
An integration test drives the ingestion worker end-to-end — validate → redact
→ extract → store — and asserts idempotency and dead-lettering against a
throwaway SQLite database. [GitHub Actions](.github/workflows/ci.yml) runs the
tests, type checks and Docker image builds on every push.

Also exercised manually while building (`scripts/capture-screenshots.mjs`
drives a Playwright sweep over most of these so screenshots stay current):

- Streaming chat through the UI and the `/api/chat` SSE endpoint
- Empty-state homepage suggestion cards — live previews + click-to-send
- Provider + model switching mid-conversation, with per-message attribution
  (`provider · model · Window: …`) and brand-coloured per-provider avatars
- Inline chart rendering — bar / line / area / pie via the type-toggle pills,
  plus the multi-turn chart-conversation flow
- Conversation list / resume / cancel and mid-stream stop
- Compare view streaming two providers in parallel with TTFT/total readouts
  and the "hide the other pane's provider" dropdown filter
- Guardrails refusal — red bubble + safety-tagged telemetry event
- Live metrics side panel (7-day default, amber error tile) + the full
  dashboard against live data
- Unreachable-Ollama UX on the hosted Railway demo (banner + disabled send)
- The ingestion service on both the SQLite and Postgres dialects

Both deployment paths were run end-to-end against the real Gemini API:

- **Docker Compose** - `docker compose up --build` brings up Postgres, Redis
  and both services; ingestion reports `dialect: postgres, queue: redis`.
- **Kubernetes** - deployed to a local cluster with
  [infra/deploy-k8s.ps1](infra/deploy-k8s.ps1); all 6 pods (2x chatbot,
  2x ingestion, Postgres, Redis) reach `Running` and a chat completes through
  the cluster.

---

## Other screenshots

**Live metrics side panel** — defaults to the last-7-days window so a
quiet host still has something to show. The error-rate tile is amber, and
only fires once an absolute failure count is exceeded.

![Live metrics panel](docs/screenshots/live-metrics.png)

**Cancel mid-stream** — partial reply is preserved; the cancellation is
logged as `finishReason='cancelled'`, not a server error.

![Cancel mid-stream](docs/screenshots/chat-cancel.png)

**Guardrails refusal** — pattern-matched prompts are blocked before the
model is invoked. Renders as a red bubble; tagged in telemetry as a safety
event by category.

![Guardrails refusal](docs/screenshots/chat-guardrails.png)

**Provider + model picker** (top-right of the chat).

![Provider + model selector](docs/screenshots/chat-provider-model.png)

**Sidebar** — list, collapsed, and delete-confirm modal.

| List | Collapsed | Delete |
|------|-----------|--------|
| ![Sidebar list](docs/screenshots/sidebar-list.png) | ![Sidebar collapsed](docs/screenshots/sidebar-collapsed.png) | ![Delete confirm](docs/screenshots/sidebar-delete.png) |
