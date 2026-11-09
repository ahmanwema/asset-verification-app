import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { calculateDepreciation, financialRecordComplete, financialRecordFor } from '../lib/depreciation'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { Card, EmptyState, Field, Select, StatTile, TextInput } from '../components/ui'

type CompletionFilter = 'all' | 'complete' | 'missing'

function money(value: number): string {
  return new Intl.NumberFormat('en-TZ', { maximumFractionDigits: 0 }).format(Math.round(value))
}

export default function FinanceRegisterPage() {
  const t = useT()
  const { exercise } = useSession()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<CompletionFilter>('all')

  const data = useLiveQuery(async () => {
    if (!exercise) return undefined
    const [entries, rooms, floors, types] = await Promise.all([
      db.entries.where('exerciseId').equals(exercise.id).toArray(),
      db.rooms.where('exerciseId').equals(exercise.id).toArray(),
      db.floors.where('exerciseId').equals(exercise.id).toArray(),
      db.assetTypes.toArray(),
    ])
    const roomById = new Map(rooms.map((room) => [room.id, room]))
    const floorById = new Map(floors.map((floor) => [floor.id, floor]))
    const typeById = new Map(types.map((type) => [type.id, type]))
    return entries
      .filter((entry) => !entry.deleted && !entry.notPresent)
      .flatMap((entry) => {
        const room = roomById.get(entry.roomId)
        const floor = room ? floorById.get(room.floorId) : undefined
        const name = entry.isUnlistedItem
          ? (entry.unlistedItemName ?? t('entry.unlisted'))
          : (typeById.get(entry.assetTypeId ?? '')?.name ?? t('asset.unknown'))
        return entry.tagNumbers.map((tag, index) => {
          const record = financialRecordFor(entry, tag)
          const result = calculateDepreciation(record, exercise.date)
          return {
            entryId: entry.id,
            tag,
            name,
            serial: entry.serialNumbers[index] ?? entry.serialNumbers[0] ?? '',
            room: room?.name ?? '',
            floor: floor?.name ?? '',
            record,
            result,
            complete: financialRecordComplete(record),
          }
        })
      })
      .sort((a, b) => a.tag.localeCompare(b.tag))
  }, [exercise?.id, exercise?.date, t])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (data ?? []).filter((asset) => {
      if (status === 'complete' && !asset.complete) return false
      if (status === 'missing' && asset.complete) return false
      return !q || [asset.tag, asset.name, asset.serial, asset.room, asset.floor].some((v) => v.toLowerCase().includes(q))
    })
  }, [data, query, status])

  if (!exercise) return <EmptyState title={t('common.empty')} />
  const complete = (data ?? []).filter((asset) => asset.complete).length
  const totalCost = (data ?? []).reduce((sum, asset) => sum + (asset.complete ? (asset.record?.originalCost ?? 0) : 0), 0)
  const totalBookValue = (data ?? []).reduce((sum, asset) => sum + (asset.complete ? asset.result.carryingAmount : 0), 0)

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-2">
        <Link to="/reports" className="btn-ghost px-2" aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div>
          <h1 className="text-lg font-bold text-slate-900">{t('finance.title')}</h1>
          <p className="text-xs text-slate-500">{t('finance.asAt', { date: exercise.date })}</p>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <StatTile label={t('finance.completed')} value={`${complete}/${data?.length ?? 0}`} tone={complete === data?.length ? 'brand' : 'warn'} />
        <StatTile label={t('finance.totalCost')} value={money(totalCost)} />
        <StatTile label={t('finance.netBookValue')} value={money(totalBookValue)} tone="brand" />
      </div>

      <Card className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label={t('common.search')}>
          <TextInput type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('finance.searchHint')} />
        </Field>
        <Field label={t('common.status')}>
          <Select value={status} onChange={(event) => setStatus(event.target.value as CompletionFilter)}>
            <option value="all">{t('finance.allAssets')}</option>
            <option value="missing">{t('finance.missing')}</option>
            <option value="complete">{t('finance.complete')}</option>
          </Select>
        </Field>
      </Card>

      <p className="text-xs font-semibold text-slate-500">{t('finance.showing', { n: filtered.length })}</p>

      {data === undefined ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : filtered.length === 0 ? (
        <EmptyState title={t('reports.noMatch')} />
      ) : (
        <Card className="divide-y divide-slate-100 p-0">
          {filtered.map((asset) => (
            <Link
              key={`${asset.entryId}|${asset.tag}`}
              to={`/asset/${asset.entryId}/finance?tag=${encodeURIComponent(asset.tag)}`}
              className="flex items-center gap-3 px-4 py-3 active:bg-slate-50"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-bold text-slate-900">{asset.tag}</span>
                  <span className={`chip ${asset.complete ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
                    {asset.complete ? t('finance.complete') : t('finance.missing')}
                  </span>
                </div>
                <p className="truncate text-sm font-semibold text-slate-800">{asset.name}</p>
                <p className="truncate text-xs text-slate-500">{asset.floor} / {asset.room}{asset.serial ? ` · ${asset.serial}` : ''}</p>
              </div>
              {asset.complete && (
                <div className="shrink-0 text-right">
                  <p className="text-[10px] font-bold uppercase text-slate-400">{t('finance.netBookValue')}</p>
                  <p className="text-sm font-bold tabular-nums text-brand-700">{money(asset.result.carryingAmount)}</p>
                </div>
              )}
              <span className="text-slate-300">›</span>
            </Link>
          ))}
        </Card>
      )}
    </div>
  )
}
