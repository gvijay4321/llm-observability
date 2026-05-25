'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSidebar } from './SidebarContext';

const ChatIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </svg>
);

const DashIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 3v18h18" />
    <path d="M7 14l3-3 3 3 5-5" />
  </svg>
);

const CompareIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3" y="4" width="8" height="16" rx="2" />
    <rect x="13" y="4" width="8" height="16" rx="2" />
  </svg>
);

const EvalIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 11l3 3L22 4" />
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
  </svg>
);

const PlusIcon = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" aria-hidden>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

const ChevronIcon = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={dir === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6'} />
  </svg>
);

const STORAGE_KEY = 'app:sidebarCollapsed';

export default function AppSidebar() {
  const pathname = usePathname() ?? '/';
  const sb = useSidebar();
  // Initializer reads localStorage so first paint already has the right width.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  });
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  const isChat = pathname === '/';
  const isDash = pathname.startsWith('/dashboard');
  const isCompare = pathname.startsWith('/compare');
  const isEval = pathname.startsWith('/eval');

  const renderBody = (expanded: boolean, inDrawer: boolean) => (
    <>
      <div className="sb-head">
        <button
          type="button"
          className="sb-brand"
          onClick={() => {
            if (collapsed && !inDrawer) setDrawerOpen(true);
          }}
          aria-label="LLM Observability"
          title={collapsed && !inDrawer ? 'Open menu' : undefined}
        >
          <span className="sb-brand-mark" />
          {expanded && <span className="sb-brand-text">LLM Observability</span>}
        </button>
        {expanded && (
          <button
            type="button"
            className="sb-collapse"
            onClick={() => {
              if (inDrawer) setDrawerOpen(false);
              else setCollapsed(true);
            }}
            aria-label={inDrawer ? 'Close menu' : 'Collapse sidebar'}
            title={inDrawer ? 'Close' : 'Collapse'}
          >
            <ChevronIcon dir="left" />
          </button>
        )}
        {!expanded && (
          <button
            type="button"
            className="sb-expand"
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
            title="Expand"
          >
            <ChevronIcon dir="right" />
          </button>
        )}
      </div>

      <button
        type="button"
        className={`sb-new${expanded ? '' : ' sb-new--icon'}`}
        onClick={() => {
          sb.newChat();
          if (inDrawer) setDrawerOpen(false);
        }}
        title={expanded ? undefined : 'New chat'}
      >
        {PlusIcon}
        {expanded && <span>New chat</span>}
      </button>

      <nav className="sb-nav" aria-label="Primary">
        <Link
          href="/"
          className={`sb-link${isChat ? ' active' : ''}${expanded ? '' : ' sb-link--icon'}`}
          aria-current={isChat ? 'page' : undefined}
          title={expanded ? undefined : 'Chat'}
        >
          <span className="sb-link-icon">{ChatIcon}</span>
          {expanded && <span className="sb-link-label">Chat</span>}
        </Link>
        <Link
          href="/dashboard"
          className={`sb-link${isDash ? ' active' : ''}${expanded ? '' : ' sb-link--icon'}`}
          aria-current={isDash ? 'page' : undefined}
          title={expanded ? undefined : 'Dashboard'}
        >
          <span className="sb-link-icon">{DashIcon}</span>
          {expanded && <span className="sb-link-label">Dashboard</span>}
        </Link>
        <Link
          href="/compare"
          className={`sb-link${isCompare ? ' active' : ''}${expanded ? '' : ' sb-link--icon'}`}
          aria-current={isCompare ? 'page' : undefined}
          title={expanded ? undefined : 'Compare'}
        >
          <span className="sb-link-icon">{CompareIcon}</span>
          {expanded && <span className="sb-link-label">Compare</span>}
        </Link>
        <Link
          href="/eval"
          className={`sb-link${isEval ? ' active' : ''}${expanded ? '' : ' sb-link--icon'}`}
          aria-current={isEval ? 'page' : undefined}
          title={expanded ? undefined : 'Eval'}
        >
          <span className="sb-link-icon">{EvalIcon}</span>
          {expanded && <span className="sb-link-label">Eval</span>}
        </Link>
      </nav>

      {expanded && (
        <div className="sb-slot">
          <div className="sb-section-head">Recent</div>
          <div className="conv-list">
            {!sb.conversationsLoaded && (
              <div className="conv-skel-list" aria-label="Loading conversations">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="conv-skel">
                    <div className="conv-skel-title" />
                    <div className="conv-skel-meta" />
                  </div>
                ))}
              </div>
            )}
            {sb.conversationsLoaded && sb.conversations.length === 0 && (
              <div className="conv-meta" style={{ padding: '4px 8px' }}>
                No conversations yet.
              </div>
            )}
            {sb.conversations.map((c) => (
              <div
                key={c.id}
                className={`conv ${c.id === sb.activeId ? 'active' : ''}`}
                onClick={() => {
                  sb.selectConversation(c.id);
                  if (inDrawer) setDrawerOpen(false);
                }}
              >
                <div className="conv-main">
                  <div className="conv-title">{c.title}</div>
                  <div className="conv-meta">
                    {c.messageCount} msgs ·{' '}
                    {new Date(c.updatedAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
                <button
                  className="conv-x"
                  title="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    sb.requestDelete(c);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sb-foot">
        <button type="button" className="sb-avatar" aria-label="Account">
          N
        </button>
      </div>
    </>
  );

  return (
    <>
      <aside
        className={`sb${collapsed ? ' sb--collapsed' : ''}`}
        aria-label="Sidebar"
        suppressHydrationWarning
      >
        {renderBody(!collapsed, false)}
      </aside>

      {drawerOpen && (
        <>
          <div className="sb-scrim" onClick={() => setDrawerOpen(false)} aria-hidden />
          <aside className="sb sb--drawer" aria-label="Sidebar menu">
            {renderBody(true, true)}
          </aside>
        </>
      )}
    </>
  );
}
