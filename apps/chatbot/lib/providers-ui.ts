// Plain-text prefixes because native <select> options can't render markup.
// The em space ( ) keeps a visible gap between icon and name in the
// native dropdown, where consecutive ASCII spaces collapse on some platforms.
export const PROVIDER_LABELS: Record<string, string> = {
  gemini: '✦ Gemini',
  groq: '⚡ Groq',
  openrouter: '⇆ OpenRouter',
  hf: '🤗 Hugging Face (OSS)',
  ollama: '🦙 Ollama (local)',
};

// Display names without emojis / suffixes — used in tables, charts, and metadata
// strips where an avatar or context already conveys the provider.
export const PROVIDER_NAMES: Record<string, string> = {
  gemini: 'Gemini',
  groq: 'Groq',
  openrouter: 'OpenRouter',
  hf: 'Hugging Face',
  ollama: 'Ollama',
};

// Icons matching PROVIDER_LABELS, without the parenthetical environment suffix.
export const PROVIDER_ICONS: Record<string, string> = {
  gemini: '✦',
  groq: '⚡',
  openrouter: '⇆',
  hf: '🤗',
  ollama: '🦙',
};

export function formatProvider(id: string): string {
  return PROVIDER_NAMES[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : id);
}


// Strip a redundant provider-name prefix from a model id so that pairs like
// "Gemini · gemini-2.5-flash" render as "Gemini · 2.5-flash".
export function formatModelTag(providerId: string, model: string): string {
  const name = PROVIDER_NAMES[providerId];
  if (!name) return model;
  const lower = model.toLowerCase();
  const prefix = name.toLowerCase();
  if (lower.startsWith(prefix + '-') || lower.startsWith(prefix + '/')) {
    return model.slice(prefix.length + 1);
  }
  return model;
}

// Mirrors the gradients in ProviderAvatar so charts and chat avatars match.
export const PROVIDER_COLORS: Record<string, string> = {
  gemini: '#4f8cff',
  groq: '#ff7a3d',
  openrouter: '#14b8a6',
  hf: '#ffcd1c',
  ollama: '#64748b',
};

export const PROVIDER_FALLBACK_PALETTE = [
  '#818cf8',
  '#a78bfa',
  '#f472b6',
  '#fbbf24',
  '#34d399',
  '#60a5fa',
  '#fb7185',
];

export function providerColor(name: string, index = 0): string {
  return (
    PROVIDER_COLORS[name] ??
    PROVIDER_FALLBACK_PALETTE[index % PROVIDER_FALLBACK_PALETTE.length]!
  );
}
