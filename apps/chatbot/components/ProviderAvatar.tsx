import type { ReactElement } from 'react';

interface Visual {
  gradient: string;
  icon: ReactElement;
}

const SIZE = 16;

const VISUALS: Record<string, Visual> = {
  gemini: {
    gradient: 'linear-gradient(135deg, #4f8cff, #7c5cf0)',
    icon: (
      <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="#fff" aria-hidden>
        <path d="M12 2l2.4 7.2 7.2 2.4-7.2 2.4-2.4 7.2-2.4-7.2L2.4 11.6l7.2-2.4z" />
      </svg>
    ),
  },
  groq: {
    gradient: 'linear-gradient(135deg, #ff7a3d, #d72638)',
    icon: (
      <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="#fff" aria-hidden>
        <path d="M13 2L4 14h6l-1 8 10-13h-7z" />
      </svg>
    ),
  },
  openrouter: {
    gradient: 'linear-gradient(135deg, #14b8a6, #0891b2)',
    icon: (
      <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="none" stroke="#fff"
        strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 6h13" />
        <path d="M14 3l3 3-3 3" />
        <path d="M20 18H7" />
        <path d="M10 15l-3 3 3 3" />
      </svg>
    ),
  },
  hf: {
    gradient: 'linear-gradient(135deg, #ffcd1c, #ff8a00)',
    icon: (
      <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="none" stroke="#fff"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 14c1.2 1.5 2.5 2.2 4 2.2s2.8-.7 4-2.2" />
        <circle cx="9" cy="10" r="0.6" fill="#fff" stroke="none" />
        <circle cx="15" cy="10" r="0.6" fill="#fff" stroke="none" />
      </svg>
    ),
  },
  ollama: {
    gradient: 'linear-gradient(135deg, #64748b, #475569)',
    icon: (
      <svg width={SIZE} height={SIZE} viewBox="0 0 24 24" fill="none" stroke="#fff"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 3l8 4.6v8.8L12 21 4 16.4V7.6z" />
        <path d="M4 7.6L12 12l8-4.4" />
        <path d="M12 12v9" />
      </svg>
    ),
  },
};

export function providerVisual(provider?: string): Visual | null {
  if (!provider) return null;
  return VISUALS[provider] ?? null;
}
