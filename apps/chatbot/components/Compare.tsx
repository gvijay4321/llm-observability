'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSidebar } from './SidebarContext';
import { PROVIDER_LABELS, formatProvider } from '@/lib/providers-ui';
import { providerVisual } from './ProviderAvatar';

interface ProviderOption {
  id: string;
  model: string;
  reachable?: boolean;
}

interface PaneMsg {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  safetyBlocked?: boolean;
}

interface PaneState {
  provider: string;
  messages: PaneMsg[];
  busy: boolean;
  latencyMs: number | null;
  ttftMs: number | null;
}

const SUGGESTIONS = [
  'What drives latency p95 in this system?',
  'How does throughput differ by provider?',
  'Explain token usage simply',
  'What causes error rate spikes?',
];

async function readSSE(
  res: Response,
  signal: AbortSignal,
  onEvent: (ev: Record<string, unknown>) => void,
): Promise<void> {
  const reader = res.body!.getReader();
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', onAbort);
  try {
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (frame.startsWith('data:')) {
          try {
            onEvent(JSON.parse(frame.slice(5).trim()));
          } catch {
            // malformed frame
          }
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export default function Compare() {
  const sb = useSidebar();
  const sessionId = useMemo(() => crypto.randomUUID(), []);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [input, setInput] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [left, setLeft] = useState<PaneState>({
    provider: 'gemini',
    messages: [],
    busy: false,
    latencyMs: null,
    ttftMs: null,
  });
  const [right, setRight] = useState<PaneState>({
    provider: 'hf',
    messages: [],
    busy: false,
    latencyMs: null,
    ttftMs: null,
  });

  const leftAbort = useRef<AbortController | null>(null);
  const rightAbort = useRef<AbortController | null>(null);
  const leftConvoId = useRef<string>(crypto.randomUUID());
  const rightConvoId = useRef<string>(crypto.randomUUID());
  // Guard so the deletion-detect effect doesn't fire on a fresh chat before sb.refresh lands.
  const seenLeftRef = useRef(false);
  const seenRightRef = useRef(false);

  // Sidebar deletion = was visible, now isn't; mint a new convoId.
  useEffect(() => {
    const ids = new Set(sb.conversations.map((c) => c.id));
    if (ids.has(leftConvoId.current)) seenLeftRef.current = true;
    if (ids.has(rightConvoId.current)) seenRightRef.current = true;

    if (seenLeftRef.current && !left.busy && !ids.has(leftConvoId.current)) {
      leftConvoId.current = crypto.randomUUID();
      seenLeftRef.current = false;
      setLeft((s) => ({ ...s, messages: [], latencyMs: null, ttftMs: null }));
    }
    if (seenRightRef.current && !right.busy && !ids.has(rightConvoId.current)) {
      rightConvoId.current = crypto.randomUUID();
      seenRightRef.current = false;
      setRight((s) => ({ ...s, messages: [], latencyMs: null, ttftMs: null }));
    }
  }, [sb.conversations, left.busy, right.busy]);

  useEffect(() => {
    fetch('/api/providers')
      .then((r) => r.json())
      .then((d: { providers?: ProviderOption[]; default?: string }) => {
        setProviders(d.providers ?? []);
        if (d.providers && d.providers.length > 0) {
          // Default to one frontier + one OSS, skipping unreachable.
          const reachableOnly = d.providers.filter((p) => p.reachable !== false);
          const ids = reachableOnly.map((p) => p.id);
          const frontier = ['gemini', 'groq'].find((p) => ids.includes(p));
          const oss = ['hf', 'ollama'].find((p) => ids.includes(p));
          setLeft((s) => ({ ...s, provider: frontier ?? d.default ?? ids[0]! }));
          setRight((s) => ({ ...s, provider: oss ?? (ids.find((i) => i !== (frontier ?? d.default)) ?? ids[0]!) }));
        }
      })
      .catch(() => undefined);
  }, []);

  const streamInto = useCallback(
    async (
      pane: 'left' | 'right',
      provider: string,
      convoId: string,
      history: PaneMsg[],
      userText: string,
      setPane: typeof setLeft,
      abortRef: typeof leftAbort,
    ) => {
      const fullHistory: PaneMsg[] = [...history, { role: 'user', content: userText }];
      const optimistic: PaneMsg[] = [...fullHistory, { role: 'assistant', content: '', streaming: true }];
      setPane((s) => ({ ...s, messages: optimistic, busy: true, latencyMs: null, ttftMs: null }));

      const abort = new AbortController();
      abortRef.current = abort;
      const updateLast = (mut: (m: PaneMsg) => PaneMsg) =>
        setPane((s) => ({
          ...s,
          messages: s.messages.map((m, i) => (i === s.messages.length - 1 ? mut(m) : m)),
        }));

      const t0 = Date.now();
      let ttftSet = false;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: convoId,
            sessionId,
            provider,
            messages: fullHistory.map((m) => ({ role: m.role, content: m.content })),
          }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

        await readSSE(res, abort.signal, (ev) => {
          switch (ev.type) {
            case 'meta':
              if (ev.safetyBlocked) updateLast((m) => ({ ...m, safetyBlocked: true }));
              break;
            case 'delta': {
              const text = String(ev.text ?? '');
              if (!ttftSet) {
                ttftSet = true;
                const t = Date.now() - t0;
                setPane((s) => ({ ...s, ttftMs: t }));
              }
              updateLast((m) => ({ ...m, content: m.content + text }));
              break;
            }
            case 'done':
              updateLast((m) => ({ ...m, streaming: false }));
              break;
            case 'error':
              updateLast((m) => ({ ...m, streaming: false }));
              setNote(`${pane} (${formatProvider(provider)}) error: ${String(ev.message ?? 'unknown')}`);
              break;
          }
        });
      } catch (err) {
        updateLast((m) => ({ ...m, streaming: false }));
        if (err instanceof Error && err.name !== 'AbortError') {
          setNote(`${pane} (${formatProvider(provider)}) request failed: ${err.message}`);
        }
      } finally {
        setPane((s) => ({ ...s, busy: false, latencyMs: Date.now() - t0 }));
        abortRef.current = null;
      }
    },
    [sessionId],
  );

  const askBoth = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || left.busy || right.busy) return;
      setInput('');
      setNote(null);
      await Promise.all([
        streamInto('left', left.provider, leftConvoId.current, left.messages, trimmed, setLeft, leftAbort),
        streamInto('right', right.provider, rightConvoId.current, right.messages, trimmed, setRight, rightAbort),
      ]);
      void sb.refresh();
    },
    [left.busy, right.busy, left.provider, right.provider, left.messages, right.messages, streamInto, sb],
  );

  const reset = useCallback(() => {
    leftAbort.current?.abort();
    rightAbort.current?.abort();
    leftConvoId.current = crypto.randomUUID();
    rightConvoId.current = crypto.randomUUID();
    seenLeftRef.current = false;
    seenRightRef.current = false;
    setLeft((s) => ({ ...s, messages: [], latencyMs: null, ttftMs: null }));
    setRight((s) => ({ ...s, messages: [], latencyMs: null, ttftMs: null }));
    setNote(null);
  }, []);

  const stopBoth = useCallback(() => {
    leftAbort.current?.abort();
    rightAbort.current?.abort();
  }, []);

  const renderPane = (s: PaneState, setS: typeof setLeft, side: 'left' | 'right') => {
    const opt = providers.find((p) => p.id === s.provider);
    const currentModel = opt?.model;
    const unreachable = opt?.reachable === false;
    // Hide the other pane's provider so both sides can't pick the same one.
    const otherProvider = side === 'left' ? right.provider : left.provider;
    const dropdownOptions = providers.filter(
      (p) => p.id !== otherProvider || p.id === s.provider,
    );
    return (
      <section className="cmp-pane">
        <header className="cmp-pane-head">
          <select
            className="provider-select"
            value={s.provider}
            onChange={(e) => setS((prev) => ({ ...prev, provider: e.target.value }))}
            disabled={s.busy}
          >
            {dropdownOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {PROVIDER_LABELS[p.id] ?? p.id}
                {p.reachable === false ? ' · offline' : ''}
              </option>
            ))}
          </select>
          <span className="pill">
            <span className="pill-dot" />
            {currentModel || 'connecting'}
          </span>
        </header>
        {unreachable && (
          <div className="cmp-pane-banner" role="status">
            Provider unreachable from this deployment. Pick another above.
          </div>
        )}
        <div className="cmp-messages">
          {s.messages.length === 0 ? (
            <div className="cmp-empty">Type a prompt below — both panes answer at once.</div>
          ) : (
            s.messages.map((m, i) => {
              const paneVisual = providerVisual(s.provider);
              return (
              <div key={i} className={`msg ${m.role}${m.safetyBlocked ? ' safety-blocked' : ''}`}>
                <div
                  className={`avatar ${m.role}`}
                  style={
                    m.role === 'assistant' && !m.safetyBlocked && paneVisual
                      ? { background: paneVisual.gradient, boxShadow: 'none' }
                      : undefined
                  }
                >
                  {m.safetyBlocked
                    ? '⚠'
                    : m.role === 'user'
                      ? 'You'
                      : paneVisual?.icon ?? 'AI'}
                </div>
                <div className="bubble">
                  {m.streaming && !m.content ? (
                    <span className="typing"><span /><span /><span /></span>
                  ) : (
                    <>
                      {m.content}
                      {m.streaming && <span className="cursor" />}
                    </>
                  )}
                </div>
              </div>
              );
            })
          )}
        </div>
        <footer className="cmp-pane-foot">
          <span><b>TTFT</b> {s.ttftMs !== null ? `${s.ttftMs}ms` : '-'}</span>
          <span><b>Total</b> {s.latencyMs !== null ? `${s.latencyMs}ms` : '-'}</span>
        </footer>
      </section>
    );
  };

  const busy = left.busy || right.busy;
  const leftUnreachable = providers.find((p) => p.id === left.provider)?.reachable === false;
  const rightUnreachable = providers.find((p) => p.id === right.provider)?.reachable === false;
  const eitherUnreachable = leftUnreachable || rightUnreachable;

  return (
    <main className="cmp">
      <div className="cmp-head">
        <div>
          <div className="cmp-eyebrow">Two-assistant comparison</div>
        </div>
        <button className="btn-ghost" onClick={reset} disabled={busy}>New session</button>
      </div>

      {note && <div className="note">{note}</div>}

      <div className="cmp-grid">
        {renderPane(left, setLeft, 'left')}
        {renderPane(right, setRight, 'right')}
      </div>

      <div className="cmp-composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void askBoth(input);
            }
          }}
          placeholder="Ask both assistants the same question…"
          rows={2}
        />
        {busy ? (
          <button className="icon-btn icon-btn-stop" onClick={stopBoth} title="Stop">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
        ) : (
          <button className="icon-btn" onClick={() => void askBoth(input)} disabled={!input.trim() || eitherUnreachable} title={eitherUnreachable ? 'One of the panes is offline - pick another provider' : 'Ask both'}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12l14 0"/><path d="M13 5l7 7-7 7"/></svg>
          </button>
        )}
      </div>

      {left.messages.length === 0 && right.messages.length === 0 && (
        <div className="cmp-suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="suggestion" onClick={() => void askBoth(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </main>
  );
}
