import { getMetrics } from '@/lib/ingestion-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const window = Number(new URL(req.url).searchParams.get('windowMinutes') ?? 60);
  try {
    return Response.json(await getMetrics(Number.isFinite(window) ? window : 60));
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
