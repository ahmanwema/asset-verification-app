import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { collectLabels, printLabels, qrDataUrl, type LabelData, type LabelScope } from '../lib/labels'
import { photoBlob } from '../lib/photos'
import { ensureEntryPhotos } from '../lib/sync'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import { Button, CONDITION_STYLE, Card, EmptyState, Field, SectionTitle, Select, Sheet, Toast } from '../components/ui'

export default function LabelsPage() {
  const t = useT()
  const { exercise } = useSession()
  const [scope, setScope] = useState<LabelScope>('exercise')
  const [floorId, setFloorId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [previewQr, setPreviewQr] = useState<string | null>(null)
  const [selected, setSelected] = useState<LabelData | null>(null)

  const floors = useLiveQuery(async () => {
    if (!exercise) return []
    return (await db.floors.where('exerciseId').equals(exercise.id).toArray()).sort(
      (a, b) => a.sortOrder - b.sortOrder,
    )
  }, [exercise?.id])

  const rooms = useLiveQuery(async () => {
    if (!floorId) return []
    return (await db.rooms.where('floorId').equals(floorId).toArray()).sort((a, b) => a.sortOrder - b.sortOrder)
  }, [floorId])

  const sheet = useLiveQuery(async () => {
    if (!exercise) return undefined
    return collectLabels({ exerciseId: exercise.id, scope, roomId, floorId })
  }, [exercise?.id, scope, roomId, floorId])

  const firstTag = sheet?.labels[0]?.tag
  useEffect(() => {
    if (!firstTag) {
      setPreviewQr(null)
      return
    }
    let cancelled = false
    void qrDataUrl(firstTag, 200).then((url) => {
      if (!cancelled) setPreviewQr(url)
    })
    return () => {
      cancelled = true
    }
  }, [firstTag])

  if (!exercise) return <EmptyState title={t('common.empty')} />

  async function doPrint() {
    if (!sheet || sheet.labels.length === 0) return
    setBusy(true)
    try {
      const ok = await printLabels(sheet)
      if (!ok) {
        setToast('Allow pop-ups to print labels')
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
        <p className="text-xs text-slate-500">{t('labels.count', { n: sheet?.labels.length ?? 0 })}</p>
      </div>

      <Card className="space-y-3 p-4">
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
              {floors?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {scope === 'room' && (
          <Field label={t('common.room')}>
            <Select value={roomId} onChange={(e) => setRoomId(e.target.value)} disabled={!floorId}>
              <option value="">—</option>
              {rooms?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Button full onClick={() => void doPrint()} disabled={busy || (sheet?.labels.length ?? 0) === 0}>
          {t('labels.print')} — {t('labels.count', { n: sheet?.labels.length ?? 0 })}
        </Button>
      </Card>

      <SectionTitle>{t('labels.preview')}</SectionTitle>

      {sheet && sheet.labels.length > 0 ? (
        <>
          <Card className="flex items-center gap-3 p-3">
            {previewQr && <img src={previewQr} alt="" className="h-20 w-20" />}
            <div className="min-w-0">
              <p className="truncate text-[10px] uppercase tracking-wide text-slate-500">{sheet.organization}</p>
              <p className="font-mono text-base font-bold text-slate-900">{sheet.labels[0].tag}</p>
              <p className="truncate text-xs font-semibold text-slate-700">{sheet.labels[0].description}</p>
              <p className="truncate text-xs text-slate-500">{sheet.labels[0].room}</p>
              <p className="text-[10px] text-slate-400">
                {t('labels.verified')} {sheet.verifiedOn}
              </p>
            </div>
          </Card>

          <p className="-mt-1 px-1 text-xs text-slate-500">{t('labels.tapForPhoto')}</p>

          <Card className="divide-y divide-slate-100">
            {sheet.labels.slice(0, 60).map((l) => (
              <button
                key={l.tag}
                type="button"
                onClick={() => setSelected(l)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs active:bg-slate-50"
              >
                <span className="font-mono font-bold text-slate-800">{l.tag}</span>
                <span className="min-w-0 flex-1 truncate text-slate-600">{l.description}</span>
                <span className="shrink-0 text-slate-400">{l.room}</span>
                <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-slate-300" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            ))}
            {sheet.labels.length > 60 && (
              <p className="px-3 py-2 text-center text-xs text-slate-500">
                + {sheet.labels.length - 60} {t('common.items')}
              </p>
            )}
          </Card>
        </>
      ) : (
        <EmptyState title={t('labels.nothing')} hint={t('reports.nothing')} />
      )}

      <LabelPhotoSheet label={selected} onClose={() => setSelected(null)} />

      <Toast message={toast} />
    </div>
  )
}

/**
 * The photo taken when the item was recorded, so whoever is sticking labels
 * can confirm the tag belongs to the thing in front of them before it goes on.
 */
function LabelPhotoSheet({ label, onClose }: { label: LabelData | null; onClose: () => void }) {
  const t = useT()
  // Pull the bytes down if this device never had them — the phone that took
  // the photo may not be the one sticking the labels.
  useEffect(() => {
    if (!label) return
    void ensureEntryPhotos(label.entryId)
  }, [label?.entryId])

  const photos = useLiveQuery(
    async () => (label ? db.photos.where('entryId').equals(label.entryId).toArray() : []),
    [label?.entryId],
  )

  const urls = useMemo(
    () => (photos ?? []).map((p) => ({ id: p.id, url: URL.createObjectURL(photoBlob(p)) })),
    [photos],
  )
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u.url)), [urls])

  if (!label) return null

  return (
    <Sheet open onClose={onClose} title={label.tag}>
      <div className="space-y-3">
        <div>
          <p className="font-semibold text-slate-900">{label.description}</p>
          <p className="text-xs text-slate-500">
            {label.floor} · {label.room}
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
            {urls.map((u) => (
              <img key={u.id} src={u.url} alt="" className="w-full rounded-xl object-cover" />
            ))}
          </div>
        )}
      </div>
    </Sheet>
  )
}
