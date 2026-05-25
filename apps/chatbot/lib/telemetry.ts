// OTel imports must be runtime-dynamic so they bypass webpack's instrumentation
// chunk, which doesn't honor `serverExternalPackages` in dev. See `initChatbotTelemetry`.
import type { Counter, Histogram, Meter, MeterProvider } from '@opentelemetry/api';

const globalKey = Symbol.for('obs-chatbot-telemetry');
interface Slot {
  provider: MeterProvider | null;
  meter: Meter | null;
  chatRequests: Counter | null;
  chatTtft: Histogram | null;
  chatTotalDuration: Histogram | null;
  guardrailBlocks: Counter | null;
}
const slot: Slot = ((globalThis as unknown as Record<symbol, Slot>)[globalKey] ??= {
  provider: null,
  meter: null,
  chatRequests: null,
  chatTtft: null,
  chatTotalDuration: null,
  guardrailBlocks: null,
});

const ENABLED = (process.env.OTEL_METRICS_ENABLED ?? 'true').toLowerCase() !== 'false';
const PORT = Number(process.env.CHATBOT_PROMETHEUS_PORT ?? 9465);
const HOST = process.env.CHATBOT_PROMETHEUS_HOST ?? '0.0.0.0';
const OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
const OTLP_EXPORT_INTERVAL_MS = Number(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? 30_000);

const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 5000, 10000, 20000, 60000];

// OTel JS's env-var parser splits each header pair on `=`, which mangles
// trailing `==` base64 padding in Grafana Cloud's Authorization header. Parse
// it here (split on the first `=` only) and pass through the constructor.
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

export async function initChatbotTelemetry(): Promise<void> {
  if (!ENABLED || slot.provider) return;

  // `webpackIgnore` punts these to Node's resolver at runtime. Without it the
  // instrumentation chunk bundles the OTel packages and the prometheus
  // exporter's `require('http')` blows up because http is a Node built-in.
  const [
    { setDefaultResultOrder },
    { diag, DiagConsoleLogger, DiagLogLevel, metrics },
    { OTLPMetricExporter },
    { PrometheusExporter },
    { resourceFromAttributes },
    { MeterProvider: MeterProviderCtor, PeriodicExportingMetricReader },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
  ] = await Promise.all([
    import(/* webpackIgnore: true */ 'node:dns'),
    import(/* webpackIgnore: true */ '@opentelemetry/api'),
    import(/* webpackIgnore: true */ '@opentelemetry/exporter-metrics-otlp-proto'),
    import(/* webpackIgnore: true */ '@opentelemetry/exporter-prometheus'),
    import(/* webpackIgnore: true */ '@opentelemetry/resources'),
    import(/* webpackIgnore: true */ '@opentelemetry/sdk-metrics'),
    import(/* webpackIgnore: true */ '@opentelemetry/semantic-conventions'),
  ]);

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  // Railway egress has no IPv6; default DNS order yields AAAA first and
  // every export wastes the connect timeout on an unreachable IPv6.
  setDefaultResultOrder('ipv4first');

  const useOtlp = !!OTLP_ENDPOINT;
  const headers = parseOtlpHeaders();
  const readers = useOtlp
    ? [new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: ensureMetricsPath(OTLP_ENDPOINT!),
          headers,
          // Default 10s isn't enough Railway SFO → Grafana Cloud ap-south-1.
          timeoutMillis: 30_000,
        }),
        exportIntervalMillis: OTLP_EXPORT_INTERVAL_MS,
      })]
    : [
        new PrometheusExporter({ port: PORT, host: HOST, endpoint: '/metrics' }, (err) => {
          if (err) {
            // eslint-disable-next-line no-console
            console.warn(`[telemetry] Prometheus scrape endpoint disabled: ${err.message}`);
            return;
          }
          // eslint-disable-next-line no-console
          console.log(`[telemetry] Chatbot Prometheus scrape endpoint: http://${HOST}:${PORT}/metrics`);
        }),
      ];

  if (useOtlp) {
    // eslint-disable-next-line no-console
    console.log(`[telemetry] Chatbot OTLP exporter -> ${OTLP_ENDPOINT} (every ${OTLP_EXPORT_INTERVAL_MS}ms)`);
  }

  slot.provider = new MeterProviderCtor({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'obs-chatbot',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
    }),
    readers,
  });
  metrics.setGlobalMeterProvider(slot.provider);

  // Bind meter + create instruments AFTER setGlobalMeterProvider. Doing this
  // at module-load instead (before init) hands back a NoopMeter whose
  // counters silently drop every .add() — see the ingestion service for the
  // same fix.
  slot.meter = slot.provider.getMeter('obs-chatbot', '1.0.0');
  slot.chatRequests = slot.meter.createCounter('chatbot_chat_requests_total', {
    description: 'Calls to /api/chat by provider/model/outcome.',
  });
  slot.chatTtft = slot.meter.createHistogram('chatbot_chat_ttft_ms', {
    description: 'Time-to-first-token at the chat route boundary.',
    unit: 'ms',
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_MS },
  });
  slot.chatTotalDuration = slot.meter.createHistogram('chatbot_chat_total_ms', {
    description: 'Total /api/chat handling duration (open to close of the SSE stream).',
    unit: 'ms',
    advice: { explicitBucketBoundaries: LATENCY_BUCKETS_MS },
  });
  slot.guardrailBlocks = slot.meter.createCounter('chatbot_guardrail_blocks_total', {
    description: 'Prompts short-circuited by the input-safety layer, by category.',
  });
}

function ensureMetricsPath(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/, '');
  return trimmed.endsWith('/v1/metrics') ? trimmed : `${trimmed}/v1/metrics`;
}

// Tiny no-op shim so consumers can call .add()/.record() unconditionally
// even if init hasn't run yet (e.g. during a test or pre-register import).
const noopCounter: Counter = { add: () => undefined } as unknown as Counter;
const noopHistogram: Histogram = { record: () => undefined } as unknown as Histogram;

export const chatRequests: Counter = new Proxy(noopCounter, {
  get: (_t, p) => (slot.chatRequests ?? noopCounter)[p as keyof Counter],
});
export const chatTtft: Histogram = new Proxy(noopHistogram, {
  get: (_t, p) => (slot.chatTtft ?? noopHistogram)[p as keyof Histogram],
});
export const chatTotalDuration: Histogram = new Proxy(noopHistogram, {
  get: (_t, p) => (slot.chatTotalDuration ?? noopHistogram)[p as keyof Histogram],
});
export const guardrailBlocks: Counter = new Proxy(noopCounter, {
  get: (_t, p) => (slot.guardrailBlocks ?? noopCounter)[p as keyof Counter],
});
