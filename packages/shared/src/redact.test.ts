import { describe, expect, it } from 'vitest';
import { containsPii, redact } from './redact.js';

describe('redact', () => {
  it('redacts email addresses', () => {
    const { text, count } = redact('contact me at jane.doe@example.com please');
    expect(text).toContain('[REDACTED_EMAIL]');
    expect(text).not.toContain('jane.doe@example.com');
    expect(count).toBe(1);
  });

  it('redacts US SSNs', () => {
    expect(redact('ssn 123-45-6789').text).toContain('[REDACTED_SSN]');
  });

  it('redacts credit-card-like numbers', () => {
    expect(redact('card 4111 1111 1111 1111').text).toContain('[REDACTED_CC]');
  });

  it('redacts IPv4 addresses', () => {
    expect(redact('from 192.168.1.42 today').text).toContain('[REDACTED_IP]');
  });

  it('redacts API-key-like secrets', () => {
    expect(redact('key sk-abcdef0123456789ABCDEF').text).toContain('[REDACTED_SECRET]');
  });

  it('leaves clean text untouched and reports a zero count', () => {
    const { text, count } = redact('the quick brown fox jumps over the lazy dog');
    expect(text).toBe('the quick brown fox jumps over the lazy dog');
    expect(count).toBe(0);
  });

  it('counts every distinct match', () => {
    const { count } = redact('a@b.com and c@d.com and 10.0.0.1');
    expect(count).toBe(3);
  });

  it('handles empty input', () => {
    expect(redact('')).toEqual({ text: '', count: 0 });
  });
});

describe('containsPii', () => {
  it('is true when PII is present', () => {
    expect(containsPii('email: x@y.com')).toBe(true);
  });

  it('is false for clean text', () => {
    expect(containsPii('just a normal sentence')).toBe(false);
  });
});
