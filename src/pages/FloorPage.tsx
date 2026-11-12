import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { loadFloorProgress } from '../lib/queries'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { EmptyState, ProgressBar, STATUS_STYLE, SectionTitle, TextInput } from '../components/ui'

export default function FloorPage() {
  const { floorId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const blockFilter = searchParams.get('block')
  const t = useT()
  const { exercise } = useSession()
  const [search, setSearch] = useState('')

  const floor = useLiveQuery(() => db.floors.get(floorId), [floorId])
  const blocks = useLiveQuery(async () => {
    if (!exercise) return []
    return (await db.blocks.where('exerciseId').equals(exercise.id).toArray()).filter((block) => !block.deleted)
  }, [exercise?.id])
  const progress = useLiveQuery(async () => {
    if (!exercise) return undefined
    const all = await loadFloorProgress(exercise.id)
    return all.find((f) => f.floor.id === floorId)
  }, [exercise?.id, floorId])

  if (!floor) return <EmptyState title={t('common.empty')} />

  const knownBlockIds = new Set(blocks?.map((block) => block.id) ?? [])
  const scopedRooms = (progress?.rooms ?? []).filter((rp) => {
    if (!blockFilter) return true
    const effectiveBlockId = rp.room.blockId ?? floor.blockId ?? ''
    if (blockFilter === 'unassigned') return !effectiveBlockId || !knownBlockIds.has(effectiveBlockId)
    return effectiveBlockId === blockFilter
  })
  const scopedDone = scopedRooms.filter((room) => room.status === 'done').length
  const scopedInProgress = scopedRooms.filter((room) => room.status === 'in_progress').length
  const scopedNotStarted = scopedRooms.filter((room) => room.status === 'not_started').length
  const blockName = blockFilter && blockFilter !== 'unassigned'
    ? blocks?.find((block) => block.id === blockFilter)?.name
    : blockFilter === 'unassigned' ? t('setup.unassignedBlock') : undefined

  const needle = search.trim().toLocaleLowerCase()
  const visibleRooms = scopedRooms.filter((rp) => {
    if (!needle) return true
    return `${rp.room.name} ${rp.room.code}`.toLocaleLowerCase().includes(needle)
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link to="/inspect" className="btn-ghost px-2" aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold text-slate-900">{floor.name}</h1>
          {blockName && <p className="truncate text-xs font-semibold text-brand-700">{blockName}</p>}
          <p className="text-xs text-slate-500">{progress ? `${scopedDone}/${scopedRooms.length} ${t('common.rooms')}` : ''}</p>
        </div>
      </div>

      {progress && (
        <div className="card px-4 py-3">
          <ProgressBar value={scopedDone} total={scopedRooms.length} />
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] font-semibold">
            <span className={`chip ${STATUS_STYLE.done.chip}`}>
              {t('status.done')} {scopedDone}
            </span>
            <span className={`chip ${STATUS_STYLE.in_progress.chip}`}>
              {t('status.in_progress')} {scopedInProgress}
            </span>
            <span className={`chip ${STATUS_STYLE.not_started.chip}`}>
              {t('status.not_started')} {scopedNotStarted}
            </span>
          </div>
        </div>
      )}

      <SectionTitle>{t('room.pickRoom')}</SectionTitle>

      <TextInput
        type="search"
        aria-label={t('room.search')}
        placeholder={t('room.searchPlaceholder')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {visibleRooms.map((rp) => (
          <Link
            key={rp.room.id}
            to={`/room/${rp.room.id}`}
            className={`flex min-h-[92px] flex-col justify-between rounded-2xl border-2 p-3 shadow-sm transition active:scale-[0.98] ${
              STATUS_STYLE[rp.status].grid
            }`}
          >
            <div className="flex items-start justify-between gap-1">
              <span className="text-sm font-bold leading-tight">{rp.room.name}</span>
              {rp.hasConflict && <span className="text-xs font-bold text-red-600">!</span>}
            </div>
            <div>
              <p className="text-[11px] font-semibold opacity-80">
                {t('room.progress', { done: rp.checked, total: rp.total })}
              </p>
              <p className="text-[11px] opacity-70">{t('room.itemsFound', { n: rp.itemsFound })}</p>
            </div>
          </Link>
        ))}
      </div>
      {progress && visibleRooms.length === 0 && (
        <EmptyState title={t('common.noResults')} hint={t('room.searchHint')} />
      )}
    </div>
  )
}
