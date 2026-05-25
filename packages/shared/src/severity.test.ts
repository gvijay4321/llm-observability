import { describe, expect, it } from 'vitest';
import { errorSeverity } from './severity.js';

describe('errorSeverity', () => {
  it('treats an empty window as ok', () => {
    expect(errorSeverity(0, 0)).toBe('ok');
  });

  it('treats a clean window as ok regardless of size', () => {
    expect(errorSeverity(0, 1)).toBe('ok');
    expect(errorSeverity(0, 1000)).toBe('ok');
  });

  it('does NOT trip red on a tiny sample even at 100%', () => {
    // 3/3 reads as 100% but the sample is too small to alert on.
    expect(errorSeverity(3, 3)).toBe('warn');
  });

  it('escalates to warn when there are real failures above the noise floor', () => {
    expect(errorSeverity(1, 10)).toBe('warn');
    expect(errorSeverity(4, 20)).toBe('warn');
  });

  it('escalates to bad only when failures are both numerous and frequent', () => {
    expect(errorSeverity(5, 20)).toBe('bad'); // 25% over 20 reqs
    expect(errorSeverity(50, 200)).toBe('bad');
  });

  it('keeps a high rate but low absolute count below bad', () => {
    expect(errorSeverity(4, 4)).toBe('warn');
  });

  it('treats a tiny rate as ok even when the absolute count is non-trivial', () => {
    // 1% over 1000 is below the 5% warn floor.
    expect(errorSeverity(10, 1000)).toBe('ok');
  });

  it('escalates to warn when the absolute count is high AND rate clears 5%', () => {
    expect(errorSeverity(50, 1000)).toBe('warn');
  });

  it('honours custom thresholds when supplied', () => {
    const strict = { badMinFailures: 1, badMinRate: 0.5, warnMinFailures: 1, warnMinRate: 0.01 };
    expect(errorSeverity(1, 1, strict)).toBe('bad');
    expect(errorSeverity(1, 100, strict)).toBe('warn');
  });
});
