import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { photoBlob } from '../lib/photos'
import { entryConditionCounts } from '../lib/queries'
import { EDIT_FIELD_LABEL } from '../lib/entries'
import { ensureEntryPhotos, resyncEverything } from '../lib/sync'
import { calculateDepreciation, financialRecordFor } from '../lib/depreciation'
import { useOnline, useSession } from '../state/session'
import { useT } from '../i18n'
import { CONDITIONS } from '../types'
import { CONDITION_STYLE, Card, EmptyState } from '../components/ui'

export default function AssetPage() {
  const { entryId = '' } = useParams()
  const [search] = useSearchParams()
  const requestedTag = search.get('tag') ?? ''
  const t = useT()
  const online = useOnline()
  const { exercise, selectExercise, isAdmin } = useSession()
  const repairAttempt = useRef('')
  const [repairing, setRepairing] = useState(false)

  const data = useLiveQuery(async () => {
    const entry = await db.entries.get(entryId)
    if (!entry || entry.deleted) return null
    const room = await db.rooms.get(entry.roomId)
    const [floor, assetType, entryExercise, inspectors] = await Promise.all([
      room ? db.floors.get(room.floorId) : undefined,
      entry.assetTypeId ? db.assetTypes.get(entry.assetTypeId) : undefined,
      db.exercises.get(entry.exerciseId),
      db.inspectors.toArray(),
    ])
    const organization = entryExercise ? await db.organizations.get(entryExercise.orgId) : undefined
    return { entry, room, floor, assetType, entryExercise, organization, inspectors }
  }, [entryId])

  // A phone opening a QR for the first time may not hold this entry yet. Pull
  // the authenticated organization's records once; the live query above will
  // rerun as soon as the entry lands locally.
  useEffect(() => {
    if (data !== null || repairAttempt.current === entryId || !online) return
    repairAttempt.current = entryId
    setRepairing(true)
    void resyncEverything().finally(() => setRepairing(false))
  }, [data, entryId, online])

  useEffect(() => {
    if (!data?.entry || exercise?.id === data.entry.exerciseId) return
    void selectExercise(data.entry.exerciseId)
  }, [data?.entry.exerciseId, exercise?.id, selectExercise])

  useEffect(() => {
    if (!data?.entry) return
    void ensureEntryPhotos(data.entry.id)
  }, [data?.entry.id])

  const photos = useLiveQuery(
    async () => (data?.entry ? db.photos.where('entryId').equals(data.entry.id).toArray() : []),
    [data?.entry.id],
  )
  const photoUrls = useMemo(
    () => (photos ?? []).map((photo) => ({ id: photo.id, url: URL.createObjectURL(photoBlob(photo)) })),
    [photos],
  )
  useEffect(() => () => photoUrls.forEach((photo) => URL.revokeObjectURL(photo.url)), [photoUrls])

  if (data === undefined || repairing) {
    return <p className="py-10 text-center text-sm text-slate-500">{t('asset.loading')}</p>
  }

  if (data === null) {
    return (
      <EmptyState
        title={t('asset.notFound')}
        hint={online ? t('asset.notFoundHint') : t('sync.offlineHint')}
        action={<Link to="/labels" className="btn-secondary">{t('nav.labels')}</Link>}
      />
    )
  }

  const { entry, room, floor, assetType, entryExercise, organization, inspectors } = data
  const whoById = new Map(inspectors.map((person) => [person.id, person.name]))
  const description = entry.isUnlistedItem
    ? (entry.unlistedItemName ?? t('entry.unlisted'))
    : (assetType?.name ?? t('asset.unknown'))
  const tag = entry.tagNumbers.includes(requestedTag) ? requestedTag : (entry.tagNumbers[0] ?? requestedTag)
  const tagIndex = entry.tagNumbers.indexOf(tag)
  const serial = tagIndex >= 0 ? (entry.serialNumbers[tagIndex] ?? '') : ''
  const conditionCounts = entryConditionCounts(entry)
  const financialRecord = financialRecordFor(entry, tag)
  const financial = calculateDepreciation(financialRecord, entryExercise?.date ?? new Date().toISOString().slice(0, 10))
  const details = [
    [t('entry.serial'), serial],
    [t('entry.brand'), entry.brand],
    [t('entry.model'), entry.model],
    [t('entry.specificPosition'), entry.specificPosition],
    [t('entry.description'), entry.description],
    [t('entry.remarks'), entry.remarks],
  ].filter((row): row is [string, string] => Boolean(row[1]))

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-2">
        <Link to="/labels" className="btn-ghost px-2" aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold uppercase tracking-wide text-brand-700">
            {organization?.name}
          </p>
          <h1 className="truncate text-lg font-bold text-slate-900">{description}</h1>
          <p className="font-mono text-sm font-bold text-slate-700">{tag || t('entry.tag')}</p>
        </div>
      </div>

      <Card className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Info label={t('common.floor')} value={floor?.name ?? '—'} />
          <Info label={t('common.room')} value={room?.name ?? '—'} />
          <Info label={t('entry.quantity')} value={String(entry.quantity)} />
          <Info label={t('asset.verifiedOn')} value={new Date(entry.inspectedAt).toLocaleString()} />
        </div>

        <div className="border-t border-slate-100 pt-3">
          <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
            {t('entry.condition')}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {CONDITIONS.filter((condition) => (conditionCounts[condition] ?? 0) > 0).map((condition) => (
              <span key={condition} className={`chip ${CONDITION_STYLE[condition].chip}`}>
                {t(`condition.${condition}`)} · {conditionCounts[condition]}
              </span>
            ))}
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">{t('history.itemTitle')}</h2>
        <div className="mt-3 border-l-2 border-brand-100 pl-3">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
            {t('history.recordedBy')}
          </p>
          <p className="mt-0.5 text-sm font-semibold text-slate-800">
            {whoById.get(entry.inspectorId) ?? t('common.inspector')}
          </p>
          <p className="text-xs text-slate-400">{new Date(entry.inspectedAt).toLocaleString()}</p>
        </div>

        {(entry.editHistory ?? []).length === 0 ? (
          <p className="mt-3 text-xs text-slate-400">{t('history.noEdits')}</p>
        ) : (
          <ol className="mt-3 space-y-3 border-t border-slate-100 pt-3">
            {[...(entry.editHistory ?? [])].reverse().map((change, index) => (
              <li key={`${change.editedAt}-${change.field}-${index}`} className="border-l-2 border-slate-200 pl-3 text-xs">
                <p className="font-bold text-slate-700">{EDIT_FIELD_LABEL[change.field] ?? change.field}</p>
                <p className="mt-0.5 text-slate-600">
                  <span className="text-slate-400 line-through">{change.oldValue || '—'}</span>
                  <span aria-hidden="true"> → </span>
                  <span className="font-semibold text-slate-900">{change.newValue || '—'}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-slate-400">
                  {t('history.editedBy')}: {whoById.get(change.editedBy) ?? t('common.inspector')} ·{' '}
                  {new Date(change.editedAt).toLocaleString()}
                </p>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {(isAdmin || financial.complete) && (
        <Card className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">{t('finance.assetDetails')}</h2>
              <p className="text-xs text-slate-500">
                {financial.complete ? t('finance.asAt', { date: entryExercise?.date ?? '' }) : t('finance.notCaptured')}
              </p>
            </div>
            <Link to={`/asset/${entry.id}/finance?tag=${encodeURIComponent(tag)}`} className="btn-secondary shrink-0 px-3">
              {financial.complete ? t('reports.view') : t('finance.addDetails')}
            </Link>
          </div>
          {financial.complete && financialRecord && (
            <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3 text-sm sm:grid-cols-4">
              <Info label={t('finance.originalCost')} value={financialRecord.originalCost.toLocaleString('en-TZ')} />
              <Info label={t('finance.accumulatedDepreciation')} value={Math.round(financial.accumulatedDepreciation).toLocaleString('en-TZ')} />
              <Info label={t('finance.netBookValue')} value={Math.round(financial.carryingAmount).toLocaleString('en-TZ')} />
              <Info label={t('finance.availableDate')} value={financialRecord.availableForUseDate} />
            </div>
          )}
        </Card>
      )}

      <section>
        <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-slate-500">{t('asset.photos')}</h2>
        {photos === undefined ? (
          <p className="text-sm text-slate-500">{t('common.loading')}</p>
        ) : photoUrls.length === 0 ? (
          <Card className="p-5 text-center text-sm text-slate-500">{t('labels.noPhoto')}</Card>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {photoUrls.map((photo) => (
              <a key={photo.id} href={photo.url} target="_blank" rel="noreferrer">
                <img src={photo.url} alt={description} className="aspect-square w-full rounded-2xl object-cover shadow-sm" />
              </a>
            ))}
          </div>
        )}
      </section>

      {details.length > 0 && (
        <Card className="divide-y divide-slate-100 p-0">
          {details.map(([label, value]) => (
            <div key={label} className="px-4 py-3">
              <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-0.5 text-sm text-slate-800">{value}</p>
            </div>
          ))}
        </Card>
      )}

      {entryExercise && <p className="text-center text-xs text-slate-400">{entryExercise.name}</p>}
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-0.5 font-semibold text-slate-800">{value}</p>
    </div>
  )
}
