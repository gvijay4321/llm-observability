import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from './pricing.js';

const usage = { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 };

describe('estimateCostUsd', () => {
  it('computes cost for a known model from input/output rates', () => {
    // $0.30/M in, $2.50/M out
    expect(estimateCostUsd('gemini-2.5-flash', usage)).toBeCloseTo(0.0028, 6);
  });

  it('is case-insensitive on the model name', () => {
    expect(estimateCostUsd('GEMINI-2.5-FLASH', usage)).toBeCloseTo(0.0028, 6);
  });

  it('returns null for an unknown model', () => {
    expect(estimateCostUsd('some-unreleased-model', usage)).toBeNull();
  });

  it('returns null when usage is missing', () => {
    expect(estimateCostUsd('gemini-2.5-flash', undefined)).toBeNull();
  });

  it('returns zero cost for known free-tier OSS models', () => {
    expect(estimateCostUsd('llama-3.3-70b-versatile', usage)).toBe(0);
  });
});
