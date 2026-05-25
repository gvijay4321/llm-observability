// Regex PII redaction. Not a substitute for a real DLP product.

export interface RedactionResult {
  text: string;
  count: number;
}

interface Rule {
  label: string;
  pattern: RegExp;
}

// Order matters: structured tokens before digit-runs (else phone eats key digits).
const RULES: Rule[] = [
  { label: 'EMAIL', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { label: 'SECRET', pattern: /\b(?:sk|pk|ghp|xoxb|AIza)[-_a-zA-Z0-9]{16,}\b/g },
  { label: 'CC', pattern: /\b(?:\d[ -]?){13,16}\b/g },
  { label: 'SSN', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'PHONE', pattern: /(?<!\d)(?:\+?\d{1,3}[ -]?)?(?:\(\d{1,4}\)[ -]?)?\d{3}[ -]?\d{3,4}[ -]?\d{0,4}(?!\d)/g },
  { label: 'IP', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

export function redact(input: string): RedactionResult {
  if (!input) return { text: input, count: 0 };
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (match) => {
      // Too short to be a real phone number.
      if (rule.label === 'PHONE' && match.replace(/\D/g, '').length < 7) {
        return match;
      }
      count += 1;
      return `[REDACTED_${rule.label}]`;
    });
  }
  return { text, count };
}

export function containsPii(input: string): boolean {
  return redact(input).count > 0;
}
