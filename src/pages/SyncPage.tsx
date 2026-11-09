import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, getMeta } from '../db/db'
import { lastSyncError, loadSyncState, login as serverLogin, logoutSync, setServerUrl, syncNow } from '../lib/sync'
import { resolveConflict } from '../lib/entries'
import { formatBytes, storageEstimate } from '../lib/photos'
import { useOnline, useSession } from '../state/session'
import { useT } from '../i18n'
import { Button, Card, Field, SectionTitle, TextInput, Toast } from '../components/ui'
import type { InspectionEntry } from '../types'

export default function SyncPage() {
  const t = useT()
  const online = useOnline()
  const { inspector } = useSession()
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const lastError = useLiveQuery(() => lastSyncError(), [])
  const [urlDraft, setUrlDraft] = useState<string | null>(null)
  const [email, setEmail] = useState(inspector?.email ?? '')
  const [password, setPassword] = useState('')
  const [tick, setTick] = useState(0)

  const state = useLiveQuery(async () => {
    void tick // re-read after a sync run, which writes meta rather than a table
    return loadSyncState()
  }, [tick])

  const lastSyncAt = useLiveQuery(async () => {
    void tick
    return getMeta<number>('lastSyncAt', 0)
  }, [tick])

  const storage = useLiveQuery(async () => storageEstimate(), [tick])

  const conflicts = useLiveQuery(
    async () => db.entries.where('syncStatus').equals('conflict').toArray(),
    [],
  )

  const names = useLiveQuery(async () => {
    const all = await db.inspectors.toArray()
    return new Map(all.map((i) => [i.id, i.name]))
  }, [])

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 2600)
  }

  async function connect() {
    setBusy(true)
    try {
      const ok = await serverLogin(email, password)
      setPassword('')
      flash(ok ? t('sync.ok') : t('login.error'))
      setTick((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }

  async function run() {
    setBusy(true)
    try {
      const res = await syncNow()
      if (res.ok) {
        flash(`${t('sync.ok')} · ${t('sync.pushed', { n: res.pushed })} · ${t('sync.pulled', { n: res.pulled })}`)
      } else {
        flash(`${t('sync.failed')}: ${res.error ?? ''}`)
      }
      setTick((n) => n + 1)
    } finally {
      setBusy(false)
    }
  }

  async function saveUrl() {
    if (urlDraft === null) return
    await setServerUrl(urlDraft)
    setUrlDraft(null)
    setTick((n) => n + 1)
    flash(t('common.save'))
  }

  const connected = Boolean(state?.token)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-slate-900">{t('nav.sync')}</h1>
        <p className="text-xs text-slate-500">{online ? t('common.online') : t('common.offline')}</p>
      </div>

      <Card className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-sm font-semibold text-slate-800">
              {state && state.pendingRecords + state.pendingPhotos > 0
                ? t('sync.pending', { n: state.pendingRecords })
                : t('sync.pendingNone')}
            </p>
            <p className="text-xs text-slate-500">
              {lastSyncAt ? t('sync.lastSynced', { when: new Date(lastSyncAt).toLocaleString() }) : t('sync.never')}
            </p>
            {state && state.pendingPhotos > 0 && (
              <p className="text-xs text-slate-500">{t('sync.photosPending', { n: state.pendingPhotos })}</p>
            )}
          </div>
          <span
            className={`chip ${
              state && state.pendingRecords + state.pendingPhotos > 0
                ? 'bg-amber-100 text-amber-800'
                : 'bg-emerald-100 text-emerald-800'
            }`}
          >
            {(state?.pendingRecords ?? 0) + (state?.pendingPhotos ?? 0)}
          </span>
        </div>

        <Button full onClick={() => void run()} disabled={busy || !online || !connected}>
          {busy ? t('sync.syncing') : t('sync.now')}
        </Button>

        {lastError && (
          <p className="rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">
            {t('sync.lastFailed')}: {lastError}
          </p>
        )}
        {/* Losing the token cuts a device off silently: the automatic sync
            gives up before it starts and the button above is disabled, while
            work piles up locally. Say so plainly, and say what to do. */}
        {!connected && (
          <div className="rounded-xl bg-amber-50 p-3">
            <p className="text-sm font-bold text-amber-900">{t('sync.notConnected')}</p>
            <p className="mt-0.5 text-xs text-amber-800">
              {(state?.pendingRecords ?? 0) + (state?.pendingPhotos ?? 0) > 0
                ? t('sync.notConnectedPending', {
                    n: (state?.pendingRecords ?? 0) + (state?.pendingPhotos ?? 0),
                  })
                : t('sync.notConnectedHint')}
            </p>
          </div>
        )}
        {!online && <p className="text-xs text-slate-500">{t('sync.offlineHint')}</p>}
      </Card>

      <SectionTitle>{t('sync.serverUrl')}</SectionTitle>
      <Card className="space-y-3 p-4">
        <Field label={t('sync.serverUrl')} hint="/api or http://192.168.1.50:4000/api">
          <TextInput
            value={urlDraft ?? state?.serverUrl ?? ''}
            onChange={(e) => setUrlDraft(e.target.value)}
            inputMode="url"
            autoCapitalize="none"
          />
        </Field>
        {urlDraft !== null && (
          <Button variant="secondary" full onClick={() => void saveUrl()}>
            {t('common.save')}
          </Button>
        )}

        {connected ? (
          <Button
            variant="secondary"
            full
            onClick={async () => {
              await logoutSync()
              setTick((n) => n + 1)
            }}
          >
            {t('login.logout')}
          </Button>
        ) : (
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <Field label={t('login.email')}>
              <TextInput value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" />
            </Field>
            <Field label={t('login.password')}>
              <TextInput type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Button full onClick={() => void connect()} disabled={busy || !online}>
              {t('login.submit')}
            </Button>
          </div>
        )}
      </Card>

      <SectionTitle>{t('sync.conflicts')}</SectionTitle>
      {conflicts && conflicts.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-600">{t('sync.conflictExplain')}</p>
          {conflicts.map((e) => (
            <ConflictCard key={e.id} entry={e} names={names} onResolved={() => setTick((n) => n + 1)} />
          ))}
        </div>
      ) : (
        <Card className="px-4 py-3 text-sm text-slate-500">{t('sync.conflictsNone')}</Card>
      )}

      {storage && (
        <p className="text-xs text-slate-500">
          {t('setup.storage')}: {formatBytes(storage.usage)}
          {storage.quota > 0 && ` / ${formatBytes(storage.quota)}`}
        </p>
      )}

      <Toast message={toast} />
    </div>
  )
}

