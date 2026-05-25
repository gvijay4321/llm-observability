import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InferenceLog } from '@obs/shared';
import { LogShipper } from './transport.js';

function fakeLog(id: string): InferenceLog {
  return {
    eventId: id,
    sessionId: 's',
    conversationId: 'c',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    status: 'success',
    streaming: false,
    latencyMs: 10,
    inputPreview: '',
    outputPreview: '',
    requestTimestamp: '2026-05-22T10:00:00.000Z',
    responseTimestamp: '2026-05-22T10:00:00.010Z',
    sdkVersion: 'test',
    metadata: {},
  } as InferenceLog;
}

afterEach(() => vi.unstubAllGlobals());

describe('LogShipper', () => {
  it('ships buffered logs to /v1/logs in a single batched request', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const shipper = new LogShipper({ url: 'http://ingest:4000', apiKey: 'secret', batchSize: 50 });
    shipper.enqueue(fakeLog('1'));
    shipper.enqueue(fakeLog('2'));
    await shipper.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('http://ingest:4000/v1/logs');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer secret' });
    const body = JSON.parse((init as RequestInit).body as string) as { logs: unknown[] };
    expect(body.logs).toHaveLength(2);

    await shipper.close();
  });

  it('degrades gracefully (no fetch) when no ingestion URL is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const shipper = new LogShipper({});
    shipper.enqueue(fakeLog('1'));
    await shipper.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry a non-retryable 4xx response', async () => {
    const fetchMock = vi.fn(async () => new Response('bad payload', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const shipper = new LogShipper({ url: 'http://ingest:4000', batchSize: 50, maxRetries: 3 });
    shipper.enqueue(fakeLog('1'));
    await shipper.flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await shipper.close();
  });
});
