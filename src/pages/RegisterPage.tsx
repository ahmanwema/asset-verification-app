import { useState } from 'react'
import { setMeta } from '../db/db'
import { startFresh } from '../db/seed'
import { useI18n, useT } from '../i18n'
import { useSession } from '../state/session'
import { registerOrganization, setToken, syncNow } from '../lib/sync'
import { Button, Field, TextArea, TextInput } from '../components/ui'
import type { StringKey } from '../i18n/strings'

/** Server error codes mapped to something an administrator can act on. */
const ERRORS: Record<string, StringKey> = {
  'org-name-required': 'register.errOrgName',
  'name-required': 'register.errName',
  'email-invalid': 'register.errEmail',
  'password-too-short': 'register.errPassword',
  'email-taken': 'register.errEmailTaken',
  'database-not-configured': 'register.errServer',
  offline: 'register.errOffline',
}

const MIN_PASSWORD = 8

export default function RegisterPage({ onBack }: { onBack: () => void }) {
  const t = useT()
  const { lang, setLang } = useI18n()
  const { login, refresh } = useSession()

  const [orgName, setOrgName] = useState('')
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<StringKey | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!orgName.trim() || !name.trim() || !email.trim()) return setError('common.required')
    if (password.length < MIN_PASSWORD) return setError('register.errPassword')
    if (password !== confirm) return setError('register.errMismatch')

    setBusy(true)
    const res = await registerOrganization({ orgName, address, name, email, password })
    if (!res.ok) {
      setError(ERRORS[res.error] ?? 'register.errFailed')
      setBusy(false)
      return
    }

    // Order matters. Wiping the device clears the sample exercise *and* any
    // stored token, so the token is written afterwards, and only then is the
    // new organization pulled down.
    await startFresh()
    await setToken(res.token)
    await setMeta('syncServerUrl', '/api')
    await syncNow()

    // The inspector record arrives with the same password hash the offline
    // path checks, so this signs in locally and keeps working with no signal.
    const ok = await login(email, password)
    if (!ok) {
      setError('register.errFailed')
      setBusy(false)
      return
    }

    // The session read its exercise when the app mounted, before any of this
    // existed. Without this the new institution is only picked up on the next
    // reload, and the app opens with no active exercise.
    await refresh()
    setBusy(false)
  }

  return (
    <div className="flex min-h-screen flex-col justify-center bg-slate-100 px-4 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-slate-900">{t('register.title')}</h1>
          <p className="mt-1 text-sm text-slate-500">{t('register.subtitle')}</p>
        </div>

        <form onSubmit={submit} className="card space-y-4 p-5">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">{t('register.sectionOrg')}</p>

          <Field label={t('register.orgName')}>
            <TextInput value={orgName} onChange={(e) => setOrgName(e.target.value)} autoFocus />
          </Field>
          <Field label={t('register.address')} hint={t('common.optional')}>
            <TextArea rows={2} value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>

          <p className="border-t border-slate-100 pt-4 text-xs font-bold uppercase tracking-wide text-slate-400">
            {t('register.sectionAdmin')}
          </p>

          <Field label={t('register.yourName')}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
          <Field label={t('login.email')}>
            <TextInput
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
          </Field>
          <Field label={t('login.password')} hint={t('register.passwordHint')}>
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </Field>
          <Field label={t('register.confirmPassword')}>
            <TextInput
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          </Field>

          {error && <p className="text-sm font-semibold text-red-600">{t(error)}</p>}

          <Button type="submit" full disabled={busy}>
            {busy ? t('register.working') : t('register.submit')}
          </Button>

          <button type="button" onClick={onBack} className="w-full text-sm font-semibold text-brand-700">
            {t('register.haveAccount')}
          </button>
        </form>

        <div className="mt-4 text-center">
          <button
            type="button"
            onClick={() => setLang(lang === 'en' ? 'sw' : 'en')}
            className="rounded-lg border border-slate-300 px-3 py-1 text-xs font-bold uppercase text-slate-600"
          >
            {lang === 'en' ? 'Kiswahili' : 'English'}
          </button>
        </div>
      </div>
    </div>
  )
}
