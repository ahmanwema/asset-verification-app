import { useEffect, useState } from 'react'
import { setMeta } from '../db/db'
import { startFresh } from '../db/seed'
import { useI18n, useT } from '../i18n'
import { useSession } from '../state/session'
import { ACTIVE_ORG_KEY, inviteInfo, joinWithInvite, setToken, syncNow, type InviteInfo } from '../lib/sync'
import { Button, Field, TextInput } from '../components/ui'
import type { StringKey } from '../i18n/strings'

/** Server error codes mapped to something the person opening the link can act on. */
const ERRORS: Record<string, StringKey> = {
  'name-required': 'register.errName',
  'email-invalid': 'register.errEmail',
  'password-too-short': 'register.errPassword',
  'email-taken': 'register.errEmailTaken',
  'invite-not-found': 'invite.errNotFound',
  'invite-revoked': 'invite.errRevoked',
  'invite-expired': 'invite.errExpired',
  'invite-used-up': 'invite.errUsedUp',
  'database-not-configured': 'register.errServer',
  offline: 'register.errOffline',
}

const MIN_PASSWORD = 8

/**
 * Account creation from an invite link. Unlike registering, this joins an
 * institution that already exists: the link decides which one and in what
 * role, so neither is asked for here.
 */
export default function JoinPage({ token, onBack }: { token: string; onBack: () => void }) {
  const t = useT()
  const { lang, setLang } = useI18n()
  const { login, refresh } = useSession()

  const [info, setInfo] = useState<InviteInfo | null | undefined>(undefined)
  const [inviteError, setInviteError] = useState<StringKey | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<StringKey | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void inviteInfo(token).then((result) => {
      if (cancelled) return
      if (result.ok) setInfo(result.info)
      else {
        setInfo(null)
        setInviteError(ERRORS[result.error] ?? 'invite.errNotFound')
      }
    })
    return () => {
      cancelled = true
    }
  }, [token])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!name.trim() || !email.trim()) return setError('common.required')
    if (password.length < MIN_PASSWORD) return setError('register.errPassword')
    if (password !== confirm) return setError('register.errMismatch')

    setBusy(true)
    const res = await joinWithInvite({ token, name, email, password })
    if (!res.ok) {
      setError(ERRORS[res.error] ?? 'invite.errFailed')
      setBusy(false)
      return
    }

    // Same order as registering: the wipe clears any stored token, so the new
    // one is written afterwards and only then is the institution pulled down.
    await startFresh()
    await setToken(res.token)
    await setMeta(ACTIVE_ORG_KEY, res.organization.id)
    await setMeta('syncServerUrl', '/api')
    await syncNow()

    const ok = await login(email, password)
    if (!ok) {
      setError('invite.errFailed')
      setBusy(false)
      return
    }
    await refresh()
    setBusy(false)
  }

  return (
    <div className="flex min-h-screen flex-col justify-center bg-slate-100 px-4 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-bold text-slate-900">{t('invite.joinTitle')}</h1>
          {info && (
            <>
              <p className="mt-1 text-base font-bold text-brand-800">{info.organization.name}</p>
              <p className="mt-1 text-sm text-slate-500">
                {t('invite.joinAs', { role: t(`setup.role.${info.role}` as StringKey) })}
              </p>
            </>
          )}
        </div>

        {info === undefined && <p className="text-center text-sm text-slate-500">{t('common.loading')}</p>}

        {info === null && (
          <div className="card space-y-4 p-5 text-center">
            <p className="text-sm font-semibold text-red-600">{t(inviteError ?? 'invite.errNotFound')}</p>
            <p className="text-sm text-slate-500">{t('invite.errAskAdmin')}</p>
            <button type="button" onClick={onBack} className="w-full text-sm font-semibold text-brand-700">
              {t('register.haveAccount')}
            </button>
          </div>
        )}

        {info && (
          <form onSubmit={submit} className="card space-y-4 p-5">
            <Field label={t('register.yourName')}>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />
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
              {busy ? t('register.working') : t('invite.joinSubmit')}
            </Button>

            <button type="button" onClick={onBack} className="w-full text-sm font-semibold text-brand-700">
              {t('register.haveAccount')}
            </button>
          </form>
        )}

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
