import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { dictionaries, type StringKey } from './strings'
import type { Lang } from '../types'

const LANG_KEY = 'av.lang'

export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string

interface I18nValue {
  lang: Lang
  setLang: (l: Lang) => void
  t: Translate
}

const I18nContext = createContext<I18nValue | null>(null)

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vars ? String(vars[k]) : `{${k}}`))
}

function initialLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY)
    if (stored === 'en' || stored === 'sw') return stored
  } catch {
    /* storage can be blocked; fall through to the default */
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('sw') ? 'sw' : 'en'
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang)

  useEffect(() => {
    document.documentElement.lang = lang
    try {
      localStorage.setItem(LANG_KEY, lang)
    } catch {
      /* ignore */
    }
  }, [lang])

  const t = useCallback<Translate>(
    (key, vars) => {
      const dict = dictionaries[lang] as Record<string, string>
      const fallback = dictionaries.en as Record<string, string>
      return interpolate(dict[key] ?? fallback[key] ?? key, vars)
    },
    [lang],
  )

  const value = useMemo<I18nValue>(() => ({ lang, setLang: setLangState, t }), [lang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider')
  return ctx
}

export function useT(): Translate {
  return useI18n().t
}

/** Asset type names carry an optional Swahili label; fall back to English. */
export function assetName(lang: Lang, name: string, nameSw?: string): string {
  return lang === 'sw' && nameSw ? nameSw : name
}
