// Heuristic intent extraction. Whatever the user named in the message wins
// over the UI selector.
import type { Provider } from '@obs/shared';

const PROVIDER_ALIASES: Array<{ id: Provider; matches: RegExp }> = [
  { id: 'gemini', matches: /\bgemini\b/i },
  { id: 'groq', matches: /\bgroq\b/i },
  { id: 'openrouter', matches: /\bopen ?router\b/i },
  { id: 'hf', matches: /\b(hugging ?face|hf)\b/i },
  { id: 'ollama', matches: /\bollama\b/i },
];

const VALID_WINDOWS = [15, 60, 360, 1440, 60 * 24 * 7, 60 * 24 * 30, 60 * 24 * 365];

// Prefer rounding up so we don't undershoot.
function snapToValidWindow(minutes: number): number {
  let best = VALID_WINDOWS[0]!;
  let bestDiff = Math.abs(minutes - best);
  for (const w of VALID_WINDOWS) {
    const d = Math.abs(minutes - w);
    if (w >= minutes && (w - minutes) <= bestDiff) {
      best = w;
      bestDiff = w - minutes;
    } else if (d < bestDiff) {
      best = w;
      bestDiff = d;
    }
  }
  return best;
}

export interface ExtractedIntent {
  windowMinutes: number | null;
  mentionedProviders: Provider[];
}

const UNIT_MAP: Array<{ rx: RegExp; mult: number }> = [
  { rx: /^min(ute)?s?$/i, mult: 1 },
  { rx: /^(h|hr|hrs|hour|hours)$/i, mult: 60 },
  { rx: /^(d|day|days)$/i, mult: 60 * 24 },
  { rx: /^(w|wk|wks|week|weeks)$/i, mult: 60 * 24 * 7 },
  { rx: /^(mo|month|months)$/i, mult: 60 * 24 * 30 },
  { rx: /^(y|yr|yrs|year|years)$/i, mult: 60 * 24 * 365 },
];

function unitToMinutes(unit: string): number | null {
  for (const { rx, mult } of UNIT_MAP) if (rx.test(unit)) return mult;
  return null;
}

function extractWindow(text: string): number | null {
  const t = text.toLowerCase();

  // last/past/over N <unit>
  const m1 = t.match(
    /(?:last|past|over the last|in the last|previous)\s+(\d+)\s*(min(?:ute)?s?|hrs?|hours?|d|days?|w|wks?|weeks?|mo|months?|y|yrs?|years?|h)\b/,
  );
  if (m1) {
    const n = parseInt(m1[1]!, 10);
    const mult = unitToMinutes(m1[2]!);
    if (mult) return snapToValidWindow(n * mult);
  }

  // N <unit> without a "last" prefix
  const m2 = t.match(
    /\b(\d+)\s*(min(?:ute)?s?|hrs?|hours?|days?|weeks?|months?|years?|h)\b/,
  );
  if (m2 && /(window|range|period|history|hour|day|week|month|year)/.test(t)) {
    const n = parseInt(m2[1]!, 10);
    const mult = unitToMinutes(m2[2]!);
    if (mult) return snapToValidWindow(n * mult);
  }

  if (/(yesterday|since\s+yesterday)/.test(t)) return 1440;
  if (/\b(today|past\s+hour|last\s+hour)\b/.test(t)) return 60;
  if (/\b(this|past|last)\s+week\b/.test(t)) return 60 * 24 * 7;
  if (/\b(this|past|last)\s+month\b/.test(t)) return 60 * 24 * 30;
  if (/\b(this|past|last)\s+year\b/.test(t)) return 60 * 24 * 365;
  if (/\ball[\s-]?time\b|\bever\b|\blifetime\b/.test(t)) return 60 * 24 * 365;

  return null;
}

function extractProviders(text: string): Provider[] {
  const found: Provider[] = [];
  for (const { id, matches } of PROVIDER_ALIASES) {
    if (matches.test(text)) found.push(id);
  }
  return found;
}

export function extractIntent(text: string): ExtractedIntent {
  return {
    windowMinutes: extractWindow(text),
    mentionedProviders: extractProviders(text),
  };
}