function ConflictCard({
  entry,
  names,
  onResolved,
}: {
  entry: InspectionEntry
  names?: Map<string, string>
  onResolved: () => void
}) {
  const t = useT()
  const theirs = entry.conflictWith
  const room = useLiveQuery(() => db.rooms.get(entry.roomId), [entry.roomId])
  const assetType = useLiveQuery(
    async () => (entry.assetTypeId ? db.assetTypes.get(entry.assetTypeId) : undefined),
    [entry.assetTypeId],
  )

  const label = entry.isUnlistedItem ? (entry.unlistedItemName ?? '—') : (assetType?.name ?? '—')

  return (
    <Card className="space-y-3 p-4">
      <div>
        <p className="font-semibold text-slate-900">{label}</p>
        <p className="text-xs text-slate-500">{room?.name}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-xl border-2 border-brand-600 bg-brand-50 p-2">
          <p className="mb-1 font-bold text-brand-800">{t('sync.keepMine')}</p>
          <p className="font-bold tabular-nums">
            {entry.quantity}× {t(`condition.${entry.condition}`)}
          </p>
          <p className="text-slate-600">{names?.get(entry.inspectorId) ?? ''}</p>
          <p className="text-slate-500">{new Date(entry.updatedAt).toLocaleString()}</p>
        </div>
        <div className="rounded-xl border border-slate-300 bg-slate-50 p-2">
          <p className="mb-1 font-bold text-slate-700">{t('sync.keepTheirs')}</p>
          {theirs ? (
            <>
              <p className="font-bold tabular-nums">
                {theirs.quantity}× {t(`condition.${theirs.condition}`)}
              </p>
              <p className="text-slate-600">{names?.get(theirs.inspectorId) ?? ''}</p>
              <p className="text-slate-500">{new Date(theirs.updatedAt).toLocaleString()}</p>
            </>
          ) : (
            <p className="text-slate-500">—</p>
          )}
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          variant="secondary"
          full
          onClick={async () => {
            await resolveConflict(entry.id, 'mine')
            onResolved()
          }}
        >
          {t('sync.keepMine')}
        </Button>
        <Button
          variant="secondary"
          full
          onClick={async () => {
            await resolveConflict(entry.id, 'theirs')
            onResolved()
          }}
        >
          {t('sync.keepTheirs')}
        </Button>
      </div>
    </Card>
  )
}
