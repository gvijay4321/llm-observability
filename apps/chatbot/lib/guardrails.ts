// Pattern-based input guardrails run before the LLM. Named categories so the
// dashboard can chart safety events.

export type SafetyCategory =
  | 'prompt_injection'
  | 'illegal_violence'
  | 'self_harm'
  | 'sexual_minors'
  | 'malware'
  | 'pii_leak';

interface Rule {
  category: SafetyCategory;
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  {
    category: 'prompt_injection',
    pattern:
      /\b(ignore (all|the|your) (previous|prior|above) (instructions|prompts|system))\b/i,
    reason: 'attempts to override the system instructions',
  },
  {
    category: 'prompt_injection',
    pattern: /\b(developer mode|dan mode|do anything now|jailbreak|disable (your )?safety)\b/i,
    reason: 'asks to disable safety constraints',
  },
  {
    category: 'prompt_injection',
    pattern: /\b(reveal|print|show|output)\b.{0,30}\b(system prompt|hidden prompt|initial prompt)\b/i,
    reason: 'asks to reveal the system prompt',
  },
  {
    category: 'illegal_violence',
    pattern:
      /\b(how (do|to) i)\b.{0,60}\b(build|make|synthesi[sz]e|acquire)\b.{0,40}\b(bomb|explosive|nerve agent|bioweapon|chemical weapon|gun|firearm)\b/i,
    reason: 'requests instructions for weapons or mass-harm',
  },
  {
    category: 'self_harm',
    pattern: /\b(kill myself|suicide method|how to (cut|hang|overdose))\b/i,
    reason: 'self-harm content',
  },
  {
    category: 'sexual_minors',
    pattern: /\b(child|minor|underage|teen)\b.{0,40}\b(sex|nude|porn|erotic)\b/i,
    reason: 'sexual content involving minors',
  },
  {
    category: 'malware',
    pattern:
      /\bwrite (me )?(a )?(ransomware|keylogger|rootkit|botnet|stealer)\b|\b(payload|malicious code)\b.{0,40}\b(exfiltrate|persist|evade)\b/i,
    reason: 'requests functional malware',
  },
  {
    category: 'pii_leak',
    // Credit-card-ish: standard 4-4-4-4 / 4-4-4-3 groupings (separators allowed),
    // or a contiguous 15-16 digit run. Narrower than `13-16 digits anywhere` so
    // long order IDs / international phone numbers don't false-positive.
    pattern: /\b(?:\d{4}[ -]?){3}\d{3,4}\b|\b\d{15,16}\b/,
    reason: 'looks like it contains a credit-card number',
  },
];

export interface GuardrailVerdict {
  allowed: boolean;
  block?: {
    category: SafetyCategory;
    reason: string;
  };
}

export function checkPrompt(text: string): GuardrailVerdict {
  for (const r of RULES) {
    if (r.pattern.test(text)) {
      return { allowed: false, block: { category: r.category, reason: r.reason } };
    }
  }
  return { allowed: true };
}

export function refusalMessage(verdict: GuardrailVerdict): string {
  if (verdict.allowed || !verdict.block) return '';
  const { category, reason } = verdict.block;
  const friendly: Record<SafetyCategory, string> = {
    prompt_injection: "I can't follow instructions that try to override how I'm supposed to behave.",
    illegal_violence: "I can't help with that. It falls in a category I'm not allowed to assist with.",
    self_harm:
      "I won't help with self-harm. If you're in distress, please reach out to a crisis line. In the US: 988. In the UK: 116 123 (Samaritans).",
    sexual_minors: "I can't help with that. It's a category I refuse outright.",
    malware: "I can't help build malicious software intended to harm systems or people.",
    pii_leak:
      "Your message looks like it contains sensitive data (e.g. a card number). I'm not going to process it as-is. Please redact and try again.",
  };
  return `${friendly[category]}\n\n_(Blocked locally before reaching the model. Category: \`${category}\`, reason: ${reason}.)_`;
}
