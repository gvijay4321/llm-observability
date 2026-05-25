/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // OTel packages must be loaded from node_modules at runtime, not bundled by
  // webpack. Bundling mangles their internal HTTP/TLS plumbing and causes
  // every metrics export to throw AggregateError. This is the documented
  // OTel + Next.js workaround — and crucially must include the transitive
  // packages (otlp-exporter-base, otlp-transformer, core) where the actual
  // HTTP transport lives, not just the visible exporter package.
  serverExternalPackages: [
    '@opentelemetry/api',
    '@opentelemetry/core',
    '@opentelemetry/exporter-metrics-otlp-http',
    '@opentelemetry/exporter-metrics-otlp-proto',
    '@opentelemetry/exporter-prometheus',
    '@opentelemetry/otlp-exporter-base',
    '@opentelemetry/otlp-transformer',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/semantic-conventions',
  ],
};

export default nextConfig;
