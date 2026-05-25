import { describe, expect, it } from 'vitest';
import { chatMessageInputSchema, inferenceLogSchema } from './schemas.js';
import { makePreview } from './types.js';

const validLog = {
  eventId: 'evt-1',
  sessionId: 'sess-1',
  conversationId: 'conv-1',
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  status: 'success',
  latencyMs: 120,
  requestTimestamp: '2026-05-22T10:00:00.000Z',
  responseTimestamp: '2026-05-22T10:00:00.120Z',
};

describe('inferenceLogSchema', () => {
  it('accepts a minimal valid log and applies defaults', () => {
    const parsed = inferenceLogSchema.parse(validLog);
    expect(parsed.streaming).toBe(false);
    expect(parsed.inputPreview).toBe('');
    expect(parsed.metadata).toEqual({});
    expect(parsed.sdkVersion).toBe('unknown');
  });

  it('rejects a log with a missing required field', () => {
    const { eventId, ...withoutEventId } = validLog;
    expect(inferenceLogSchema.safeParse(withoutEventId).success).toBe(false);
  });

  it('rejects an unknown provider', () => {
    expect(inferenceLogSchema.safeParse({ ...validLog, provider: 'skynet' }).success).toBe(false);
  });

  it('rejects a negative latency', () => {
    expect(inferenceLogSchema.safeParse({ ...validLog, latencyMs: -5 }).success).toBe(false);
  });
});

describe('chatMessageInputSchema', () => {
  it('accepts a valid message', () => {
    const parsed = chatMessageInputSchema.parse({
      conversationId: 'c1',
      role: 'user',
      content: 'hello',
      sequence: 0,
    });
    expect(parsed.role).toBe('user');
  });

  it('accepts a message without an explicit sequence', () => {
    const parsed = chatMessageInputSchema.parse({
      conversationId: 'c1',
      role: 'user',
      content: 'hello',
    });
    expect(parsed.sequence).toBeUndefined();
  });

  it('rejects an invalid role', () => {
    const result = chatMessageInputSchema.safeParse({
      conversationId: 'c1',
      role: 'robot',
      content: 'hi',
      sequence: 0,
    });
    expect(result.success).toBe(false);
  });

  it('accepts a metricsWindowMinutes stamp on the assistant turn', () => {
    const parsed = chatMessageInputSchema.parse({
      conversationId: 'c1',
      role: 'assistant',
      content: 'answer',
      metricsWindowMinutes: 60,
    });
    expect(parsed.metricsWindowMinutes).toBe(60);
  });

  it('rejects a metricsWindowMinutes outside the one-year cap', () => {
    const result = chatMessageInputSchema.safeParse({
      conversationId: 'c1',
      role: 'assistant',
      content: 'answer',
      metricsWindowMinutes: 60 * 24 * 366,
    });
    expect(result.success).toBe(false);
  });
});

describe('makePreview', () => {
  it('returns short text unchanged', () => {
    expect(makePreview('short text')).toBe('short text');
  });

  it('truncates long text and notes the dropped length', () => {
    const preview = makePreview('x'.repeat(900), 500);
    expect(preview.length).toBeLessThan(900);
    expect(preview).toContain('+400 chars');
  });
});
