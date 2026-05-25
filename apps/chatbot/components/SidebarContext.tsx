'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { ConversationRecord } from '@obs/shared';
import { DEFAULT_WINDOW } from '@/lib/metric-windows';

interface Ctx {
  conversations: ConversationRecord[];
  // False until the first refresh resolves, so cold load shows a spinner.
  conversationsLoaded: boolean;
  activeId: string;
  refresh: () => Promise<void>;
  setActiveId: (id: string) => void;
  selectConversation: (id: string) => void;
  newChat: () => void;
  requestDelete: (conv: ConversationRecord) => void;
  metricsWindow: number;
  setMetricsWindow: (m: number) => void;
  metricsCollapsed: boolean;
  setMetricsCollapsed: (c: boolean) => void;
}

const METRICS_COLLAPSED_KEY = 'obs.metricsCollapsed';

const SidebarContext = createContext<Ctx | null>(null);

export function SidebarProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [conversationsLoaded, setConversationsLoaded] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [pendingDelete, setPendingDelete] = useState<ConversationRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [metricsWindow, setMetricsWindow] = useState<number>(DEFAULT_WINDOW);
  const [metricsCollapsed, setMetricsCollapsedState] = useState<boolean>(false);

  // Read localStorage post-mount; no SSR access.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (window.localStorage.getItem(METRICS_COLLAPSED_KEY) === '1') {
        setMetricsCollapsedState(true);
      }
    } catch {
      // storage disabled
    }
  }, []);

  const setMetricsCollapsed = useCallback((c: boolean) => {
    setMetricsCollapsedState(c);
    try {
      window.localStorage.setItem(METRICS_COLLAPSED_KEY, c ? '1' : '0');
    } catch {
      // storage disabled
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations');
      const data = (await res.json()) as { conversations?: ConversationRecord[] };
      if (data.conversations) setConversations(data.conversations);
    } catch {
      // keep the existing list
    } finally {
      setConversationsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectConversation = useCallback(
    (id: string) => {
      setActiveId(id);
      router.push('/');
    },
    [router],
  );

  const newChat = useCallback(() => {
    setActiveId('');
    router.push('/');
  }, [router]);

  const requestDelete = useCallback((conv: ConversationRecord) => {
    setPendingDelete(conv);
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setDeleting(true);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setActiveId((curr) => (curr === id ? '' : curr));
      setPendingDelete(null);
      await refresh();
    } catch {
      await refresh();
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, refresh]);

  const value = useMemo<Ctx>(
    () => ({
      conversations,
      conversationsLoaded,
      activeId,
      refresh,
      setActiveId,
      selectConversation,
      newChat,
      requestDelete,
      metricsWindow,
      setMetricsWindow,
      metricsCollapsed,
      setMetricsCollapsed,
    }),
    [
      conversations,
      conversationsLoaded,
      activeId,
      refresh,
      selectConversation,
      newChat,
      requestDelete,
      metricsWindow,
      metricsCollapsed,
      setMetricsCollapsed,
    ],
  );

  return (
    <SidebarContext.Provider value={value}>
      {children}
      {pendingDelete && (
        <div
          className="modal-backdrop"
          onClick={() => !deleting && setPendingDelete(null)}
          role="dialog"
          aria-modal="true"
        >
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Delete conversation?</h3>
            <p>
              &quot;{pendingDelete.title}&quot; will be permanently removed. This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button
                className="btn-secondary"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn-danger"
                onClick={() => void confirmDelete()}
                disabled={deleting}
                autoFocus
              >
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </SidebarContext.Provider>
  );
}

export function useSidebar(): Ctx {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used inside <SidebarProvider>');
  return ctx;
}
