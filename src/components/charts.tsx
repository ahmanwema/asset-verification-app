import { CONDITION_STYLE, ROOM_STATE_COLOR, SERIES_COLOR } from './ui'
import { useT } from '../i18n'
import { CONDITIONS, type RoomStatus } from '../types'
import type { ConditionTotals, FloorProgress } from '../lib/queries'

/**
 * Charts are plain HTML/CSS bars rather than SVG: the labels stay in real text
 * at real sizes on a phone, every value is directly labelled (so colour never
 * carries the meaning alone), and there is no chart library to ship offline.
 *
 * Mark conventions: thin bars, the data end rounded and the baseline end square,
 * a 2px surface gap between stacked segments, recessive tracks, no gridlines.
 */

function pct(n: number, total: number): number {
  return total > 0 ? (n / total) * 100 : 0
}

/** Condition breakdown: one labelled bar per state, worst-case comparison made easy. */
export function ConditionBars({ totals }: { totals: ConditionTotals }) {
  const t = useT()
  const max = Math.max(...CONDITIONS.map((c) => totals[c]), 1)

  if (totals.total === 0) {
    return <p className="py-4 text-center text-sm text-slate-400">{t('reports.nothing')}</p>
  }

  return (
    <div className="space-y-2.5">
      {CONDITIONS.map((c) => {
        const value = totals[c]
        const share = pct(value, totals.total)
        return (
          <div key={c} className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-xs font-semibold text-slate-600 sm:w-28">{t(`condition.${c}`)}</span>
            <div className="h-5 min-w-0 flex-1 rounded-sm bg-slate-100">
              <div
                className="h-full rounded-r-[4px] transition-all"
                style={{ width: `${Math.max(value > 0 ? 2 : 0, pct(value, max))}%`, backgroundColor: CONDITION_STYLE[c].color }}
                title={`${t(`condition.${c}`)}: ${value}`}
              />
            </div>
            <span className="w-20 shrink-0 text-right text-xs tabular-nums text-slate-700">
              <span className="font-bold text-slate-900">{value}</span>{' '}
              <span className="text-slate-500">{share.toFixed(0)}%</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

const STATES: RoomStatus[] = ['done', 'in_progress', 'not_started']

/** Floor progress: rooms per state, stacked, with a legend and per-floor counts. */
export function FloorStack({ floors }: { floors: FloorProgress[] }) {
  const t = useT()

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        {STATES.map((s) => (
          <span key={s} className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: ROOM_STATE_COLOR[s] }} />
            {t(`status.${s}`)}
          </span>
        ))}
      </div>

      <div className="space-y-2.5">
        {floors.map((fp) => {
          const total = fp.rooms.length || 1
          const counts: Record<RoomStatus, number> = {
            done: fp.done,
            in_progress: fp.inProgress,
            not_started: fp.notStarted,
          }
          const lastWithValue = [...STATES].reverse().find((s) => counts[s] > 0)
          return (
            <div key={fp.floor.id}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-xs font-semibold text-slate-700">{fp.floor.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-slate-500">
                  <span className="font-bold text-slate-900">{fp.done}</span>/{fp.rooms.length} {t('common.rooms')}
                </span>
              </div>
              <div className="flex h-5 gap-[2px] overflow-hidden rounded-sm bg-slate-100">
                {STATES.filter((s) => counts[s] > 0).map((s) => (
                  <div
                    key={s}
                    className={s === lastWithValue ? 'rounded-r-[4px]' : ''}
                    style={{ width: `${pct(counts[s], total)}%`, backgroundColor: ROOM_STATE_COLOR[s] }}
                    title={`${t(`status.${s}`)}: ${counts[s]}`}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Single-series ranking: items counted per asset type, biggest first. */
export function RankedBars({
  rows,
  limit = 10,
}: {
  rows: Array<{ name: string; quantity: number }>
  limit?: number
}) {
  const t = useT()
  const shown = rows.filter((r) => r.quantity > 0).slice(0, limit)
  const max = Math.max(...shown.map((r) => r.quantity), 1)

  if (shown.length === 0) {
    return <p className="py-4 text-center text-sm text-slate-400">{t('reports.nothing')}</p>
  }

  return (
    <div className="space-y-2">
      {shown.map((r) => (
        <div key={r.name} className="flex items-center gap-2">
          <span className="w-28 shrink-0 truncate text-xs font-semibold text-slate-600 sm:w-36" title={r.name}>
            {r.name}
          </span>
          <div className="h-4 min-w-0 flex-1 rounded-sm bg-slate-100">
            <div
              className="h-full rounded-r-[4px]"
              style={{ width: `${Math.max(2, pct(r.quantity, max))}%`, backgroundColor: SERIES_COLOR }}
              title={`${r.name}: ${r.quantity}`}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-xs font-bold tabular-nums text-slate-900">{r.quantity}</span>
        </div>
      ))}
    </div>
  )
}

/** Compact room map: every room on a floor as a colour-coded, labelled cell. */
export function RoomGrid({ floor }: { floor: FloorProgress }) {
  const t = useT()
  return (
    <div>
      <p className="mb-1.5 text-xs font-semibold text-slate-700">{floor.floor.name}</p>
      <div className="flex flex-wrap gap-1">
        {floor.rooms.map((rp) => (
          <span
            key={rp.room.id}
            title={`${rp.room.name} — ${t(`status.${rp.status}`)} · ${t('room.itemsFound', { n: rp.itemsFound })}`}
            className="rounded-md border px-1.5 py-1 text-[10px] font-bold"
            style={{
              backgroundColor: `${ROOM_STATE_COLOR[rp.status]}1f`,
              borderColor: ROOM_STATE_COLOR[rp.status],
              color: '#334155',
            }}
          >
            {rp.room.code}
          </span>
        ))}
      </div>
    </div>
  )
}
