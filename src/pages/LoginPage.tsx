import { useState } from 'react'
import { useI18n, useT } from '../i18n'
import { useOnline, useSession } from '../state/session'
import { SEED_PASSWORD } from '../db/seed'
import { login as serverLogin } from '../lib/sync'
import { Button, Field, TextInput } from '../components/ui'

export default function LoginPage() {
  const t = useT()
  const { lang, setLang } = useI18n()
  const { login } = useSession()
  const online = useOnline()
  const [email, setEmail] = useState('admin@sufa.ac.tz')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(false)
    const ok = await login(email, password)
    if (!ok) {
      setError(true)
      setBusy(false)
      return
    }
    // Grab a sync token while we still hold the plaintext password and have signal.
    if (online) void serverLogin(email, password)
    setBusy(false)
  }

  return (
    <div className="flex min-h-screen flex-col justify-center bg-slate-100 px-4 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-700 text-white shadow-lg">
            <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 11l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M20 12v7a1 1 0 01-1 1H5a1 1 0 01-1-1V5a1 1 0 011-1h9" strokeLinecap="round" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-900">{t('app.title')}</h1>
          <p className="text-sm text-slate-500">{t('app.subtitle')}</p>
        </div>

        <form onSubmit={submit} className="card space-y-3 p-4">
          <Field label={t('login.email')}>
            <TextInput
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </Field>
          <Field label={t('login.password')} error={error ? t('login.error') : undefined}>
            <TextInput
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <Button type="submit" full disabled={busy}>
            {busy ? t('common.loading') : t('login.submit')}
          </Button>
        </form>

        <p className="mt-4 text-center text-xs text-slate-500">
          {t('login.hint')} <code className="rounded bg-slate-200 px-1 font-semibold">{SEED_PASSWORD}</code>
        </p>
        <p className="mt-1 text-center text-xs text-slate-400">{t('login.offlineNote')}</p>

        <div className="mt-6 text-center">
          <button
            type="button"
            onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-bold uppercase text-slate-600"
          >
            {lang === 'en' ? 'Kiswahili' : 'English'}
          </button>
        </div>
      </div>
    </div>
  )
}
