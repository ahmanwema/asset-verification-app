import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { buildReportBundle, exportReport, type ReportKind } from '../lib/export-excel'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { Button, Card, EmptyState, TextInput, Toast } from '../components/ui'
import type { StringKey } from '../i18n/strings'

type Row = Record<string, string | number>

const TITLES: Record<ReportKind, StringKey> = {
  register: 'reports.register',
  depreciation: 'reports.depreciation',
  rooms: 'reports.room',
  condition: 'reports.condition',
  variance: 'reports.variance',
  tags: 'reports.tags',
  editlog: 'reports.editlog',
}

const KINDS = Object.keys(TITLES) as ReportKind[]

/**
 * Rendering every cell of a long register is slow on a phone and nobody reads
 * past the first screens anyway, so the table stops here and says how many
 * rows it is not showing. Searching narrows before the cut, so a row further
 * down is still reachable.
 */
const MAX_VISIBLE = 300

export default function ReportViewPage() {
  const { kind = 'register' } = useParams()
  const t = useT()
  const navigate = useNavigate()
  const { exercise } = useSession()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const reportKind = (KINDS as string[]).includes(kind) ? (kind as ReportKind) : 'register'

  const bundle = useLiveQuery(
    async () => (exercise ? buildReportBundle(exercise.id) : undefined),
    [exercise?.id],
  )

  const entryByTag = useLiveQuery(async () => {
    if (!exercise) return new Map<string, string>()
    const entries = await db.entries.where('exerciseId').equals(exercise.id).toArray()
    const pairs = entries
      .filter((entry) => !entry.deleted)
      .flatMap((entry) => entry.tagNumbers.map((tag) => [tag, entry.id] as const))
    return new Map(pairs)
  }, [exercise?.id])

  const rows: Row[] = useMemo(() => {
    if (!bundle) return []
    if (reportKind === 'depreciation') return bundle.depreciation
    if (reportKind === 'rooms') return bundle.rooms
    if (reportKind === 'condition') return bundle.condition
    if (reportKind === 'variance') return bundle.variance
    if (reportKind === 'tags') return bundle.tags
    if (reportKind === 'editlog') return bundle.editLog
    return bundle.register
  }, [bundle, reportKind])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(q)))
  }, [rows, query])

  const columns = filtered.length > 0 ? Object.keys(filtered[0]) : []
  const visible = filtered.slice(0, MAX_VISIBLE)

  async function download() {
    if (!exercise) return
    setBusy(true)
    try {
      const n = await exportReport(exercise.id, reportKind)
      setToast(n === 0 ? t('reports.nothing') : t('reports.exported'))
    } catch (err) {
      setToast(err instanceof Error ? err.message : t('sync.failed'))
    } finally {
      setBusy(false)
      setTimeout(() => setToast(null), 2200)
    }
  }

  if (!exercise) return <EmptyState title={t('common.empty')} />

  return (
    <div className="space-y-3 pb-4">
      <div className="flex items-center gap-2">
        <Link to="/reports" className="btn-ghost px-2" aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-slate-900">{t(TITLES[reportKind])}</h1>
          <p className="text-xs text-slate-500">
            {t('reports.rowCount', { n: filtered.length })}
            {filtered.length !== rows.length ? ` · ${t('reports.ofTotal', { n: rows.length })}` : ''}
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('common.search')}
          aria-label={t('common.search')}
        />
        <Button variant="secondary" className="shrink-0 px-3" disabled={busy} onClick={() => void download()}>
          XLSX
        </Button>
      </div>

      {/* Switching report without going back: the question "and what does the
          variance say?" comes up while looking at the register. */}
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => navigate(`/reports/${k}`)}
            className={`chip shrink-0 ${
              k === reportKind ? 'bg-brand-700 text-white' : 'bg-white text-slate-600'
            }`}
          >
            {t(TITLES[k])}
          </button>
        ))}
      </div>

      {bundle === undefined ? (
        <p className="text-sm text-slate-500">{t('common.loading')}</p>
      ) : filtered.length === 0 ? (
        <EmptyState title={query ? t('reports.noMatch') : t('reports.nothing')} />
      ) : (
        <>
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-max border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50">
                  {columns.map((c) => (
                    <th
                      key={c}
                      className="sticky top-0 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-2 py-2 text-left font-bold text-slate-600"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row, i) => (
                  <tr key={i} className={i % 2 ? 'bg-slate-50/60' : ''}>
                    {columns.map((c) => (
                      <td key={c} className="max-w-[18rem] truncate border-b border-slate-100 px-2 py-1.5 text-slate-700">
                        {c === 'Tag Number' && entryByTag?.has(String(row[c] ?? '')) ? (
                          <Link
                            to={`/asset/${entryByTag.get(String(row[c]))}?tag=${encodeURIComponent(String(row[c]))}`}
                            className="font-mono font-bold text-brand-700 underline decoration-brand-200 underline-offset-2"
                          >
                            {String(row[c])}
                          </Link>
                        ) : (
                          String(row[c] ?? '')
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {filtered.length > visible.length && (
            <p className="text-center text-xs text-slate-500">
              {t('reports.truncated', { n: filtered.length - visible.length })}
            </p>
          )}
        </>
      )}

      <Toast message={toast} />
    </div>
  )
}
