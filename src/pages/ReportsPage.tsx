import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { buildReportBundle, exportFullWorkbook, exportReport, type ReportKind } from '../lib/export-excel'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { Button, Card, EmptyState, SectionTitle, Toast } from '../components/ui'
import type { StringKey } from '../i18n/strings'

const REPORTS: Array<{ kind: ReportKind; title: StringKey; desc: StringKey }> = [
  { kind: 'register', title: 'reports.register', desc: 'reports.registerDesc' },
  { kind: 'depreciation', title: 'reports.depreciation', desc: 'reports.depreciationDesc' },
  { kind: 'rooms', title: 'reports.room', desc: 'reports.roomDesc' },
  { kind: 'condition', title: 'reports.condition', desc: 'reports.conditionDesc' },
  { kind: 'variance', title: 'reports.variance', desc: 'reports.varianceDesc' },
  { kind: 'tags', title: 'reports.tags', desc: 'reports.tagsDesc' },
  { kind: 'editlog', title: 'reports.editlog', desc: 'reports.editlogDesc' },
]

export default function ReportsPage() {
  const t = useT()
  const { exercise } = useSession()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<ReportKind | 'all' | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // Row counts come from the same builder the export uses, so the preview
  // numbers can never disagree with the spreadsheet that gets downloaded.
  const counts = useLiveQuery(async () => {
    if (!exercise) return undefined
    const b = await buildReportBundle(exercise.id)
    return {
      register: b.register.length,
      depreciation: b.depreciation.length,
      rooms: b.rooms.length,
      condition: b.condition.length,
      variance: b.variance.length,
      tags: b.tags.length,
      editlog: b.editLog.length,
    }
  }, [exercise?.id])

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }

  async function run(kind: ReportKind) {
    if (!exercise) return
    setBusy(kind)
    try {
      const n = await exportReport(exercise.id, kind)
      flash(n === 0 ? t('reports.nothing') : t('reports.exported'))
    } catch (err) {
      flash(err instanceof Error ? err.message : t('sync.failed'))
    } finally {
      setBusy(null)
    }
  }

  async function runAll() {
    if (!exercise) return
    setBusy('all')
    try {
      await exportFullWorkbook(exercise.id)
      flash(t('reports.exported'))
    } catch (err) {
      flash(err instanceof Error ? err.message : t('sync.failed'))
    } finally {
      setBusy(null)
    }
  }

  if (!exercise) return <EmptyState title={t('common.empty')} />

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-slate-900">{t('reports.title')}</h1>
        <p className="text-xs text-slate-500">
          {exercise.name} · {exercise.date}
        </p>
      </div>

      <Button full onClick={() => void runAll()} disabled={busy !== null}>
        {busy === 'all' ? t('common.loading') : t('reports.exportAll')}
      </Button>

      <Button variant="secondary" full onClick={() => navigate('/finance')}>
        {t('finance.manage')}
      </Button>

      <SectionTitle>{t('reports.exportExcel')}</SectionTitle>

      <div className="space-y-2">
        {REPORTS.map((r) => (
          <Card key={r.kind} className="flex items-center gap-2 px-4 py-3">
            {/* Looking before downloading is the common case — a spreadsheet
                has to be opened in another app just to answer "how many?". */}
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => navigate(`/reports/${r.kind}`)}
            >
              <p className="font-semibold text-slate-900">{t(r.title)}</p>
              <p className="text-xs text-slate-500">{t(r.desc)}</p>
              {counts && (
                <p className="mt-0.5 text-[11px] font-semibold tabular-nums text-brand-700">
                  {counts[r.kind]} {t('common.items')}
                </p>
              )}
            </button>
            <Button
              variant="secondary"
              className="shrink-0 px-3"
              onClick={() => navigate(`/reports/${r.kind}`)}
            >
              {t('reports.view')}
            </Button>
            <Button
              variant="secondary"
              className="shrink-0 px-3"
              onClick={() => void run(r.kind)}
              disabled={busy !== null}
            >
              {busy === r.kind ? '…' : 'XLSX'}
            </Button>
          </Card>
        ))}
      </div>

      <p className="text-xs text-slate-500">
        {t('reports.exportExcel')} — {t('sync.offlineHint')}
      </p>

      <Toast message={toast} />
    </div>
  )
}
