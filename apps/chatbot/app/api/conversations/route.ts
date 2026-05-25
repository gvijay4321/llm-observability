import type { ConversationStatus } from '@obs/shared';
import { listConversations } from '@/lib/ingestion-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const status = new URL(req.url).searchParams.get('status') as ConversationStatus | null;
  try {
    const data = await listConversations(status ?? undefined);
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: String(err), conversations: [] }, { status: 502 });
  }
}
