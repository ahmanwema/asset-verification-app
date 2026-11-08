import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { loadFloorProgress } from '../lib/queries'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { EmptyState, ProgressBar, SectionTitle } from '../components/ui'

export default function InspectPage() {
  const t = useT()
  const { exercise } = useSession()

  const floors = useLiveQuery(async () => {
    if (!exercise) return []
    return loadFloorProgress(exercise.id)
  }, [exercise?.id])

  // useLiveQuery re-runs on any write to the tables it touched, so the
  // percentages below stay current while a teammate is entering data.
  const exercises = useLiveQuery(() => db.exercises.toArray(), [])

  if (!exercise) {
    return <EmptyState title={t('common.empty')} hint={t('exercise.select')} />
  }

  return (
    <div className="space-y-4">
      {(exercises?.length ?? 0) > 1 && (
        <p className="text-xs text-slate-500">
          {t('setup.exercise')}: <span className="font-semibold text-slate-700">{exercise.name}</span>
        </p>
      )}

      <SectionTitle>{t('room.pickFloor')}</SectionTitle>

      {floors === undefined && <p className="text-sm text-slate-500">{t('common.loading')}</p>}

      <div className="space-y-2">
        {floors?.map((fp) => {
          const total = fp.rooms.length
          return (
            <Link key={fp.floor.id} to={`/inspect/${fp.floor.id}`} className="card block px-4 py-3 active:bg-slate-50">
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
              <div className="mt-2">
                <ProgressBar value={fp.done} total={total} />
              </div>
            </Link>
          )
        })}
      </div>

      {floors?.length === 0 && (
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
