import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { loadExerciseStats } from '../lib/queries'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { Card, EmptyState, ProgressBar, SectionTitle, StatTile } from '../components/ui'
import { ConditionBars, FloorStack, RankedBars, RoomGrid } from '../components/charts'

export default function DashboardPage() {
  const t = useT()
  const { exercise } = useSession()

  const stats = useLiveQuery(async () => {
    if (!exercise) return undefined
    return loadExerciseStats(exercise.id)
  }, [exercise?.id])

  if (!exercise) return <EmptyState title={t('common.empty')} />
  if (!stats) return <p className="text-sm text-slate-500">{t('common.loading')}</p>

  const attention = stats.conditions.F + stats.conditions.P + stats.conditions.U

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-slate-900">{t('dash.title')}</h1>
        <p className="text-xs text-slate-500">
          {exercise.name} · {exercise.date}
        </p>
      </div>

      <Card className="px-4 py-3">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-sm font-semibold text-slate-700">{t('dash.roomsDone')}</span>
          <span className="text-sm tabular-nums text-slate-500">
            <span className="text-2xl font-bold text-slate-900">{stats.roomsDone}</span> / {stats.roomsTotal}
          </span>
        </div>
        <ProgressBar value={stats.roomsDone} total={stats.roomsTotal} />
        <p className="mt-1.5 text-xs text-slate-500">
          {t('status.in_progress')}: {stats.roomsInProgress} · {t('status.not_started')}:{' '}
          {stats.roomsTotal - stats.roomsDone - stats.roomsInProgress}
        </p>
      </Card>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label={t('dash.itemsCounted')} value={stats.itemsFound} tone="brand" />
        <StatTile label={t('dash.tagsIssued')} value={stats.tagsIssued} />
        <StatTile label={t('dash.photos')} value={stats.photoCount} />
        <StatTile
          label={t('dash.needsAttention')}
          value={attention}
          tone={attention > 0 ? 'warn' : 'neutral'}
          sub={`${t('condition.U')}: ${stats.conditions.U}`}
        />
      </div>

      <Card className="p-4">
        <SectionTitle>{t('dash.conditionBreakdown')}</SectionTitle>
        <ConditionBars totals={stats.conditions} />
        <p className="mt-2 text-[11px] text-slate-500">
          {t('common.total')}: {stats.conditions.total} {t('common.items')}
        </p>
      </Card>

      <Card className="p-4">
        <SectionTitle>{t('dash.floorProgress')}</SectionTitle>
        <FloorStack floors={stats.floors} />
      </Card>

      <Card className="p-4">
        <SectionTitle>{t('dash.byAssetType')}</SectionTitle>
        <RankedBars rows={stats.byAssetType.map((r) => ({ name: r.name, quantity: r.quantity }))} />
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>{t('common.room')}</SectionTitle>
        {stats.floors.map((fp) => (
          <RoomGrid key={fp.floor.id} floor={fp} />
        ))}
      </Card>

      <div className="grid grid-cols-2 gap-2">
        <StatTile label={t('dash.missing')} value={stats.missingItems} />
        <StatTile label={t('dash.unlisted')} value={stats.unlistedItems} />
      </div>

      {(stats.pendingSync > 0 || stats.conflicts > 0) && (
        <Link to="/sync" className="card flex items-center justify-between px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-800">
              {stats.pendingSync > 0 ? t('sync.pending', { n: stats.pendingSync }) : t('sync.conflicts')}
            </p>
            {stats.conflicts > 0 && (
              <p className="text-xs font-semibold text-red-600">
                {t('sync.conflicts')}: {stats.conflicts}
              </p>
            )}
          </div>
          <span className="text-xs font-bold text-brand-700">{t('sync.now')}</span>
        </Link>
      )}
    </div>
  )
}
