import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getMeta } from '../db/db'
import { useI18n, useT } from '../i18n'
import { useOnline, useSession } from '../state/session'
import { getToken, syncNow } from '../lib/sync'
import type { StringKey } from '../i18n/strings'

const NAV: Array<{ to: string; key: StringKey; icon: ReactNode }> = [
  {
    to: '/inspect',
    key: 'nav.inspect',
    icon: (
      <path d="M4 5h16M4 12h16M4 19h10" strokeWidth="2" strokeLinecap="round" />
    ),
  },
  {
    to: '/dashboard',
    key: 'nav.dashboard',
    icon: <path d="M4 20V10m5 10V4m5 16v-7m5 7V7" strokeWidth="2" strokeLinecap="round" />,
  },
  {
    to: '/reports',
    key: 'nav.reports',
    icon: (
      <path
        d="M7 3h7l5 5v13H7zM14 3v5h5"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    to: '/labels',
    key: 'nav.labels',
    icon: (
      <path
        d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z"
        strokeWidth="2"
        strokeLinejoin="round"
      />
    ),
  },
  {
    to: '/setup',
    key: 'nav.setup',
    icon: (
      <>
        <circle cx="12" cy="12" r="3.2" strokeWidth="2" />
        <path
          d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </>
    ),
  },
]

export default function AppShell({ children }: { children: ReactNode }) {
  const t = useT()
  const { lang, setLang } = useI18n()
  const { inspector, exercise, logout } = useSession()
  const online = useOnline()
  const navigate = useNavigate()
  const location = useLocation()
  const syncing = useRef(false)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(timer)
  }, [])

  const org = useLiveQuery(async () => {
    if (!exercise) return undefined
    return db.organizations.get(exercise.orgId)
  }, [exercise?.orgId])

  const pending = useLiveQuery(async () => {
    const [entries, signoffs, photos] = await Promise.all([
      db.entries.where('syncStatus').equals('pending').count(),
      db.signoffs.where('syncStatus').equals('pending').count(),
      db.photos.where('syncStatus').equals('pending').count(),
    ])
    return entries + signoffs + photos
  }, [])

  const conflicts = useLiveQuery(() => db.entries.where('syncStatus').equals('conflict').count(), [])

  /**
   * How long since this device last heard from the server. A screen quietly
   * showing a floor plan that changed hours ago is worse than one that admits
   * it is behind, and it is what sent us looking for a sync bug that was a
   * suspended timer.
   */
  const stale = useLiveQuery(async () => {
    if (!(await getToken())) return false
    const last = await getMeta<number>('lastSyncAt', 0)
    return last > 0 && Date.now() - last > 10 * 60 * 1000
  }, [tick])

  /**
   * Background sync.
   *
   * The latch is released unconditionally. It used to be released only if the
   * effect had not been cleaned up, and the effect is cleaned up every time
   * `pending` changes — that is, every time the inspector saves. A save while
   * a sync was in flight left the latch held for the life of the page, and
   * nothing synced again until a reload. That is how a phone ends up sitting
   * on "3 waiting" with a perfectly good connection.
   */
  const runSync = useCallback(async () => {
    if (syncing.current) return
    if (!(await getToken())) return
    syncing.current = true
    try {
      await syncNow()
    } finally {
      syncing.current = false
    }
  }, [])

  // One pass shortly after load, then a slow heartbeat. A device that has just
  // signed in has nothing to push and everything to pull, and a push that
  // failed on a weak signal must not wait for someone to notice it.
  //
  // The heartbeat alone is not enough. Browsers throttle timers in a tab that
  // is not being looked at, and suspend them altogether on a sleeping laptop,
  // so a desktop left open beside the phone falls hours behind and shows a
  // floor plan that no longer exists. Coming back to the tab is exactly the
  // moment its contents matter, so that is when it syncs.
  useEffect(() => {
    if (!online) return
    const first = setTimeout(() => void runSync(), 1200)
    const beat = setInterval(() => void runSync(), 60_000)

    const onVisible = () => {
      if (document.visibilityState === 'visible') void runSync()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)

    return () => {
      clearTimeout(first)
      clearInterval(beat)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [online, runSync])

  // And promptly when something is waiting, so a save reaches the team fast.
  useEffect(() => {
    if (!online || !pending) return
    const timer = setTimeout(() => void runSync(), 1500)
    return () => clearTimeout(timer)
  }, [online, pending, runSync])

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-brand-900/20 bg-brand-700 text-white no-print">
        <div className="mx-auto flex max-w-3xl items-center gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-bold leading-tight">{org?.name ?? t('app.title')}</p>
            <p className="truncate text-[11px] text-brand-100">
              {exercise ? `${exercise.name} · ${exercise.date}` : t('app.subtitle')}
            </p>
          </div>

          <button
            type="button"
            onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}
            className="rounded-lg border border-white/30 px-2 py-1 text-xs font-bold uppercase"
            aria-label="Switch language"
          >
            {lang === 'en' ? 'SW' : 'EN'}
          </button>

          <button
            type="button"
            onClick={() => navigate('/sync')}
            className="relative rounded-lg border border-white/30 px-2 py-1 text-xs font-bold"
            aria-label={t('nav.sync')}
          >
            <span
              className={`mr-1 inline-block h-2 w-2 rounded-full ${
                !online ? 'bg-amber-300' : stale ? 'bg-amber-300' : 'bg-emerald-300'
              }`}
            />
            {pending ? pending : !online ? t('common.offline') : stale ? t('sync.stale') : t('common.online')}
            {Boolean(conflicts) && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold">
                !
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={logout}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-brand-100 hover:bg-white/10"
            title={`${inspector?.name ?? ''} — ${t('login.logout')}`}
          >
            {(inspector?.name ?? '?')
              .split(' ')
              .map((w) => w[0])
              .join('')
              .slice(0, 2)
              .toUpperCase()}
          </button>
        </div>

        {!online && (
          <div className="bg-amber-400 px-3 py-1 text-center text-[11px] font-semibold text-amber-950">
            {t('sync.offlineHint')}
          </div>
        )}
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-3 pb-28 pt-3">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur no-print">
        <div
          className="mx-auto grid max-w-3xl grid-cols-5"
          style={{ paddingBottom: 'var(--safe-bottom)' }}
        >
          {NAV.map((item) => {
            const active = location.pathname.startsWith(item.to)
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={`flex flex-col items-center gap-0.5 px-1 py-2 text-[11px] font-semibold transition ${
                  active ? 'text-brand-700' : 'text-slate-500'
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" aria-hidden="true">
                  {item.icon}
                </svg>
                {t(item.key)}
              </NavLink>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
