import { getConversationLogs } from '@/lib/ingestion-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  try {
    return Response.json(await getConversationLogs(id));
  } catch (err) {
    return Response.json({ error: String(err), logs: [] }, { status: 502 });
  }
}
