// Cheap liveness/readiness target for container probes. Doesn't hit Ingestion
// on purpose — the chatbot pod stays "alive" even when upstream is down.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}
