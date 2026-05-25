'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import InlineChart from './InlineChart';
import LiveMetrics, { type ChartSpec, type MetricHighlight } from './LiveMetrics';
import { useSidebar } from './SidebarContext';
import { PROVIDER_LABELS, formatProvider } from '@/lib/providers-ui';
import { windowLabel } from '@/lib/metric-windows';
import { providerVisual } from './ProviderAvatar';
import SuggestionCards from './SuggestionCards';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
  safetyBlocked?: boolean;
  provider?: string;
  model?: string;
  metricsWindowMinutes?: number;
}

interface ProviderOption {
  id: string;
  model: string;
  models: string[];
  reachable?: boolean;
}

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

function parseChart(text: string): { clean: string; chart: ChartSpec | null } {
  const idx = text.indexOf('```chart');
  if (idx === -1) return { clean: text, chart: null };
  const clean = text.slice(0, idx).trimEnd();
  const rest = text.slice(idx + 8);
  const end = rest.indexOf('```');
  if (end === -1) return { clean, chart: null };
  try {
    const raw = JSON.parse(rest.slice(0, end).trim()) as Partial<ChartSpec>;
    const validSeries =
      raw.series === 'requests' ||
      raw.series === 'errors' ||
      raw.series === 'latency' ||
      raw.series === 'providers';
    if (!validSeries) return { clean, chart: null };
    const validType =
      raw.type === 'bar' || raw.type === 'area' || raw.type === 'pie' || raw.type === 'line';
    const type: ChartSpec['type'] = validType ? raw.type! : 'line';
    return {
      clean,
      chart: { title: String(raw.title ?? 'Chart'), type, series: raw.series! },
    };
  } catch {
    // malformed directive
  }
  return { clean, chart: null };
}

// Drop user+empty-assistant pairs from aborted-before-content turns; the
// server persists nothing for those.
function stripDanglingTurns(msgs: ChatMsg[]): ChatMsg[] {
  let end = msgs.length;
  while (end >= 2) {
    const a = msgs[end - 1];
    const u = msgs[end - 2];
    if (
      a && a.role === 'assistant' && !a.streaming && !a.content.trim() &&
      u && u.role === 'user'
    ) {
      end -= 2;
    } else {
      break;
    }
  }
  return end === msgs.length ? msgs : msgs.slice(0, end);
}

function detectMetric(text: string): MetricHighlight {
  const t = text.toLowerCase();
  if (/error|fail/.test(t)) return 'errors';
  if (/latency|slow|p95|p99|response time|speed/.test(t)) return 'latency';
  if (/token|cost|spend|price|\$/.test(t)) return 'tokens';
  if (/throughput|request|traffic|volume|how many/.test(t)) return 'requests';
  return null;
}

function SendIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
    </svg>
  );
}

function MessagesSkeleton() {
  return (
    <div className="msgs-skeleton" aria-hidden>
      <div className="msg-skel">
        <div className="msg-skel-avatar" />
        <div className="msg-skel-bubble" style={{ width: '38%' }} />
      </div>
      <div className="msg-skel">
        <div className="msg-skel-avatar" />
        <div className="msg-skel-stack">
          <div className="msg-skel-bubble" style={{ width: '88%' }} />
          <div className="msg-skel-bubble" style={{ width: '72%' }} />
          <div className="msg-skel-bubble" style={{ width: '54%' }} />
        </div>
      </div>
      <div className="msg-skel">
        <div className="msg-skel-avatar" />
        <div className="msg-skel-bubble" style={{ width: '30%' }} />
      </div>
    </div>
  );
}

