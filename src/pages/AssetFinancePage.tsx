import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { calculateDepreciation, financialRecordComplete, financialRecordFor, saveFinancialRecord } from '../lib/depreciation'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { Button, Card, EmptyState, Field, Select, StatTile, TextArea, TextInput, Toast } from '../components/ui'
import type { AssetFinancialRecord } from '../types'

function numeric(value: string): number {
  const parsed = Number(value.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function money(value: number): string {
  return new Intl.NumberFormat('en-TZ', { maximumFractionDigits: 0 }).format(Math.round(value))
}

export default function AssetFinancePage() {
  const { entryId = '' } = useParams()
  const [search] = useSearchParams()
  const requestedTag = search.get('tag') ?? ''
  const t = useT()
  const navigate = useNavigate()
  const { exercise, inspector, isAdmin } = useSession()
  const [loadedKey, setLoadedKey] = useState('')
  const [acquisitionDate, setAcquisitionDate] = useState('')
  const [availableDate, setAvailableDate] = useState('')
  const [cost, setCost] = useState('')
  const [residual, setResidual] = useState('0')
  const [usefulYears, setUsefulYears] = useState('')
  const [openingDepreciation, setOpeningDepreciation] = useState('0')
  const [openingDate, setOpeningDate] = useState('')
  const [supplier, setSupplier] = useState('')
  const [invoice, setInvoice] = useState('')
  const [funding, setFunding] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const data = useLiveQuery(async () => {
    const entry = await db.entries.get(entryId)
    if (!entry || entry.deleted) return null
    const room = await db.rooms.get(entry.roomId)
    const [floor, type] = await Promise.all([
      room ? db.floors.get(room.floorId) : undefined,
      entry.assetTypeId ? db.assetTypes.get(entry.assetTypeId) : undefined,
    ])
    return { entry, room, floor, type }
  }, [entryId])

  const tag = data?.entry.tagNumbers.includes(requestedTag)
    ? requestedTag
    : (data?.entry.tagNumbers[0] ?? requestedTag)
  const saved = data ? financialRecordFor(data.entry, tag) : undefined

  useEffect(() => {
    if (!data || !tag || loadedKey === `${entryId}|${tag}`) return
    setAcquisitionDate(saved?.acquisitionDate ?? '')
    setAvailableDate(saved?.availableForUseDate ?? '')
    setCost(saved ? String(saved.originalCost) : '')
    setResidual(saved ? String(saved.residualValue) : '0')
    setUsefulYears(saved?.usefulLifeMonths ? String(saved.usefulLifeMonths / 12) : '')
    setOpeningDepreciation(saved ? String(saved.openingAccumulatedDepreciation) : '0')
    setOpeningDate(saved?.openingBalanceDate ?? '')
    setSupplier(saved?.supplier ?? '')
    setInvoice(saved?.invoiceNumber ?? '')
    setFunding(saved?.fundingSource ?? '')
    setNotes(saved?.notes ?? '')
    setLoadedKey(`${entryId}|${tag}`)
  }, [data, entryId, tag, saved, loadedKey])

  const draft = useMemo<AssetFinancialRecord>(() => ({
    tagNumber: tag,
    acquisitionDate,
    availableForUseDate: availableDate,
    originalCost: numeric(cost),
    residualValue: numeric(residual),
    usefulLifeMonths: Math.round(numeric(usefulYears) * 12),
    depreciationMethod: 'straight_line',
    openingAccumulatedDepreciation: numeric(openingDepreciation),
    openingBalanceDate: openingDate,
    supplier: supplier.trim(),
    invoiceNumber: invoice.trim(),
    fundingSource: funding.trim(),
    notes: notes.trim(),
    updatedAt: Date.now(),
    updatedBy: inspector?.id ?? '',
  }), [tag, acquisitionDate, availableDate, cost, residual, usefulYears, openingDepreciation, openingDate, supplier, invoice, funding, notes, inspector?.id])
  const result = calculateDepreciation(draft, exercise?.date ?? new Date().toISOString().slice(0, 10))

  async function save(goNext = false) {
    if (!data || !inspector || !isAdmin) return
    if (!acquisitionDate || !availableDate || numeric(cost) < 0 || numeric(usefulYears) <= 0) {
      setError(t('finance.requiredError'))
      return
    }
    if (numeric(residual) > numeric(cost)) {
      setError(t('finance.residualError'))
      return
    }
    if (availableDate < acquisitionDate) {
      setError(t('finance.dateOrderError'))
      return
    }
    if (numeric(openingDepreciation) > 0 && !openingDate) {
      setError(t('finance.openingDateError'))
      return
    }
    if (numeric(openingDepreciation) > numeric(cost) - numeric(residual)) {
      setError(t('finance.openingAmountError'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await saveFinancialRecord(data.entry, { ...draft, updatedAt: Date.now(), updatedBy: inspector.id }, inspector.id)
      if (goNext && exercise) {
        const entries = await db.entries.where('exerciseId').equals(exercise.id).toArray()
        const next = entries
          .filter((entry) => !entry.deleted && !entry.notPresent)
          .flatMap((entry) => entry.tagNumbers.map((nextTag) => ({ entry, tag: nextTag })))
          .sort((a, b) => a.tag.localeCompare(b.tag))
          .find((item) =>
            !(item.entry.id === data.entry.id && item.tag === tag) &&
            !financialRecordComplete(financialRecordFor(item.entry, item.tag)),
          )
        navigate(next ? `/asset/${next.entry.id}/finance?tag=${encodeURIComponent(next.tag)}` : '/finance')
        return
      }
      setToast(t('finance.saved'))
      setTimeout(() => setToast(null), 1800)
    } finally {
      setBusy(false)
    }
  }

  if (data === undefined) return <p className="text-sm text-slate-500">{t('common.loading')}</p>
  if (data === null || !tag) return <EmptyState title={t('asset.notFound')} />
  const description = data.entry.isUnlistedItem ? (data.entry.unlistedItemName ?? t('entry.unlisted')) : (data.type?.name ?? t('asset.unknown'))

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-2">
        <button type="button" className="btn-ghost px-2" onClick={() => navigate(-1)} aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-slate-900">{t('finance.assetDetails')}</h1>
          <p className="truncate text-sm font-semibold text-slate-700">{description}</p>
          <p className="font-mono text-xs font-bold text-brand-700">{tag}</p>
        </div>
        <Link to={`/asset/${entryId}?tag=${encodeURIComponent(tag)}`} className="btn-secondary px-3">{t('finance.assetCard')}</Link>
      </div>

      {!isAdmin && <Card className="border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{t('finance.adminOnly')}</Card>}

      {result.complete && (
        <div className="grid grid-cols-3 gap-2">
          <StatTile label={t('finance.currentDepreciation')} value={money(result.currentPeriodDepreciation)} />
          <StatTile label={t('finance.accumulatedDepreciation')} value={money(result.accumulatedDepreciation)} />
          <StatTile label={t('finance.netBookValue')} value={money(result.carryingAmount)} tone="brand" />
        </div>
      )}

      <Card className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('finance.acquisitionDate')}><TextInput type="date" value={acquisitionDate} onChange={(e) => { setAcquisitionDate(e.target.value); if (!availableDate) setAvailableDate(e.target.value) }} disabled={!isAdmin} /></Field>
          <Field label={t('finance.availableDate')} hint={t('finance.availableDateHint')}><TextInput type="date" value={availableDate} onChange={(e) => setAvailableDate(e.target.value)} disabled={!isAdmin} /></Field>
          <Field label={t('finance.originalCost')}><TextInput type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} disabled={!isAdmin} /></Field>
          <Field label={t('finance.residualValue')}><TextInput type="number" min="0" step="0.01" value={residual} onChange={(e) => setResidual(e.target.value)} disabled={!isAdmin} /></Field>
          <Field label={t('finance.usefulLife')} hint={t('finance.usefulLifeHint')}><TextInput type="number" min="0.1" step="0.5" value={usefulYears} onChange={(e) => setUsefulYears(e.target.value)} disabled={!isAdmin} /></Field>
          <Field label={t('finance.method')}><Select value="straight_line" disabled><option value="straight_line">{t('finance.straightLine')}</option></Select></Field>
        </div>
      </Card>

      <Card className="space-y-4 p-4">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-slate-600">{t('finance.openingBalance')}</h2>
          <p className="text-xs text-slate-500">{t('finance.openingBalanceHint')}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('finance.openingDepreciation')}><TextInput type="number" min="0" step="0.01" value={openingDepreciation} onChange={(e) => setOpeningDepreciation(e.target.value)} disabled={!isAdmin} /></Field>
          <Field label={t('finance.openingDate')}><TextInput type="date" value={openingDate} onChange={(e) => setOpeningDate(e.target.value)} disabled={!isAdmin} /></Field>
        </div>
      </Card>

      <Card className="grid gap-4 p-4 sm:grid-cols-2">
        <Field label={t('finance.supplier')}><TextInput value={supplier} onChange={(e) => setSupplier(e.target.value)} disabled={!isAdmin} /></Field>
        <Field label={t('finance.invoice')}><TextInput value={invoice} onChange={(e) => setInvoice(e.target.value)} disabled={!isAdmin} /></Field>
        <Field label={t('finance.funding')}><TextInput value={funding} onChange={(e) => setFunding(e.target.value)} disabled={!isAdmin} /></Field>
        <Field label={t('common.notes')}><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!isAdmin} /></Field>
      </Card>

      <p className="text-xs text-slate-500">{t('finance.policyNote')}</p>
      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p>}
      {isAdmin && (
        <div className="flex gap-2">
          <Button variant="secondary" full onClick={() => void save(false)} disabled={busy}>{t('common.save')}</Button>
          <Button full onClick={() => void save(true)} disabled={busy}>{busy ? t('common.loading') : t('finance.saveNext')}</Button>
        </div>
      )}
      <Toast message={toast} />
    </div>
  )
}
