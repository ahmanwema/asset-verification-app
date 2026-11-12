import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { collectLabels, printLabels, type LabelData, type LabelScope } from '../lib/labels'
import { photoBlob } from '../lib/photos'
import { ensureEntryPhotos } from '../lib/sync'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { CONDITIONS, type Condition } from '../types'
import {
  Button,
  CONDITION_STYLE,
  Card,
  EmptyState,
  Field,
  SectionTitle,
  Select,
  Sheet,
  TextInput,
  Toast,
} from '../components/ui'

type PhotoFilter = 'all' | 'with' | 'without'

const MAX_VISIBLE = 200

export default function LabelsPage() {
  const t = useT()
  const { exercise } = useSession()
  const [scope, setScope] = useState<LabelScope>('exercise')
  const [floorId, setFloorId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [query, setQuery] = useState('')
  const [condition, setCondition] = useState<Condition | ''>('')
  const [photoFilter, setPhotoFilter] = useState<PhotoFilter>('all')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [selected, setSelected] = useState<LabelData | null>(null)

  const floors = useLiveQuery(async () => {
    if (!exercise) return []
    return (await db.floors.where('exerciseId').equals(exercise.id).toArray()).sort(
      (a, b) => a.sortOrder - b.sortOrder,
    )
  }, [exercise?.id])

  const rooms = useLiveQuery(async () => {
    if (!floorId) return []
    return (await db.rooms.where('floorId').equals(floorId).toArray()).sort(
      (a, b) => a.sortOrder - b.sortOrder,
    )
  }, [floorId])

  const sheet = useLiveQuery(async () => {
    if (!exercise) return undefined
    return collectLabels({ exerciseId: exercise.id, scope, roomId, floorId })
  }, [exercise?.id, scope, roomId, floorId])

  const filteredLabels = useMemo(() => {
    if (!sheet) return []
    const q = query.trim().toLowerCase()
    return sheet.labels.filter((label) => {
      if (condition && label.condition !== condition) return false
      if (photoFilter === 'with' && label.photoCount === 0) return false
      if (photoFilter === 'without' && label.photoCount > 0) return false
      if (!q) return true
      return [label.tag, label.description, label.block, label.floor, label.room, label.serial].some((value) =>
        value.toLowerCase().includes(q),
      )
    })
  }, [sheet, query, condition, photoFilter])

  const visibleLabels = filteredLabels.slice(0, MAX_VISIBLE)
  const groups = useMemo(() => {
    const grouped = new Map<string, { block: string; floor: string; room: string; labels: LabelData[] }>()
    for (const label of visibleLabels) {
      const key = `${label.block}\u0000${label.floor}\u0000${label.room}`
      const group = grouped.get(key) ?? { block: label.block, floor: label.floor, room: label.room, labels: [] }
      group.labels.push(label)
      grouped.set(key, group)
    }
    return [...grouped.values()]
  }, [visibleLabels])

  const hasFilters = Boolean(query.trim() || condition || photoFilter !== 'all')

  if (!exercise) return <EmptyState title={t('common.empty')} />

  async function doPrint() {
    if (!sheet || filteredLabels.length === 0) return
    setBusy(true)
    try {
      const ok = await printLabels({ ...sheet, labels: filteredLabels })
      if (!ok) {
        setToast(t('labels.allowPopups'))
        setTimeout(() => setToast(null), 2600)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-slate-900">{t('labels.title')}</h1>
        <p className="text-xs text-slate-500">
          {t('labels.showing', { shown: filteredLabels.length, total: sheet?.labels.length ?? 0 })}
        </p>
      </div>

      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('labels.scope')}>
            <Select value={scope} onChange={(e) => setScope(e.target.value as LabelScope)}>
              <option value="exercise">{t('labels.exercise')}</option>
              <option value="floor">{t('labels.floor')}</option>
              <option value="room">{t('labels.room')}</option>
            </Select>
          </Field>

          {(scope === 'floor' || scope === 'room') && (
            <Field label={t('common.floor')}>
              <Select
                value={floorId}
                onChange={(e) => {
                  setFloorId(e.target.value)
                  setRoomId('')
                }}
              >
                <option value="">—</option>
                {floors?.map((floor) => (
                  <option key={floor.id} value={floor.id}>
                    {floor.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {scope === 'room' && (
            <Field label={t('common.room')}>
              <Select value={roomId} onChange={(e) => setRoomId(e.target.value)} disabled={!floorId}>
                <option value="">—</option>
                {rooms?.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label={t('entry.condition')}>
            <Select value={condition} onChange={(e) => setCondition(e.target.value as Condition | '')}>
              <option value="">{t('labels.allConditions')}</option>
              {CONDITIONS.map((value) => (
                <option key={value} value={value}>
                  {t(`condition.${value}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={t('labels.photos')}>
            <Select value={photoFilter} onChange={(e) => setPhotoFilter(e.target.value as PhotoFilter)}>
              <option value="all">{t('labels.allPhotos')}</option>
              <option value="with">{t('labels.withPhotos')}</option>
              <option value="without">{t('labels.withoutPhotos')}</option>
            </Select>
          </Field>
        </div>

        <Field label={t('common.search')}>
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('labels.searchPlaceholder')}
            type="search"
          />
        </Field>

        <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
          <span>{t('labels.showing', { shown: filteredLabels.length, total: sheet?.labels.length ?? 0 })}</span>
          {hasFilters && (
            <button
              type="button"
              className="font-bold text-brand-700"
              onClick={() => {
                setQuery('')
                setCondition('')
                setPhotoFilter('all')
              }}
            >
              {t('labels.clearFilters')}
            </button>
          )}
        </div>

        <Button full onClick={() => void doPrint()} disabled={busy || filteredLabels.length === 0}>
          {t('labels.print')} — {t('labels.count', { n: filteredLabels.length })}
        </Button>
      </Card>

      <SectionTitle action={<span className="text-xs font-semibold text-slate-500">{filteredLabels.length}</span>}>
        {t('labels.preview')}
      </SectionTitle>

      {sheet && filteredLabels.length > 0 ? (
        <>
          <p className="-mt-1 px-1 text-xs text-slate-500">{t('labels.tapForPhoto')}</p>

          <div className="space-y-3">
            {groups.map((group) => (
              <section key={`${group.block}|${group.floor}|${group.room}`}>
                <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold text-slate-800">{group.room || '—'}</p>
                    <p className="truncate text-[11px] text-slate-500">
                      {[group.block, group.floor].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <span className="chip shrink-0 bg-slate-100 text-slate-600">
                    {t('labels.count', { n: group.labels.length })}
                  </span>
                </div>

                <Card className="divide-y divide-slate-100 p-0">
                  {group.labels.map((label) => (
                    <button
                      key={label.tag}
                      type="button"
                      onClick={() => setSelected(label)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left active:bg-slate-50"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="font-mono text-xs font-bold text-slate-900">{label.tag}</span>
                          {label.photoCount > 0 && (
                            <span className="text-[11px] font-semibold text-brand-700">📷 {label.photoCount}</span>
                          )}
                        </div>
                        <p className="truncate text-xs text-slate-600">{label.description}</p>
                        {label.serial && <p className="truncate text-[11px] text-slate-400">{label.serial}</p>}
                      </div>
                      <span className={`chip shrink-0 ${CONDITION_STYLE[label.condition].chip}`}>
                        {t(`condition.${label.condition}`)}
                      </span>
                      <svg
                        viewBox="0 0 24 24"
                        className="h-4 w-4 shrink-0 text-slate-300"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </button>
                  ))}
                </Card>
              </section>
            ))}
          </div>

          {filteredLabels.length > visibleLabels.length && (
            <p className="text-center text-xs text-slate-500">
              {t('labels.moreResults', { n: filteredLabels.length - visibleLabels.length })}
            </p>
          )}
        </>
      ) : (
        <EmptyState
          title={hasFilters ? t('reports.noMatch') : t('labels.nothing')}
          hint={hasFilters ? t('labels.clearFilters') : t('reports.nothing')}
        />
      )}

      <LabelPhotoSheet label={selected} onClose={() => setSelected(null)} />
      <Toast message={toast} />
    </div>
  )
}

/** Shows every photo attached to the selected label's inspection entry. */
function LabelPhotoSheet({ label, onClose }: { label: LabelData | null; onClose: () => void }) {
  const t = useT()

  useEffect(() => {
    if (!label) return
    void ensureEntryPhotos(label.entryId)
  }, [label?.entryId])

  const photos = useLiveQuery(
    async () => (label ? db.photos.where('entryId').equals(label.entryId).toArray() : []),
    [label?.entryId],
  )

  const urls = useMemo(
    () => (photos ?? []).map((photo) => ({ id: photo.id, url: URL.createObjectURL(photoBlob(photo)) })),
    [photos],
  )
  useEffect(() => () => urls.forEach((item) => URL.revokeObjectURL(item.url)), [urls])

  if (!label) return null

  return (
    <Sheet open onClose={onClose} title={label.tag}>
      <div className="space-y-3">
        <div>
          <p className="font-semibold text-slate-900">{label.description}</p>
          <p className="text-xs text-slate-500">
            {[label.block, label.floor, label.room].filter(Boolean).join(' · ')}
            {label.serial ? ` · ${label.serial}` : ''}
          </p>
          <span className={`chip mt-1 inline-block ${CONDITION_STYLE[label.condition].chip}`}>
            {t(`condition.${label.condition}`)}
          </span>
        </div>

        {photos === undefined ? (
          <p className="text-sm text-slate-500">{t('common.loading')}</p>
        ) : urls.length === 0 ? (
          <p className="rounded-xl bg-slate-50 p-4 text-center text-sm text-slate-500">{t('labels.noPhoto')}</p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {urls.map((item) => (
              <img key={item.id} src={item.url} alt="" className="w-full rounded-xl object-cover" />
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}
