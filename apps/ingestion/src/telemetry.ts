import { setDefaultResultOrder } from 'node:dns';
import {
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  metrics,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableResult,
} from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

// OTel meter API + a pluggable exporter:
//   - OTLP HTTP/protobuf if OTEL_EXPORTER_OTLP_ENDPOINT is set (Grafana Cloud,
//     Honeycomb, Datadog OTLP, etc. — push model, no exposed scrape port)
//   - Prometheus exporter otherwise (local dev / docker-compose — pull model)
// Set OTEL_METRICS_ENABLED=false to disable telemetry entirely (e.g. for
// tests that don't want to bind a port).

const ENABLED = (process.env.OTEL_METRICS_ENABLED ?? 'true').toLowerCase() !== 'false';
const PORT = Number(process.env.PROMETHEUS_PORT ?? 9464);
const HOST = process.env.PROMETHEUS_HOST ?? '0.0.0.0';
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
const OTLP_EXPORT_INTERVAL_MS = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 30_000);

// OTel JS reads OTEL_EXPORTER_OTLP_HEADERS by splitting each pair on `=`. Our
// Grafana Cloud header value is `Authorization=Basic <base64-ending-in-==>`,
// and the SDK's split would mangle the trailing `==` padding. Parse it here
// (split on the FIRST `=` only) and pass it via the constructor instead.
function parseOtlpHeaders(): Record<string, string> {
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

// Latency buckets (ms) sized for LLM inference: 100ms .. 60s.
const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 60000];
// Processing-time buckets (seconds) for the worker pipeline: 1ms .. 5s.
const PROCESSING_BUCKETS_SEC = [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

let provider: MeterProvider | null = null;
let meter: Meter | null = null;

// Bound to the noop global meter at import time so consumers (and tests that
// never call initTelemetry) can call .add()/.record() without a TypeError.
// initTelemetry reassigns each `let` after setGlobalMeterProvider so importers
// see the real, provider-bound instruments via ES-module live bindings.
const bootstrapMeter = metrics.getMeter('obs-ingestion', '1.0.0');
export let logsReceived: Counter = bootstrapMeter.createCounter('ingestion_logs_received_total');
export let logsProcessed: Counter = bootstrapMeter.createCounter('ingestion_logs_processed_total');
export let logsFailed: Counter = bootstrapMeter.createCounter('ingestion_logs_failed_total');
export let processingDuration: Histogram = bootstrapMeter.createHistogram('ingestion_processing_duration_seconds');
export let inferenceRequests: Counter = bootstrapMeter.createCounter('llm_inference_requests_total');
export let inferenceLatency: Histogram = bootstrapMeter.createHistogram('llm_inference_latency_ms');
export let inferenceTtft: Histogram = bootstrapMeter.createHistogram('llm_inference_ttft_ms');
export let inferenceTokens: Counter = bootstrapMeter.createCounter('llm_inference_tokens_total');
export let inferenceCost: Counter = bootstrapMeter.createCounter('llm_inference_cost_usd_total');
export let piiRedactions: Counter = bootstrapMeter.createCounter('ingestion_pii_redactions_total');

export function initTelemetry(): void {
  if (!ENABLED || provider) return;

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  // Railway's egress doesn't have IPv6 connectivity; Node's default DNS
  // result order ('verbatim') yields IPv6 first when the host has AAAA
  // records, which fails with ENETUNREACH and slows every export. Force
  // IPv4 so the exporter goes straight to the working A record.
  setDefaultResultOrder('ipv4first');

  const useOtlp = !!OTLP_ENDPOINT;
  const headers = parseOtlpHeaders();
  const readers = useOtlp
    ? [new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: ensureMetricsPath(OTLP_ENDPOINT!),
          headers,
          // 10s default isn't enough for cross-region first-connect (SFO →
          // Grafana Cloud ap-south-1) when TLS handshake is added in.
          timeoutMillis: 30_000,
        }),
        exportIntervalMillis: OTLP_EXPORT_INTERVAL_MS,
      })]
    : [
        new PrometheusExporter({ port: PORT, host: HOST, endpoint: '/metrics' }, () => {
          // eslint-disable-next-line no-console
          console.log(`[telemetry] Prometheus scrape endpoint: http://${HOST}:${PORT}/metrics`);
        }),
      ];

  if (useOtlp) {
    // eslint-disable-next-line no-console
    console.log(`[telemetry] OTLP exporter -> ${OTLP_ENDPOINT} (every ${OTLP_EXPORT_INTERVAL_MS}ms)`);
  }

  provider = new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'obs-ingestion',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
    }),
    readers,
  });
  metrics.setGlobalMeterProvider(provider);

  // Bind the meter and create the instruments AFTER the provider is set, so
  // they're attached to the real MeterProvider rather than the global noop.
  meter = provider.getMeter('obs-ingestion', '1.0.0');

  logsReceived = meter.createCounter('ingestion_logs_received_total', {
    description: 'Inference log envelopes accepted at /v1/logs (before worker validation).',
  });
  logsProcessed = meter.createCounter('ingestion_logs_processed_total', {
    description: 'Inference logs that completed the worker pipeline.',
  });
  logsFailed = meter.createCounter('ingestion_logs_failed_total', {
    description: 'Inference logs dead-lettered by the worker (raw_events.status=failed).',
  });
  processingDuration = meter.createHistogram('ingestion_processing_duration_seconds', {
    description: 'End-to-end worker processing time per event.',
    unit: 's',
    advice: { explicitBucketBoundaries: PROCESSING_BUCKETS_SEC },
  });
  inferenceRequests = meter.createCounter('llm_inference_requests_total', {
    description: 'LLM inference calls by provider/model/status.',
  });
  inferenceLatency = meter.createHistogram('llm_inference_latency_ms', {
    description: 'LLM call wall-clock latency, as reported by the SDK.',
    unit: 'ms',
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_MS },
  });
  inferenceTtft = meter.createHistogram('llm_inference_ttft_ms', {
    description: 'Time to first streamed token, as reported by the SDK.',
    unit: 'ms',
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_MS },
  });
  inferenceTokens = meter.createCounter('llm_inference_tokens_total', {
    description: 'LLM token usage by provider/model/kind (prompt|completion).',
  });
  inferenceCost = meter.createCounter('llm_inference_cost_usd_total', {
    description: 'Estimated USD spend by provider/model (heuristic from pricing table).',
  });
  piiRedactions = meter.createCounter('ingestion_pii_redactions_total', {
    description: 'PII tokens redacted by the server-side pass.',
  });
}

function ensureMetricsPath(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, '');
  return trimmed.endsWith('/v1/metrics') ? trimmed : `${trimmed}/v1/metrics`;
}

export async function shutdownTelemetry(): Promise<void> {
  if (!provider) return;
  await provider.shutdown().catch(() => undefined);
  provider = null;
}

// Queue-depth observable. Wired in index.ts once the queue exists.
export function registerQueueDepthGauge(probe: () => Promise<number> | number): void {
  if (!meter) return;
  const gauge = meter.createObservableGauge('ingestion_queue_depth', {
    description: 'Pending events waiting for the worker.',
  });
  gauge.addCallback(async (observable: ObservableResult) => {
    try {
      observable.observe(await probe());
    } catch {
      observable.observe(0);
    }
  });
}
