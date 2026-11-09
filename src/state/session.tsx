import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { db, getMeta, setMeta, uid } from '../db/db'
import { sha256 } from '../lib/hash'
import { login as serverLogin } from '../lib/sync'
import type { Exercise, Inspector } from '../types'

const SESSION_KEY = 'av.session.inspectorId'

interface SessionValue {
  ready: boolean
  inspector: Inspector | null
  exercise: Exercise | null
  isAdmin: boolean
  login: (email: string, password: string) => Promise<boolean>
  logout: () => void
  selectExercise: (exerciseId: string) => Promise<void>
  refresh: () => Promise<void>
}

const SessionContext = createContext<SessionValue | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [inspector, setInspector] = useState<Inspector | null>(null)
  const [exercise, setExercise] = useState<Exercise | null>(null)

  const refresh = useCallback(async () => {
    let storedId: string | null = null
    try {
      storedId = localStorage.getItem(SESSION_KEY)
    } catch {
      /* ignore */
    }
    const who = storedId ? ((await db.inspectors.get(storedId)) ?? null) : null
    setInspector(who && who.active ? who : null)

    const activeId = await getMeta<string | null>('activeExerciseId', null)
    let ex = activeId ? ((await db.exercises.get(activeId)) ?? null) : null
    if (!ex) {
      const all = await db.exercises.toArray()
      ex = all.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
      if (ex) await setMeta('activeExerciseId', ex.id)
    }
    setExercise(ex)
    setReady(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const startSession = useCallback((who: Inspector) => {
    try {
      localStorage.setItem(SESSION_KEY, who.id)
    } catch {
      /* ignore */
    }
    setInspector(who)
  }, [])

  /**
   * Sign-in is offline-first: the device is asked before the network, so an
   * inspector in a basement classroom with no signal still gets in.
   *
   * It falls back to the sync server when the device cannot answer — a phone
   * that has never synced holds no accounts at all, so without this a new
   * device could never be used, and wiping a device would lock its owner out
   * permanently. On success the account is written locally with the same hash
   * the offline path checks, so every later sign-in works with no signal.
   */
  const login = useCallback(
    async (email: string, password: string) => {
      const normalized = email.trim().toLowerCase()
      const hash = await sha256(password)

      const all = await db.inspectors.toArray()
      const found = all.find((i) => i.email.toLowerCase() === normalized && i.active)
      if (found?.passwordHash && found.passwordHash === hash) {
        startSession(found)
        return true
      }

      // A wrong password for a known account should not silently ask the
      // server, unless the server is the only thing that can answer.
      if (typeof navigator !== 'undefined' && !navigator.onLine) return false

      const account = await serverLogin(normalized, password)
      if (!account) return false

      const existing = all.find((i) => i.email.toLowerCase() === account.email.toLowerCase())
      const who: Inspector = {
        id: existing?.id ?? account.id ?? uid('insp_'),
        name: account.name || normalized,
        email: account.email || normalized,
        role: account.role === 'admin' ? 'admin' : 'inspector',
        active: true,
        passwordHash: hash,
        updatedAt: Date.now(),
        // It came from the server, so it is not something to push back up.
        syncStatus: 'synced',
      }
      await db.inspectors.put(who)
      startSession(who)
      return true
    },
    [startSession],
  )

  const logout = useCallback(() => {
    try {
      localStorage.removeItem(SESSION_KEY)
    } catch {
      /* ignore */
    }
    setInspector(null)
  }, [])

  const selectExercise = useCallback(async (exerciseId: string) => {
    await setMeta('activeExerciseId', exerciseId)
    setExercise((await db.exercises.get(exerciseId)) ?? null)
  }, [])

  const value = useMemo<SessionValue>(
    () => ({
      ready,
      inspector,
      exercise,
      isAdmin: inspector?.role === 'admin',
      login,
      logout,
      selectExercise,
      refresh,
    }),
    [ready, inspector, exercise, login, logout, selectExercise, refresh],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext)
  if (!ctx) throw new Error('useSession must be used inside SessionProvider')
  return ctx
}

/** Tracks navigator.onLine, which drives the sync badge and auto-sync. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}
