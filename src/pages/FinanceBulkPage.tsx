import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import {
  applyFinanceTemplate,
  calculateDepreciation,
  financeGroupKey,
  financeTargets,
  residualAtEndOfLife,
  type FinanceTemplate,
} from '../lib/depreciation'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { Button, Card, EmptyState, Field, Select, StatTile, TextArea, TextInput, Toast } from '../components/ui'
import type { DepreciationMethod } from '../types'

type Scope = 'missing' | 'all'

function numeric(value: string): number {
  const parsed = Number(value.replace(/,/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function money(value: number): string {
  return new Intl.NumberFormat('en-TZ', { maximumFractionDigits: 0 }).format(Math.round(value))
}

/**
 * Costing a whole asset type at once.
 *
 * A school buys 489 identical desks on one invoice. Entering that cost tag by
 * tag means hundreds of passes through the asset editor, which is why a
 * valuation stalls. Here the figures are entered once and written to every tag
 * of the chosen type, with the option to leave hand-entered figures alone.
 */
export default function FinanceBulkPage() {
  const t = useT()
  const navigate = useNavigate()
  const { exercise, inspector, isAdmin } = useSession()

  const [groupKey, setGroupKey] = useState('')
  const [scope, setScope] = useState<Scope>('missing')
  const [acquisitionDate, setAcquisitionDate] = useState('')
  const [availableDate, setAvailableDate] = useState('')
  const [cost, setCost] = useState('')
  const [residual, setResidual] = useState('0')
  const [usefulYears, setUsefulYears] = useState('')
  const [method, setMethod] = useState<DepreciationMethod>('straight_line')
  const [annualRate, setAnnualRate] = useState('')
  const [supplier, setSupplier] = useState('')
  const [invoice, setInvoice] = useState('')
  const [funding, setFunding] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const data = useLiveQuery(async () => {
    if (!exercise) return undefined
    const [targets, types, org] = await Promise.all([
      financeTargets(exercise.id),
      db.assetTypes.toArray(),
      db.organizations.get(exercise.orgId),
    ])
    const typeById = new Map(types.map((type) => [type.id, type]))
    const groups = new Map<string, { key: string; name: string; total: number; missing: number }>()
    for (const target of targets) {
      const key = financeGroupKey(target.entry)
      const name = target.entry.isUnlistedItem
        ? (target.entry.unlistedItemName ?? t('entry.unlisted'))
        : (typeById.get(target.entry.assetTypeId ?? '')?.name ?? t('asset.unknown'))
      const group = groups.get(key) ?? { key, name, total: 0, missing: 0 }
      group.total += 1
      if (!target.hasRecord) group.missing += 1
      groups.set(key, group)
    }
    return {
      groups: [...groups.values()].sort((a, b) => b.missing - a.missing || b.total - a.total),
      fiscalYearEndMonth: org?.fiscalYearEndMonth ?? 12,
    }
  }, [exercise?.id, exercise?.orgId, t])

  const group = data?.groups.find((item) => item.key === groupKey)
  const targetCount = group ? (scope === 'missing' ? group.missing : group.total) : 0
  const replaceCount = group && scope === 'all' ? group.total - group.missing : 0

  const template = useMemo<FinanceTemplate>(() => ({
    acquisitionDate,
    availableForUseDate: availableDate,
    originalCost: numeric(cost),
    residualValue: numeric(residual),
    usefulLifeMonths: Math.round(numeric(usefulYears) * 12),
    depreciationMethod: method,
    annualDepreciationRate: method === 'straight_line' ? 0 : numeric(annualRate),
    openingAccumulatedDepreciation: 0,
    openingBalanceDate: '',
    supplier: supplier.trim(),
    invoiceNumber: invoice.trim(),
    fundingSource: funding.trim(),
    notes: notes.trim(),
  }), [acquisitionDate, availableDate, cost, residual, usefulYears, method, annualRate, supplier, invoice, funding, notes])

  const asOfDate = exercise?.reportingDate || exercise?.date || new Date().toISOString().slice(0, 10)
  const preview = calculateDepreciation(
    { ...template, tagNumber: '', updatedAt: 0, updatedBy: '' },
    asOfDate,
    data?.fiscalYearEndMonth ?? 12,
  )
  const standingBalance = residualAtEndOfLife({ ...template, tagNumber: '', updatedAt: 0, updatedBy: '' })

  async function apply() {
    if (!exercise || !inspector || !isAdmin || !group) return
    if (!acquisitionDate || !availableDate || cost.trim() === '' || numeric(cost) < 0 || numeric(usefulYears) <= 0) {
      setError(t(method === 'straight_line' ? 'finance.requiredErrorLine' : 'finance.requiredError'))
      return
    }
    if (method !== 'straight_line' && (numeric(annualRate) <= 0 || numeric(annualRate) > 100)) {
      setError(t('finance.rateError'))
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
    if (targetCount === 0) {
      setError(t('finance.bulkNothing'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const written = await applyFinanceTemplate(
        exercise.id,
        group.key,
        template,
        { onlyMissing: scope === 'missing' },
        inspector.id,
      )
      setToast(t('finance.bulkDone', { n: written }))
      setTimeout(() => navigate('/finance'), 1200)
    } finally {
      setBusy(false)
    }
  }

  if (!exercise) return <EmptyState title={t('common.empty')} />

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-2">
        <Link to="/finance" className="btn-ghost px-2" aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div>
          <h1 className="text-lg font-bold text-slate-900">{t('finance.bulkTitle')}</h1>
          <p className="text-xs text-slate-500">{t('finance.bulkHint')}</p>
        </div>
      </div>

      {!isAdmin && <Card className="border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{t('finance.adminOnly')}</Card>}

      <Card className="space-y-4 p-4">
        <Field label={t('finance.bulkType')}>
          <Select value={groupKey} onChange={(e) => setGroupKey(e.target.value)} disabled={!isAdmin}>
            <option value="">{t('finance.bulkSelectType')}</option>
            {(data?.groups ?? []).map((item) => (
              <option key={item.key} value={item.key}>
                {item.name} — {item.missing}/{item.total}
              </option>
            ))}
          </Select>
        </Field>
        {group && (
          <Field label={t('finance.bulkScope')}>
            <Select value={scope} onChange={(e) => setScope(e.target.value as Scope)} disabled={!isAdmin}>
              <option value="missing">{t('finance.bulkMissingOnly', { n: group.missing })}</option>
              <option value="all">{t('finance.bulkAll', { n: group.total })}</option>
            </Select>
          </Field>
        )}
        {replaceCount > 0 && (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
            {t('finance.bulkReplaceWarning', { n: replaceCount })}
          </p>
        )}
      </Card>

      {group && (
        <>
          <Card className="space-y-4 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('finance.acquisitionDate')}>
                <TextInput type="date" value={acquisitionDate} onChange={(e) => { setAcquisitionDate(e.target.value); if (!availableDate) setAvailableDate(e.target.value) }} disabled={!isAdmin} />
              </Field>
              <Field label={t('finance.availableDate')} hint={t('finance.availableDateHint')}>
                <TextInput type="date" value={availableDate} onChange={(e) => setAvailableDate(e.target.value)} disabled={!isAdmin} />
              </Field>
              <Field label={t('finance.costPerItem')}>
                <TextInput type="number" min="0" step="0.01" value={cost} onChange={(e) => setCost(e.target.value)} disabled={!isAdmin} />
              </Field>
              <Field label={t('finance.residualPerItem')}>
                <TextInput type="number" min="0" step="0.01" value={residual} onChange={(e) => setResidual(e.target.value)} disabled={!isAdmin} />
              </Field>
              <Field label={t('finance.usefulLife')} hint={t('finance.usefulLifeHint')}>
                <TextInput type="number" min="0.1" step="0.5" value={usefulYears} onChange={(e) => setUsefulYears(e.target.value)} disabled={!isAdmin} />
              </Field>
              <Field label={t('finance.method')} hint={t('finance.methodHint')}>
                <Select value={method} onChange={(e) => setMethod(e.target.value as DepreciationMethod)} disabled={!isAdmin}>
                  <option value="straight_line">{t('finance.straightLine')}</option>
                  <option value="diminishing_balance">{t('finance.diminishingBalance')}</option>
                </Select>
              </Field>
              {method !== 'straight_line' && (
                <Field label={t('finance.rate')} hint={t('finance.rateHint')}>
                  <TextInput type="number" min="0.01" max="100" step="0.01" value={annualRate} onChange={(e) => setAnnualRate(e.target.value)} disabled={!isAdmin} />
                </Field>
              )}
            </div>
            <p className="text-xs text-slate-500">{t('finance.lifeCapNote')}</p>
            {standingBalance !== null && standingBalance > numeric(residual) + 1 && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-900">
                {t('finance.rateLeavesBalance', { amount: money(standingBalance), years: numeric(usefulYears) })}
              </p>
            )}
          </Card>

          <Card className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label={t('finance.supplier')}><TextInput value={supplier} onChange={(e) => setSupplier(e.target.value)} disabled={!isAdmin} /></Field>
            <Field label={t('finance.invoice')}><TextInput value={invoice} onChange={(e) => setInvoice(e.target.value)} disabled={!isAdmin} /></Field>
            <Field label={t('finance.funding')}><TextInput value={funding} onChange={(e) => setFunding(e.target.value)} disabled={!isAdmin} /></Field>
            <Field label={t('common.notes')}><TextArea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!isAdmin} /></Field>
          </Card>

          {preview.complete && (
            <div className="grid grid-cols-3 gap-2">
              <StatTile label={t('finance.currentDepreciation')} value={money(preview.currentPeriodDepreciation * targetCount)} />
              <StatTile label={t('finance.accumulatedDepreciation')} value={money(preview.accumulatedDepreciation * targetCount)} />
              <StatTile label={t('finance.netBookValue')} value={money(preview.carryingAmount * targetCount)} tone="brand" />
            </div>
          )}

          <p className="text-xs font-semibold text-slate-600">
            {t('finance.bulkTotal', { n: targetCount, amount: money(numeric(cost) * targetCount) })}
          </p>
          <p className="text-xs text-slate-500">{t('finance.asAt', { date: asOfDate })}</p>
          <p className="text-xs text-slate-500">{t('finance.policyNote')}</p>

          {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p>}
          {isAdmin && (
            <Button full onClick={() => void apply()} disabled={busy || targetCount === 0}>
              {busy ? t('common.loading') : t('finance.bulkApply', { n: targetCount })}
            </Button>
          )}
        </>
      )}

      <Toast message={toast} />
    </div>
  )
}
