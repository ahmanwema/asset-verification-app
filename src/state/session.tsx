import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { db, getMeta, setMeta } from '../db/db'
import { sha256 } from '../lib/hash'
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

  const login = useCallback(async (email: string, password: string) => {
    const normalized = email.trim().toLowerCase()
    const all = await db.inspectors.toArray()
    const found = all.find((i) => i.email.toLowerCase() === normalized && i.active)
    if (!found) return false
    const hash = await sha256(password)
    if (found.passwordHash && found.passwordHash !== hash) return false
    if (!found.passwordHash) return false
    try {
      localStorage.setItem(SESSION_KEY, found.id)
    } catch {
      /* ignore */
    }
    setInspector(found)
    return true
  }, [])

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
