import { useShallow } from 'zustand/react/shallow'
import { useAgentStore, SessionStatus } from '../stores/agent-store'
import { cn } from '../lib/utils'
import type { Route } from '../App'

type NavPage = 'list' | 'active' | 'settings'

interface BottomNavProps {
  current: NavPage
  onNavigate: (route: Route) => void
}

/**
 * Persistent bottom tab bar — the app's main structure. Only rendered on the
 * three top-level pages (list/active/settings); task detail, conversation,
 * and form pages are pushed on top without it, same as a native app's
 * navigation stack.
 */
export function BottomNav({ current, onNavigate }: BottomNavProps) {
  const activeCount = useAgentStore(
    useShallow((s) => {
      let n = 0
      for (const session of s.sessions.values()) {
        if (session.status === SessionStatus.WORKING || session.status === SessionStatus.WAITING_APPROVAL) n++
      }
      return n
    })
  )

  const items: Array<{ page: NavPage; label: string; icon: (active: boolean) => React.ReactNode; badge?: number }> = [
    {
      page: 'list',
      label: 'Tasks',
      icon: (active) => (
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18" />
          <path d="M9 21V9" />
        </svg>
      )
    },
    {
      page: 'active',
      label: 'Active',
      badge: activeCount,
      icon: (active) => (
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
        </svg>
      )
    },
    {
      page: 'settings',
      label: 'Settings',
      icon: (active) => (
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
    }
  ]

  return (
    <nav
      className="shrink-0 border-t border-border/40 bg-[var(--card)]/95 backdrop-blur-sm flex items-stretch"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {items.map((item) => {
        const active = current === item.page
        return (
          <button
            key={item.page}
            onClick={() => onNavigate({ page: item.page === 'list' ? 'list' : item.page === 'active' ? 'active' : 'settings' })}
            className={cn(
              'flex-1 flex flex-col items-center justify-center gap-0.5 py-2 relative transition-colors',
              active ? 'text-primary' : 'text-muted-foreground active:text-foreground'
            )}
            aria-current={active ? 'page' : undefined}
          >
            <span className="relative">
              {item.icon(active)}
              {!!item.badge && (
                <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-amber-400 text-[9px] font-bold text-black flex items-center justify-center leading-none">
                  {item.badge > 9 ? '9+' : item.badge}
                </span>
              )}
            </span>
            <span className="text-[10px] font-medium">{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