export default function ChatApp() {
  const sb = useSidebar();
  const sessionId = useMemo(() => crypto.randomUUID(), []);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [provider, setProvider] = useState<string>('');
  const [model, setModel] = useState<string>('');
  const [metricsPing, setMetricsPing] = useState(0);
  const [highlight, setHighlight] = useState<MetricHighlight>(null);
  const [transitioning, setTransitioning] = useState(false);
  // Resume can finish before /api/providers does. Stash the saved provider/model
  // here and let a follow-up effect apply it once the options list arrives.
  const [pendingConvoSettings, setPendingConvoSettings] = useState<{ provider: string; model?: string } | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sync double-send guard; `busy` only flips on the next render.
  const busyRef = useRef(false);
  const loadedIdRef = useRef<string>('');
  const selfCreatedRef = useRef<Set<string>>(new Set());
  const skipSmoothScrollRef = useRef(false);

  useEffect(() => {
    fetch('/api/providers')
      .then((r) => r.json())
      .then((d: { providers?: ProviderOption[]; default?: string }) => {
        const list = d.providers ?? [];
        setProviders(list);
        if (d.default) {
          setProvider(d.default);
          const def = list.find((p) => p.id === d.default);
          if (def) setModel(def.model);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!provider || providers.length === 0) return;
    const opt = providers.find((p) => p.id === provider);
    if (!opt) return;
    if (!opt.models.includes(model)) setModel(opt.model);
  }, [provider, providers, model]);

  useEffect(() => {
    const id = sb.activeId;
    if (id === loadedIdRef.current) return;
    loadedIdRef.current = id;
    abortRef.current?.abort();
    setNote(null);
    setInput('');

    // Locally-minted id; send() is populating messages, don't refetch.
    if (selfCreatedRef.current.has(id)) {
      return;
    }

    setTransitioning(true);
    let cancelled = false;
    // Floor on fade duration so fast loads still feel like a transition.
    const minDelay = new Promise<void>((resolve) => setTimeout(resolve, 170));

    void (async () => {
      let nextMessages: ChatMsg[] = [];
      let convoProvider: string | undefined;
      let convoModel: string | undefined;
      let loadFailed = false;

      if (id) {
        try {
          const res = await fetch(`/api/conversations/${id}`);
          if (res.ok) {
            const data = (await res.json()) as {
              conversation?: { provider?: string | null; model?: string | null };
              messages?: Array<{
                role: string;
                content: string;
                provider?: string | null;
                model?: string | null;
                metricsWindowMinutes?: number | null;
              }>;
            };
            convoProvider = data.conversation?.provider ?? undefined;
            convoModel = data.conversation?.model ?? undefined;
            nextMessages = (data.messages ?? [])
              .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
              .map((msg) => ({
                role: msg.role as ChatMsg['role'],
                content: msg.content,
                ...(msg.role === 'assistant'
                  ? {
                      provider: msg.provider ?? convoProvider,
                      model: msg.model ?? convoModel,
                      ...(typeof msg.metricsWindowMinutes === 'number'
                        ? { metricsWindowMinutes: msg.metricsWindowMinutes }
                        : {}),
                    }
                  : {}),
              }));
          }
        } catch {
          loadFailed = true;
        }
      }

      await minDelay;
      if (cancelled) return;

      skipSmoothScrollRef.current = true;
      setMessages(nextMessages);
      if (loadFailed) setNote('Could not load that conversation.');
      if (id && convoProvider) {
        setPendingConvoSettings({ provider: convoProvider, model: convoModel });
      }
      requestAnimationFrame(() => {
        if (!cancelled) setTransitioning(false);
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [sb.activeId]);

  useEffect(() => {
    if (!pendingConvoSettings || providers.length === 0 || busy) return;
    const opt = providers.find((p) => p.id === pendingConvoSettings.provider);
    if (!opt) {
      setPendingConvoSettings(null);
      return;
    }
    setProvider(pendingConvoSettings.provider);
    setModel(
      pendingConvoSettings.model && opt.models.includes(pendingConvoSettings.model)
        ? pendingConvoSettings.model
        : opt.model,
    );
    setPendingConvoSettings(null);
  }, [pendingConvoSettings, providers, busy]);

  useEffect(() => {
    const behavior: ScrollBehavior = skipSmoothScrollRef.current ? 'auto' : 'smooth';
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior });
    skipSmoothScrollRef.current = false;
  }, [messages]);

  const stopGeneration = useCallback(() => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return;
      const sel = providers.find((p) => p.id === provider);
      if (sel?.reachable === false) return;
      busyRef.current = true;

      let convId = sb.activeId;
      const isFreshConvo = !convId;
      if (isFreshConvo) {
        convId = crypto.randomUUID();
        selfCreatedRef.current.add(convId);
        loadedIdRef.current = convId;
        sb.setActiveId(convId);
      }

      const cleaned = stripDanglingTurns(messages);
      const history: ChatMsg[] = [...cleaned, { role: 'user', content: trimmed }];
      // Pre-fill the placeholder so the avatar renders from frame one.
      // Server's meta event overwrites these (notably guardrails forces provider='guardrails').
      setMessages([
        ...history,
        {
          role: 'assistant',
          content: '',
          streaming: true,
          provider,
          model,
          metricsWindowMinutes: sb.metricsWindow,
        },
      ]);
      setInput('');
      setBusy(true);
      setNote(null);
      setHighlight(detectMetric(trimmed));

      const updateAssistant = (mut: (m: ChatMsg) => ChatMsg) =>
        setMessages((prev) => prev.map((m, i) => (i === prev.length - 1 ? mut(m) : m)));

      const abort = new AbortController();
      abortRef.current = abort;
      let streamed = '';
      // True when the server already persisted a marker turn; keep the pair.
      let serverPersistedMarker = false;
      const dropPlaceholderPair = (): void =>
        setMessages((prev) => prev.slice(0, -2));

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: convId,
            sessionId,
            provider,
            model,
            windowMinutes: sb.metricsWindow,
            messages: history.map((m) => ({ role: m.role, content: m.content })),
          }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          let msg = `chat failed: HTTP ${res.status}`;
          try {
            const body = (await res.clone().json()) as { error?: string };
            if (body.error) msg = body.error;
          } catch {
            // not JSON
          }
          throw new Error(msg);
        }

        await readSSE(res, abort.signal, (ev) => {
          switch (ev.type) {
            case 'meta':
              updateAssistant((m) => ({
                ...m,
                ...(ev.safetyBlocked ? { safetyBlocked: true } : {}),
                ...(ev.provider ? { provider: String(ev.provider) } : {}),
                ...(ev.model ? { model: String(ev.model) } : {}),
                ...(typeof ev.metricsWindowMinutes === 'number'
                  ? { metricsWindowMinutes: ev.metricsWindowMinutes }
                  : {}),
              }));
              break;
            case 'delta':
              streamed += String(ev.text ?? '');
              updateAssistant((m) => ({ ...m, content: m.content + String(ev.text ?? '') }));
              break;
            case 'done':
              updateAssistant((m) => ({ ...m, streaming: false }));
              break;
            case 'error': {
              serverPersistedMarker = true;
              const errMsg = String(ev.message ?? 'unknown');
              updateAssistant((m) => ({
                ...m,
                streaming: false,
                // Mirrors the marker text that app/api/chat/route.ts persists.
                content: m.content || `(no response - ${formatProvider(m.provider ?? provider)} returned an error: ${errMsg})`,
              }));
              setNote(`Model error: ${errMsg}`);
              break;
            }
          }
        });

        if (abort.signal.aborted) {
          if (!streamed.trim() && !serverPersistedMarker) {
            dropPlaceholderPair();
            setNote('Generation stopped before a reply.');
          } else {
            updateAssistant((m) => ({ ...m, streaming: false }));
            setNote('Generation stopped - the partial reply was kept.');
          }
        }
      } catch (err) {
        const isAbort = err instanceof Error && err.name === 'AbortError';
        if (!streamed.trim() && !serverPersistedMarker) {
          dropPlaceholderPair();
          setNote(
            isAbort
              ? 'Generation stopped.'
              : `Request failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        } else {
          updateAssistant((m) => ({ ...m, streaming: false }));
          setNote(
            isAbort
              ? 'Generation stopped.'
              : `Request failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } finally {
        busyRef.current = false;
        setBusy(false);
        abortRef.current = null;
        if (isFreshConvo && convId) selfCreatedRef.current.delete(convId);
        void sb.refresh();
        setMetricsPing((n) => n + 1);
      }
    },
    [messages, sb, sessionId, provider, model, providers],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const activeTitle = sb.conversations.find((c) => c.id === sb.activeId)?.title;
  const currentProvider = providers.find((p) => p.id === provider);
  const modelOptions = currentProvider?.models ?? [];
  const currentReachable = currentProvider?.reachable !== false;

  return (
    <>
      <main className="main">
        <div className="topbar">
          <h1>{messages.length > 0 ? activeTitle ?? 'New conversation' : 'New conversation'}</h1>
          <div className="topbar-right">
            <select
              className="provider-select"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              disabled={busy}
              title="Switch model provider"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {PROVIDER_LABELS[p.id] ?? p.id}
                  {p.reachable === false ? ' · offline' : ''}
                </option>
              ))}
            </select>
            <select
              className="provider-select model-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={busy || modelOptions.length === 0}
              title="Switch model"
            >
              {modelOptions.length === 0 ? (
                <option value="">connecting…</option>
              ) : (
                modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))
              )}
            </select>
          </div>
        </div>

        {!currentReachable && (
          <div className="provider-banner" role="status">
            <strong>Ollama is local-only.</strong> This hosted demo runs on
            Railway, which has no GPU and no Ollama daemon, so requests against
            <code>localhost:11434</code> can't be served here. The provider is
            still listed so you can see it's wired up — clone the repo and run
            <code>npm run dev</code> alongside <code>ollama serve</code> to use
            it. Pick another provider above to chat in this deployment.
          </div>
        )}

        <div className={`messages${transitioning ? ' is-transitioning' : ''}`} ref={scrollRef}>
          <div className="messages-inner">
            {transitioning ? (
              <MessagesSkeleton />
            ) : messages.length === 0 ? (
              <div className="empty">
                <div className="empty-mark" aria-hidden>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                  </svg>
                </div>
                <h2>Start a conversation</h2>
                <p>
                  Every message is streamed from the model, instrumented by the SDK, and shipped to the
                  ingestion pipeline. Switch providers from the top-right and watch the live metrics react.
                </p>
                <SuggestionCards onPick={(s) => void send(s)} />
              </div>
            ) : (
              messages.map((m, i) => {
                const parsed = m.role === 'assistant' ? parseChart(m.content) : { clean: m.content, chart: null };
                const shown = parsed.clean;
                return (
                  <div key={i} className={`msg ${m.role}${m.safetyBlocked ? ' safety-blocked' : ''}`}>
                    <div
                      className={`avatar ${m.role}`}
                      style={
                        m.role === 'assistant' && !m.safetyBlocked && providerVisual(m.provider)
                          ? { background: providerVisual(m.provider)!.gradient, boxShadow: 'none' }
                          : undefined
                      }
                      aria-label={m.role === 'user' ? 'You' : 'Assistant'}
                    >
                      {m.safetyBlocked
                        ? '⚠'
                        : m.role === 'user'
                          ? <UserIcon />
                          : providerVisual(m.provider)?.icon ?? 'AI'}
                    </div>
                    <div className="msg-body">
                      <div className="bubble">
                        {m.streaming && !shown ? (
                          <span className="typing">
                            <span />
                            <span />
                            <span />
                          </span>
                        ) : (
                          <>
                            {shown}
                            {m.streaming && <span className="cursor" />}
                          </>
                        )}
                        {!m.streaming && parsed.chart && <InlineChart spec={parsed.chart} />}
                      </div>
                      {m.role === 'assistant' && !m.streaming && m.model && (
                        <div className="msg-meta" title={m.provider ? `${PROVIDER_LABELS[m.provider] ?? formatProvider(m.provider)} · ${m.model}` : m.model}>
                          {m.provider ? `${PROVIDER_LABELS[m.provider] ?? formatProvider(m.provider)} · ` : ''}
                          {m.model}
                          {typeof m.metricsWindowMinutes === 'number' && !m.safetyBlocked && (
                            <span
                              className="msg-meta-window"
                              title="Live metrics window the answer was anchored to"
                            >
                              {' · Window: '}
                              {windowLabel(m.metricsWindowMinutes)}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {note && <div className="note">{note}</div>}

        <div className="composer-wrap">
          <div className="composer">
            <textarea
              rows={1}
              placeholder={currentReachable ? 'Send a message...' : 'Pick a reachable provider above to chat'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={busy || !currentReachable}
            />
            {busy ? (
              <button className="icon-btn stop" onClick={stopGeneration} title="Stop generating">
                <StopIcon />
              </button>
            ) : (
              <button
                className="icon-btn"
                onClick={() => void send(input)}
                disabled={!input.trim() || !currentReachable}
                title={currentReachable ? 'Send message' : 'Selected provider is local-only in this deployment'}
              >
                <SendIcon />
              </button>
            )}
          </div>
          <div className="composer-hint">Enter to send · Shift+Enter for a new line</div>
        </div>
      </main>

      <LiveMetrics pingKey={metricsPing} highlight={highlight} />
    </>
  );
}
