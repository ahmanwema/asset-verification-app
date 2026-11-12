import { Link, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { loadFloorProgress } from '../lib/queries'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { EmptyState, ProgressBar, SectionTitle } from '../components/ui'

export default function InspectPage() {
  const t = useT()
  const { exercise } = useSession()
  const [searchParams] = useSearchParams()

  const data = useLiveQuery(async () => {
    if (!exercise) return { floors: [], blocks: [] }
    const [floors, blocks] = await Promise.all([
      loadFloorProgress(exercise.id),
      db.blocks.where('exerciseId').equals(exercise.id).toArray().then((rows) =>
        rows
          .filter((block) => !block.deleted)
          .sort((a, b) => {
            const rank = (name: string) => {
              const normalized = name.trim().toLocaleLowerCase()
              if (normalized.includes('admin')) return 0
              if (/^block\s/.test(normalized)) return 1
              return 2
            }
            return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true })
          }),
      ),
    ])
    return { floors, blocks }
  }, [exercise?.id])

  // useLiveQuery re-runs on any write to the tables it touched, so the
  // percentages below stay current while a teammate is entering data.
  const exercises = useLiveQuery(() => db.exercises.toArray(), [])

  if (!exercise) {
    return <EmptyState title={t('common.empty')} hint={t('exercise.select')} />
  }

  const blockIds = new Set(data?.blocks.map((block) => block.id) ?? [])
  const floorsForBlock = (blockId: string) =>
    (data?.floors ?? [])
      .map((fp) => {
        const rooms = fp.rooms.filter((rp) => {
          const effectiveBlockId = rp.room.blockId ?? fp.floor.blockId ?? ''
          return blockId ? effectiveBlockId === blockId : !effectiveBlockId || !blockIds.has(effectiveBlockId)
        })
        return {
          ...fp,
          rooms,
          done: rooms.filter((room) => room.status === 'done').length,
          itemsFound: rooms.reduce((total, room) => total + room.itemsFound, 0),
        }
      })
      .filter((fp) => fp.rooms.length > 0)

  // Keep every configured block visible, including a newly created block that
  // has not received any rooms yet. Setup is the source of truth for the block
  // list; inspection progress only supplies its counts.
  const groups = data?.blocks.map((block) => ({
    id: block.id,
    code: block.code,
    name: block.name,
    floors: floorsForBlock(block.id),
  })) ?? []
  const unassignedFloors = floorsForBlock('')
  if (unassignedFloors.length > 0) groups.push({ id: '', code: '—', name: t('setup.unassignedBlock'), floors: unassignedFloors })

  const requestedBlock = searchParams.get('block')
  const selectedGroup = requestedBlock
    ? groups.find((group) => (group.id || 'unassigned') === requestedBlock)
    : groups.length === 1 ? groups[0] : undefined

  return (
    <div className="space-y-4">
      {(exercises?.length ?? 0) > 1 && (
        <p className="text-xs text-slate-500">
          {t('setup.exercise')}: <span className="font-semibold text-slate-700">{exercise.name}</span>
        </p>
      )}

      <SectionTitle>
        {selectedGroup
          ? groups.length === 1 ? t('room.pickFloor') : selectedGroup.name
          : t('room.pickBlock')}
      </SectionTitle>

      {data === undefined && <p className="text-sm text-slate-500">{t('common.loading')}</p>}

      {!selectedGroup ? (
        <div className="space-y-2">
          {groups.map((group) => {
            const floorCount = group.floors.length
            const rooms = group.floors.flatMap((floor) => floor.rooms)
            const done = rooms.filter((room) => room.status === 'done').length
            const itemsFound = rooms.reduce((total, room) => total + room.itemsFound, 0)
            return (
              <Link
                key={group.id || 'unassigned'}
                to={`/inspect?block=${encodeURIComponent(group.id || 'unassigned')}`}
                className="card block px-4 py-4 active:bg-slate-50"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-xs font-bold text-brand-800">
                    {group.code}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold text-slate-900">{group.name}</p>
                    <p className="text-xs text-slate-500">
                      {floorCount} {t('setup.floorCount')} · {done}/{rooms.length} {t('common.rooms')} · {itemsFound} {t('common.items')}
                    </p>
                  </div>
                  <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <div className="mt-3"><ProgressBar value={done} total={rooms.length} /></div>
              </Link>
            )
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {groups.length > 1 && (
            <Link to="/inspect" className="btn-secondary inline-flex items-center gap-1 px-3 py-2 text-sm">
              <span aria-hidden="true">‹</span> {t('room.allBlocks')}
            </Link>
          )}
          <div className="space-y-2">
            {selectedGroup.floors.map((fp) => {
              const total = fp.rooms.length
              const blockQuery = selectedGroup.id ? `?block=${encodeURIComponent(selectedGroup.id)}` : '?block=unassigned'
              return (
                <Link key={fp.floor.id} to={`/inspect/${fp.floor.id}${blockQuery}`} className="card block px-4 py-3 active:bg-slate-50">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-sm font-bold text-brand-800">
                      {fp.floor.code}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-slate-900">{fp.floor.name}</p>
                      <p className="text-xs text-slate-500">
                        {fp.done}/{total} {t('common.rooms')} · {fp.itemsFound} {t('common.items')}
                      </p>
                    </div>
                    <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-400" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div className="mt-2"><ProgressBar value={fp.done} total={total} /></div>
                </Link>
              )
            })}
          </div>
          {selectedGroup.floors.length === 0 && (
            <EmptyState
              title={t('common.empty')}
              hint={t('room.blockEmpty')}
              action={
                <Link to="/setup" className="btn-secondary mt-2">
                  {t('nav.setup')}
                </Link>
              }
            />
          )}
        </div>
      )}

      {data?.floors.length === 0 && (
        <EmptyState
          title={t('common.empty')}
          hint={t('setup.floors')}
          action={
            <Link to="/setup" className="btn-secondary mt-2">
              {t('nav.setup')}
            </Link>
          }
        />
      )}
    </div>
  )
}
