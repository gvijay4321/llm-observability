import type { ConversationStatus } from '@obs/shared';
import { getConversation, getConversationLogs, patchConversation } from '@/lib/ingestion-client';
import { serverConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const [convo, logsRes] = await Promise.all([
      getConversation(id),
      getConversationLogs(id).catch(() => ({ logs: [] })),
    ]);
    // Stamp each assistant message with the provider/model from its own inference
    // log so historical bubbles keep their true attribution after a provider switch.
    const byMessageId = new Map(logsRes.logs.filter((l) => l.messageId).map((l) => [l.messageId!, l]));
    const messages = convo.messages.map((m) => {
      if (m.role !== 'assistant') return m;
      const log = byMessageId.get(m.id);
      if (!log) return m;
      return { ...m, provider: log.provider, model: log.model };
    });
    return Response.json({ ...convo, messages });
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const patch = (await req.json().catch(() => ({}))) as { status?: ConversationStatus; title?: string };
  try {
    return Response.json(await patchConversation(id, patch));
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}

// 404 from upstream is treated as success so DELETE stays idempotent.
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  try {
    const upstream = await fetch(
      `${serverConfig.ingestionUrl}/v1/conversations/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: {
          ...(serverConfig.ingestionApiKey
            ? { authorization: `Bearer ${serverConfig.ingestionApiKey}` }
            : {}),
        },
        cache: 'no-store',
      },
    );
    if (upstream.ok || upstream.status === 404) {
      return Response.json({ deleted: true });
    }
    const body = await upstream.text().catch(() => '');
    return Response.json(
      { error: 'ingestion_delete_failed', upstreamStatus: upstream.status, detail: body.slice(0, 300) },
      { status: 502 },
    );
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 502 });
  }
}
