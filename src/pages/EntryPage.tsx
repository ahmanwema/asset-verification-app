import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, uid } from '../db/db'
import { assetName, useI18n, useT } from '../i18n'
import { useSession } from '../state/session'
import {
  ConversionError,
  EDIT_FIELD_LABEL,
  ValidationError,
  convertToAssetType,
  deleteEntry,
  saveEntry,
} from '../lib/entries'
import { allocateTagNumbers, deriveCode } from '../lib/tags'
import { breakdownIsValid } from '../lib/queries'
import { blobToArrayBuffer, compressImage, photoBlob } from '../lib/photos'
import { MAX_IDENTIFY_IMAGES, identifyPhoto } from '../lib/vision'
import {
  Button,
  CONDITION_STYLE,
  Card,
  EditedChip,
  EmptyState,
  Field,
  Segmented,
  Select,
  TextArea,
  TextInput,
  Toast,
} from '../components/ui'
import { CONDITIONS, type Condition, type ConditionBreakdown } from '../types'
import type { StringKey } from '../i18n/strings'

interface DraftPhoto {
  id: string
  blob: Blob
  width: number
  height: number
  persisted: boolean
}

/**
 * Localised labels for the edit log, keyed by the field names `entries.ts` logs.
 * A field with no entry here falls back to the English label from that module.
 */
const HISTORY_FIELD_KEY: Record<string, StringKey> = {
  quantity: 'entry.quantity',
  notPresent: 'entry.notPresent',
  condition: 'entry.condition',
  conditionBreakdown: 'entry.split',
  serialNumbers: 'entry.serial',
  brand: 'entry.brand',
  model: 'entry.model',
  tagNumbers: 'entry.tag',
  itemType: 'entry.itemType',
  material: 'entry.material',
  colour: 'entry.colour',
  additionalFeatures: 'entry.additionalFeatures',
  specificPosition: 'entry.specificPosition',
  description: 'entry.description',
  remarks: 'entry.remarks',
  unlistedItemName: 'entry.unlistedName',
  photos: 'entry.photo',
  financialDetails: 'finance.assetDetails',
}

function fmtWhen(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Everything photo recognition may overwrite, kept so "Undo AI fill" is exact. */
interface FormSnapshot {
  quantity: number
  condition: Condition
  serials: string[]
  brand: string
  model: string
  remarks: string
  material: string
  colour: string
  itemType: string
  additionalFeatures: string
  description: string
  specificPosition: string
  unlistedName: string
}

export default function EntryPage() {
  const { roomId = '', assetTypeId = '' } = useParams()
  const [search] = useSearchParams()
  const editId = search.get('entry')
  const isUnlisted = assetTypeId === 'new'
  const t = useT()
  const { lang } = useI18n()
  const navigate = useNavigate()
  const { exercise, inspector } = useSession()

  const ctx = useLiveQuery(async () => {
    const room = await db.rooms.get(roomId)
    if (!room) return null
    const [floor, assetType, assetTypes, entries, inspectors, allRooms, allFloors] = await Promise.all([
      db.floors.get(room.floorId),
      isUnlisted ? Promise.resolve(undefined) : db.assetTypes.get(assetTypeId),
      db.assetTypes.orderBy('sortOrder').toArray(),
      db.entries.where('roomId').equals(roomId).toArray(),
      db.inspectors.toArray(),
      db.rooms.where('exerciseId').equals(room.exerciseId).toArray(),
      db.floors.where('exerciseId').equals(room.exerciseId).toArray(),
    ])
    const existing = isUnlisted
      ? editId
        ? await db.entries.get(editId)
        : undefined
      : entries.find((e) => e.assetTypeId === assetTypeId && !e.deleted)
    return {
      room,
      floor,
      assetType,
      assetTypes: assetTypes.filter((a) => a.active),
      entries,
      existing,
      inspectors,
      allRooms,
      allFloors,
    }
  }, [roomId, assetTypeId, editId])

  // ---- form state -------------------------------------------------------
  const [loaded, setLoaded] = useState(false)
  const [notPresent, setNotPresent] = useState(false)
  const [quantity, setQuantity] = useState(1)
  const [unlistedName, setUnlistedName] = useState('')
  const [serials, setSerials] = useState<string[]>([''])
  const [perItemSerials, setPerItemSerials] = useState(false)
  const [model, setModel] = useState('')
  const [brand, setBrand] = useState('')
  const [condition, setCondition] = useState<Condition>('G')
  const [splitCondition, setSplitCondition] = useState(false)
  const [breakdown, setBreakdown] = useState<ConditionBreakdown>({})
  const [remarks, setRemarks] = useState('')
  const [manualTags, setManualTags] = useState(false)
  const [tagDraft, setTagDraft] = useState<string[]>([])
  const [photos, setPhotos] = useState<DraftPhoto[]>([])
  const [removedPhotoIds, setRemovedPhotoIds] = useState<string[]>([])
  const [error, setError] = useState<StringKey | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // --- "More details" + photo recognition ---------------------------------
  const [showDetails, setShowDetails] = useState(false)
  const [material, setMaterial] = useState('')
  const [colour, setColour] = useState('')
  const [itemType, setItemType] = useState('')
  const [additionalFeatures, setAdditionalFeatures] = useState('')
  const [description, setDescription] = useState('')
  const [specificPosition, setSpecificPosition] = useState('')
  const [aiAssisted, setAiAssisted] = useState(false)
  const [expectedRoomId, setExpectedRoomId] = useState('')
  const [identifying, setIdentifying] = useState(false)
  const [aiSnapshot, setAiSnapshot] = useState<FormSnapshot | null>(null)
  const aiFileRef = useRef<HTMLInputElement>(null)
  const aiUploadRef = useRef<HTMLInputElement>(null)
  const uploadRef = useRef<HTMLInputElement>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [moveTo, setMoveTo] = useState('')

  // Hydrate once the record is known; later live-query ticks must not stomp edits.
  useEffect(() => {
    if (!ctx || loaded) return
    const e = ctx.existing
    if (e) {
      setNotPresent(e.notPresent)
      setQuantity(e.notPresent ? 1 : Math.max(1, e.quantity))
      setUnlistedName(e.unlistedItemName ?? '')
      setSerials(e.serialNumbers.length > 0 ? e.serialNumbers : [''])
      setPerItemSerials(e.serialNumbers.length > 1)
      setModel(e.model)
      setBrand(e.brand)
      setCondition(e.condition)
      setRemarks(e.remarks)
      setTagDraft(e.tagNumbers)
      setMaterial(e.material ?? '')
      setColour(e.colour ?? '')
      setItemType(e.itemType ?? '')
      setAdditionalFeatures(e.additionalFeatures ?? '')
      setDescription(e.description ?? '')
      setSpecificPosition(e.specificPosition ?? '')
      setAiAssisted(Boolean(e.aiAssisted))
      setExpectedRoomId(e.expectedRoomId ?? '')
      // Open the details section automatically when the entry already has some.
      if (
        e.material ||
        e.colour ||
        e.itemType ||
        e.additionalFeatures ||
        e.description ||
        e.specificPosition ||
        e.expectedRoomId
      ) {
        setShowDetails(true)
      }
      if (e.conditionBreakdown && Object.keys(e.conditionBreakdown).length > 0) {
        setSplitCondition(true)
        setBreakdown(e.conditionBreakdown)
      }
      void db.photos
        .where('entryId')
        .equals(e.id)
        .toArray()
        .then((rows) =>
          setPhotos(
            rows.map((p) => ({
              id: p.id,
              blob: photoBlob(p),
              width: p.width,
              height: p.height,
              persisted: true,
            })),
          ),
        )
    }
    setLoaded(true)
  }, [ctx, loaded])

  const assetCode = useMemo(() => {
    if (isUnlisted) return deriveCode(unlistedName || 'Unlisted')
    return ctx?.assetType?.code ?? 'XX'
  }, [isUnlisted, unlistedName, ctx?.assetType?.code])

  // Live tag preview: allocate the next free sequence numbers for this room.
  useEffect(() => {
    if (!ctx?.room || !ctx.floor || manualTags || notPresent) return
    let cancelled = false
    void allocateTagNumbers({
      roomId: ctx.room.id,
      assetCode,
      floorCode: ctx.floor.code,
      roomCode: ctx.room.code,
      quantity,
      keepEntryId: ctx.existing?.id,
    }).then((tags) => {
      if (!cancelled) setTagDraft(tags)
    })
    return () => {
      cancelled = true
    }
  }, [ctx?.room, ctx?.floor, ctx?.existing?.id, assetCode, quantity, manualTags, notPresent])

  const previews = useMemo(() => photos.map((p) => ({ id: p.id, url: URL.createObjectURL(p.blob) })), [photos])
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews])

  if (ctx === undefined) return <p className="text-sm text-slate-500">{t('common.loading')}</p>
  if (ctx === null) return <EmptyState title={t('common.empty')} />

  const { room, floor, assetType, assetTypes, entries, existing, inspectors, allRooms, allFloors } = ctx
  const title = isUnlisted
    ? unlistedName || t('entry.addUnlisted')
    : assetName(lang, assetType?.name ?? '', assetType?.nameSw)

  const detailsFilled = [material, colour, itemType, additionalFeatures, description, specificPosition].filter(
    (v) => v.trim().length > 0,
  ).length

  // The markers describe the entry as it is stored, not the unsaved form: a field
  // is flagged once a saved change to it has been recorded.
  const history = existing?.editHistory ?? []
  const editedFields = new Set(history.map((h) => h.field))
  const whoById = new Map(inspectors.map((i) => [i.id, i.name]))

  /** Chip for the bare label rows (quantity, condition, tags, photos). */
  function editedBadge(field: string) {
    if (!editedFields.has(field)) return null
    return <EditedChip>{t('history.edited')}</EditedChip>
  }

  const fieldLabel = (field: string) =>
    HISTORY_FIELD_KEY[field] ? t(HISTORY_FIELD_KEY[field]) : (EDIT_FIELD_LABEL[field] ?? field)

  function valueLabel(field: string, value: string): string {
    if (!value) return '—'
    if (field === 'expectedRoomId') return allRooms.find((r) => r.id === value)?.name ?? value
    if (field === 'condition' && (CONDITIONS as string[]).includes(value)) {
      return t(`condition.${value as Condition}`)
    }
    if (field === 'notPresent') return value === 'true' ? t('common.yes') : t('common.no')
    return value
  }
  const breakdownSum = CONDITIONS.reduce((n, c) => n + (breakdown[c] ?? 0), 0)
  const breakdownOk = !splitCondition || breakdownIsValid(breakdown, quantity)

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 1600)
  }

  function setQty(next: number) {
    const q = Math.max(0, Math.min(9999, Math.round(next)))
    setQuantity(q === 0 ? 1 : q)
    if (perItemSerials) {
      setSerials((prev) => {
        const copy = prev.slice(0, q)
        while (copy.length < q) copy.push('')
        return copy
      })
    }
  }

  async function onPickPhotos(files: FileList | null) {
    if (!files || files.length === 0) return
    setBusy(true)
    try {
      const added: DraftPhoto[] = []
      for (const file of Array.from(files)) {
        const { blob, width, height } = await compressImage(file)
        added.push({ id: uid('ph_'), blob, width, height, persisted: false })
      }
      setPhotos((prev) => [...prev, ...added])
    } catch {
      flash(t('entry.photo'))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function removePhoto(id: string) {
    setPhotos((prev) => prev.filter((p) => p.id !== id))
    setRemovedPhotoIds((prev) => (photos.find((p) => p.id === id)?.persisted ? [...prev, id] : prev))
  }

  function currentSnapshot(): FormSnapshot {
    return {
      quantity,
      condition,
      serials,
      brand,
      model,
      remarks,
      material,
      colour,
      itemType,
      additionalFeatures,
      description,
      specificPosition,
      unlistedName,
    }
  }

  function restoreSnapshot(snap: FormSnapshot) {
    setQuantity(snap.quantity)
    setCondition(snap.condition)
    setSerials(snap.serials)
    setBrand(snap.brand)
    setModel(snap.model)
    setRemarks(snap.remarks)
    setMaterial(snap.material)
    setColour(snap.colour)
    setItemType(snap.itemType)
    setAdditionalFeatures(snap.additionalFeatures)
    setDescription(snap.description)
    setSpecificPosition(snap.specificPosition)
    setUnlistedName(snap.unlistedName)
  }

  /**
   * Capture & identify: attach the photo first (so the evidence is kept even if
   * the call fails), then pre-fill the form from the model's reading of it.
   * Nothing is saved here — the inspector still reviews and taps Save.
   */
  /**
   * Fills the form from one image. Shared by the camera, an uploaded file and
   * a photo already attached — the inspector may have shot it before the
   * catalog existed, or on a laptop with no camera at all.
   */
  async function runIdentify(input: Blob | Blob[]) {
    if (!ctx?.room) return
    const outcome = await identifyPhoto(input, {
      roomId: ctx.room.id,
      expectedAssetName: isUnlisted ? undefined : ctx.assetType?.name,
    })

    if (!outcome.ok) {
      // "Could not identify" told nobody anything — including me, when the
      // user reported a failure I then could not reproduce. Each cause now
      // says what it was and what to do about it.
      const messages: Record<string, StringKey> = {
        offline: 'ai.offline',
        'not-connected': 'ai.notConnected',
        'vision-not-configured': 'ai.notConfigured',
        'vision-timeout': 'ai.timeout',
        'vision-unreachable': 'ai.unreachable',
        'vision-upstream': 'ai.upstream',
        'vision-bad-response': 'ai.badResponse',
        unauthorized: 'ai.notConnected',
      }
      flash(t(messages[outcome.error] ?? 'ai.failed'))
      return
    }

    const snapshot = currentSnapshot()
    const r = outcome.result
    let filled = 0
    const fill = (value: string, setter: (v: string) => void) => {
      if (!value) return
      setter(value)
      filled += 1
    }

    if (!notPresent && r.quantity > 0 && r.quantity !== quantity) {
      setQuantity(r.quantity)
      filled += 1
    }
    setCondition(r.condition)
    filled += 1

    fill(r.serialNumber, (v) => setSerials((prev) => [v, ...prev.slice(1)]))
    fill(r.brand, setBrand)
    fill(r.model, setModel)
    fill(r.itemType, setItemType)
    fill(r.material, setMaterial)
    fill(r.colour, setColour)
    fill(r.additionalFeatures, setAdditionalFeatures)
    fill(r.description, setDescription)
    fill(r.specificPosition, setSpecificPosition)
    fill(r.remarks, setRemarks)
    if (isUnlisted) fill(r.itemName, setUnlistedName)

    setAiSnapshot(snapshot)
    setAiAssisted(true)
    setShowDetails(true)
    flash(t('ai.filled', { n: filled }))
  }

  /** Camera or file picker, then identify. The photo is attached either way. */
  async function onIdentifyPhoto(files: FileList | null) {
    const file = files?.[0]
    if (!file || !ctx?.room) return

    setIdentifying(true)
    setError(null)
    try {
      // Attached first, so the evidence survives a failed or slow call.
      const { blob, width, height } = await compressImage(file)
      setPhotos((prev) => [...prev, { id: uid('ph_'), blob, width, height, persisted: false }])
      await runIdentify(blob)
    } catch {
      flash(t('ai.failed'))
    } finally {
      setIdentifying(false)
      if (aiFileRef.current) aiFileRef.current.value = ''
      if (aiUploadRef.current) aiUploadRef.current.value = ''
    }
  }

  /** Identify photos already on the entry; nothing is attached again. */
  async function identifyAttached(photoIds: string[]) {
    const blobs = photos.filter((p) => photoIds.includes(p.id)).map((p) => p.blob)
    if (blobs.length === 0) return
    setIdentifying(true)
    setError(null)
    try {
      await runIdentify(blobs)
    } catch {
      flash(t('ai.failed'))
    } finally {
      setIdentifying(false)
    }
  }

  function nextUnrecordedType(): string | null {
    const recorded = new Set(entries.filter((e) => !e.deleted && !e.isUnlistedItem).map((e) => e.assetTypeId))
    const current = isUnlisted ? null : assetTypeId
    const idx = assetTypes.findIndex((a) => a.id === current)
    for (let i = idx + 1; i < assetTypes.length; i += 1) {
      if (!recorded.has(assetTypes[i].id)) return assetTypes[i].id
    }
    return assetTypes.find((a) => !recorded.has(a.id) && a.id !== current)?.id ?? null
  }

  async function persist(): Promise<boolean> {
    if (!exercise || !inspector || !floor) return false
    setError(null)
    setBusy(true)
    try {
      const entry = await saveEntry({
        id: existing?.id,
        exerciseId: exercise.id,
        room,
        floor,
        assetType,
        isUnlistedItem: isUnlisted,
        unlistedItemName: isUnlisted ? unlistedName : undefined,
        quantity,
        serialNumbers: notPresent ? [] : serials,
        model: notPresent ? '' : model,
        brand: notPresent ? '' : brand,
        condition,
        conditionBreakdown: splitCondition && !notPresent ? breakdown : undefined,
        remarks,
        material,
        colour,
        itemType,
        additionalFeatures,
        description,
        specificPosition,
        aiAssisted,
        expectedRoomId: expectedRoomId || undefined,
        inspectorId: inspector.id,
        notPresent,
        manualTagNumbers: notPresent ? [] : manualTags ? tagDraft : undefined,
        photoIds: photos.map((p) => p.id),
      })

      // Photos are written only once the entry itself is saved, so an abandoned
      // form never leaves orphaned blobs behind in IndexedDB.
      for (const p of photos.filter((x) => !x.persisted)) {
        await db.photos.add({
          id: p.id,
          entryId: entry.id,
          exerciseId: exercise.id,
          data: await blobToArrayBuffer(p.blob),
          contentType: p.blob.type || 'image/jpeg',
          width: p.width,
          height: p.height,
          createdAt: Date.now(),
          syncStatus: 'pending',
        })
      }
      if (removedPhotoIds.length > 0) await db.photos.bulkDelete(removedPhotoIds)
      setPhotos((prev) => prev.map((p) => ({ ...p, persisted: true })))
      setRemovedPhotoIds([])
      return true
    } catch (err) {
      if (err instanceof ValidationError) setError(err.message as StringKey)
      else setError('entry.quantityRequired')
      return false
    } finally {
      setBusy(false)
    }
  }

  async function save(goNext: boolean) {
    const ok = await persist()
    if (!ok) return
    if (!goNext) {
      navigate(`/room/${room.id}`)
      return
    }
    const next = nextUnrecordedType()
    if (next) {
      // No field clearing here: the route keys EntryPage on the item, so this
      // navigation remounts it with fresh state. A hand-written reset list is
      // what let the previous item's values leak into the next one.
      navigate(`/room/${room.id}/item/${next}`)
    } else {
      navigate(`/room/${room.id}`)
    }
  }

  async function moveToType() {
    if (!existing || !moveTo || !inspector) return
    const target = assetTypes.find((a) => a.id === moveTo)
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      await convertToAssetType(existing.id, target, inspector.id)
      navigate(`/room/${room.id}/item/${target.id}`)
    } catch (err) {
      setError(err instanceof ConversionError ? (err.message as StringKey) : 'convert.failed')
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!existing) return
    if (!window.confirm(t('common.confirm'))) return
    await deleteEntry(existing.id)
    navigate(`/room/${room.id}`)
  }

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center gap-2">
        <Link to={`/room/${room.id}`} className="btn-ghost px-2" aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-slate-900">{title}</h1>
          <p className="truncate text-xs text-slate-500">
            {floor?.name} · {room.name}
            {!isUnlisted && assetType ? ` · ${assetType.code}` : ''}
          </p>
        </div>
      </div>

      {isUnlisted && (
        <Card className="p-4">
          <Field label={t('entry.unlistedName')} hint={`${t('common.code')}: ${assetCode}`}>
            <TextInput value={unlistedName} onChange={(e) => setUnlistedName(e.target.value)} autoFocus />
          </Field>
        </Card>
      )}

      {/* Photo first: it is what the inspector does on walking up to the item,
          and photo recognition fills the rest of the form from it. */}
      {!notPresent && (
        <>
          <Card className="space-y-3 p-4">
            <span className="flex items-center gap-1.5">
              <span className="field-label mb-0">{t('entry.photo')}</span>
              {editedBadge('photos')}
            </span>
            <div className="flex flex-wrap gap-2">
              {previews.map((p) => (
                <div key={p.id} className="relative">
                  <img src={p.url} alt="" className="h-20 w-20 rounded-xl object-cover" />
                  <button
                    type="button"
                    onClick={() => removePhoto(p.id)}
                    className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white"
                    aria-label={t('entry.removePhoto')}
                  >
                    ×
                  </button>
                  {/* Any attached photo can be read, not only one just taken:
                      it may have been shot before the catalog existed, or
                      uploaded from a laptop with no camera. */}
                  <button
                    type="button"
                    disabled={identifying || busy}
                    onClick={() => void identifyAttached([p.id])}
                    className="absolute inset-x-0 bottom-0 rounded-b-xl bg-slate-900/70 py-0.5 text-[10px] font-bold text-white disabled:opacity-50"
                  >
                    {t('ai.identifyThis')}
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-300 text-[10px] font-semibold text-slate-500"
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 8l2-3h6l2 3h5a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V8z" strokeLinejoin="round" />
                  <circle cx="11.5" cy="13" r="3.5" />
                </svg>
                {t('entry.takePhoto')}
              </button>
              <button
                type="button"
                onClick={() => uploadRef.current?.click()}
                className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-300 text-[10px] font-semibold text-slate-500"
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 16V4m0 0L8 8m4-4l4 4" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" strokeLinecap="round" />
                </svg>
                {t('entry.uploadPhoto')}
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => void onPickPhotos(e.target.files)}
            />
            {/* No `capture`, so this opens the gallery or the file picker
                rather than the camera — the only route on a desktop. */}
            <input
              ref={uploadRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => void onPickPhotos(e.target.files)}
            />

            <Button
              type="button"
              variant="secondary"
              full
              disabled={identifying || busy}
              onClick={() => aiFileRef.current?.click()}
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z" strokeLinejoin="round" />
                <path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" strokeLinejoin="round" />
              </svg>
              {identifying ? t('ai.identifying') : t('ai.capture')}
            </Button>
            <input
              ref={aiFileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => void onIdentifyPhoto(e.target.files)}
            />

            <Button
              type="button"
              variant="secondary"
              full
              disabled={identifying || busy}
              onClick={() => aiUploadRef.current?.click()}
            >
              {t('ai.uploadAndIdentify')}
            </Button>

            {/* Front, back and the serial plate read together describe an item
                far better than any one of them. */}
            {photos.length > 1 && (
              <Button
                type="button"
                variant="secondary"
                full
                disabled={identifying || busy}
                onClick={() => void identifyAttached(photos.slice(0, MAX_IDENTIFY_IMAGES).map((p) => p.id))}
              >
                {t('ai.identifyAll', { n: Math.min(photos.length, MAX_IDENTIFY_IMAGES) })}
              </Button>
            )}
            <input
              ref={aiUploadRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => void onIdentifyPhoto(e.target.files)}
            />

            {aiAssisted && (
              <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3">
                <span aria-hidden="true" className="text-base leading-none">
                  ⚠
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-amber-900">{t('ai.reviewBanner')}</p>
                  {aiSnapshot && (
                    <button
                      type="button"
                      onClick={() => {
                        restoreSnapshot(aiSnapshot)
                        setAiSnapshot(null)
                        setAiAssisted(false)
                      }}
                      className="mt-1 text-xs font-bold text-amber-900 underline"
                    >
                      {t('ai.undo')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </Card>

          <Card className="p-4">
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="flex w-full items-center justify-between gap-2 text-left"
              aria-expanded={showDetails}
            >
              <span>
                <span className="block text-sm font-bold text-slate-800">{t('entry.moreDetails')}</span>
                <span className="block text-xs text-slate-500">
                  {detailsFilled > 0 ? t('entry.detailsFilled', { n: detailsFilled }) : t('entry.moreDetailsHint')}
                </span>
              </span>
              <svg
                viewBox="0 0 24 24"
                className={`h-5 w-5 shrink-0 text-slate-400 transition ${showDetails ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {showDetails && (
              <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                <Field
                  label={t('entry.itemType')}
                  hint={t('entry.itemTypeHint')}
                  edited={editedFields.has('itemType') ? t('history.edited') : undefined}
                >
                  <TextInput value={itemType} onChange={(e) => setItemType(e.target.value)} />
                </Field>
                <Field
                  label={t('entry.material')}
                  hint={t('entry.materialHint')}
                  edited={editedFields.has('material') ? t('history.edited') : undefined}
                >
                  <TextInput value={material} onChange={(e) => setMaterial(e.target.value)} />
                </Field>
                <Field
                  label={t('entry.colour')}
                  hint={t('entry.colourHint')}
                  edited={editedFields.has('colour') ? t('history.edited') : undefined}
                >
                  <TextInput value={colour} onChange={(e) => setColour(e.target.value)} />
                </Field>
                <Field
                  label={t('entry.additionalFeatures')}
                  hint={t('entry.additionalFeaturesHint')}
                  edited={editedFields.has('additionalFeatures') ? t('history.edited') : undefined}
                >
                  <TextInput
                    value={additionalFeatures}
                    onChange={(e) => setAdditionalFeatures(e.target.value)}
                  />
                </Field>
                <Field
                  label={t('entry.specificPosition')}
                  hint={t('entry.specificPositionHint')}
                  edited={editedFields.has('specificPosition') ? t('history.edited') : undefined}
                >
                  <TextInput value={specificPosition} onChange={(e) => setSpecificPosition(e.target.value)} />
                </Field>
                <Field
                  label={t('entry.description')}
                  hint={t('entry.descriptionHint')}
                  edited={editedFields.has('description') ? t('history.edited') : undefined}
                >
                  <TextArea value={description} onChange={(e) => setDescription(e.target.value)} />
                </Field>

                {/* A physical verification records what is in front of you.
                    This records that it is in the wrong place, so the variance
                    report can list what has to be carried back. */}
                <Field
                  label={t('entry.expectedRoom')}
                  hint={t('entry.expectedRoomHint')}
                  edited={editedFields.has('expectedRoomId') ? t('history.edited') : undefined}
                >
                  <Select value={expectedRoomId} onChange={(e) => setExpectedRoomId(e.target.value)}>
                    <option value="">{t('entry.expectedRoomSame')}</option>
                    {allRooms
                      .filter((r) => r.id !== room.id)
                      .map((r) => ({ room: r, floor: allFloors.find((f) => f.id === r.floorId) }))
                      .sort(
                        (a, b) =>
                          (a.floor?.sortOrder ?? 99) - (b.floor?.sortOrder ?? 99) ||
                          a.room.sortOrder - b.room.sortOrder,
                      )
                      .map(({ room: r, floor: f }) => (
                        <option key={r.id} value={r.id}>
                          {f?.name ?? ''} · {r.name}
                        </option>
                      ))}
                  </Select>
                </Field>
              </div>
            )}
          </Card>
        </>
      )}

      <Card className="space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-1.5">
            <span className="field-label mb-0">{t('entry.quantity')}</span>
            {editedBadge('quantity')}
          </span>
          <button
            type="button"
            onClick={() => setNotPresent((v) => !v)}
            aria-pressed={notPresent}
            className={`rounded-xl border px-3 py-2 text-xs font-bold ${
              notPresent ? 'border-slate-700 bg-slate-800 text-white' : 'border-slate-300 text-slate-600'
            }`}
          >
            {t('entry.notPresent')}
          </button>
        </div>

        {!notPresent && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setQty(quantity - 1)}
              className="h-14 w-14 shrink-0 rounded-xl border border-slate-300 text-2xl font-bold text-slate-600 active:bg-slate-100"
              aria-label="minus"
            >
              −
            </button>
            <TextInput
              type="number"
              inputMode="numeric"
              min={1}
              value={quantity}
              onChange={(e) => setQty(Number(e.target.value))}
              className="h-14 text-center text-2xl font-bold"
            />
            <button
              type="button"
              onClick={() => setQty(quantity + 1)}
              className="h-14 w-14 shrink-0 rounded-xl border border-slate-300 text-2xl font-bold text-slate-600 active:bg-slate-100"
              aria-label="plus"
            >
              +
            </button>
          </div>
        )}

        {notPresent && (
          <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
            {t('entry.notPresent')} — {t('entry.notPresentShort')}
          </p>
        )}
      </Card>

      {!notPresent && (
        <>
          <Card className="space-y-3 p-4">
            <span className="flex items-center gap-1.5">
              <span className="field-label mb-0">{t('entry.condition')}</span>
              {editedBadge('condition')}
            </span>
            {quantity > 1 && (
              <Segmented
                value={splitCondition ? 'split' : 'bulk'}
                onChange={(v) => setSplitCondition(v === 'split')}
                options={[
                  { value: 'bulk', label: t('entry.bulk') },
                  { value: 'split', label: t('entry.split') },
                ]}
              />
            )}

            {!splitCondition || quantity === 1 ? (
              <div className="grid grid-cols-2 gap-2">
                {CONDITIONS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setCondition(c)}
                    aria-pressed={condition === c}
                    className={`flex min-h-[52px] items-center justify-center gap-2 rounded-xl border-2 px-3 py-2 text-sm font-bold transition ${
                      condition === c
                        ? 'border-slate-900 bg-slate-900 text-white'
                        : 'border-slate-200 bg-white text-slate-700'
                    }`}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: CONDITION_STYLE[c].color }}
                    />
                    {t(`condition.${c}`)}
                  </button>
                ))}
              </div>
            ) : (
              <div className="space-y-2">
                {CONDITIONS.map((c) => (
                  <div key={c} className="flex items-center gap-3">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: CONDITION_STYLE[c].color }}
                    />
                    <span className="flex-1 text-sm font-semibold text-slate-700">{t(`condition.${c}`)}</span>
                    <TextInput
                      type="number"
                      inputMode="numeric"
                      min={0}
                      value={breakdown[c] ?? ''}
                      placeholder="0"
                      onChange={(e) =>
                        setBreakdown((prev) => {
                          const next = { ...prev }
                          const n = Number(e.target.value)
                          if (!e.target.value || Number.isNaN(n) || n <= 0) delete next[c]
                          else next[c] = Math.round(n)
                          return next
                        })
                      }
                      className="w-24 text-center font-bold"
                    />
                  </div>
                ))}
                <p className={`text-xs font-semibold ${breakdownOk ? 'text-slate-500' : 'text-red-600'}`}>
                  {breakdownSum} / {quantity} {breakdownOk ? '' : `— ${t('entry.breakdownError')}`}
                </p>
              </div>
            )}
          </Card>

          <Card className="space-y-3 p-4">
            <Field
              label={t('entry.serial')}
              hint={t('entry.serialHint')}
              edited={editedFields.has('serialNumbers') ? t('history.edited') : undefined}
            >
              <div className="flex gap-2">
                <TextInput
                  value={serials[0] ?? ''}
                  onChange={(e) => setSerials((prev) => [e.target.value, ...prev.slice(1)])}
                  placeholder="SN-…"
                />
                <Button
                  type="button"
                  variant="secondary"
                  className="shrink-0 px-3"
                  onClick={() => setSerials((prev) => ['N/A', ...prev.slice(1)])}
                >
                  {t('entry.na')}
                </Button>
              </div>
            </Field>

            {quantity > 1 && (
              <label className="flex items-center gap-2 text-sm text-slate-600">
                <input
                  type="checkbox"
                  checked={perItemSerials}
                  onChange={(e) => {
                    const on = e.target.checked
                    setPerItemSerials(on)
                    setSerials((prev) => {
                      if (!on) return [prev[0] ?? '']
                      const copy = prev.slice(0, quantity)
                      while (copy.length < quantity) copy.push('')
                      return copy
                    })
                  }}
                  className="h-5 w-5 rounded border-slate-300"
                />
                {t('entry.serial')} — 1…{quantity}
              </label>
            )}

            {perItemSerials && quantity > 1 && (
              <div className="max-h-64 space-y-2 overflow-y-auto rounded-xl bg-slate-50 p-2">
                {Array.from({ length: quantity }).map((_, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="w-14 shrink-0 font-mono text-[11px] text-slate-500">
                      {tagDraft[i]?.split('-').pop() ?? String(i + 1).padStart(3, '0')}
                    </span>
                    <TextInput
                      value={serials[i] ?? ''}
                      onChange={(e) =>
                        setSerials((prev) => {
                          const copy = [...prev]
                          copy[i] = e.target.value
                          return copy
                        })
                      }
                      className="py-2"
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label={t('entry.brand')} edited={editedFields.has('brand') ? t('history.edited') : undefined}>
                <TextInput value={brand} onChange={(e) => setBrand(e.target.value)} />
              </Field>
              <Field label={t('entry.model')} edited={editedFields.has('model') ? t('history.edited') : undefined}>
                <TextInput value={model} onChange={(e) => setModel(e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <span className="field-label mb-0">{t('entry.tag')}</span>
                {editedBadge('tagNumbers')}
              </span>
              <button
                type="button"
                onClick={() => setManualTags((v) => !v)}
                className="text-xs font-bold text-brand-700"
              >
                {manualTags ? t('entry.tagAuto') : t('entry.tagManual')}
              </button>
            </div>

            {manualTags ? (
              <div className="space-y-2">
                {Array.from({ length: quantity }).map((_, i) => (
                  <TextInput
                    key={i}
                    value={tagDraft[i] ?? ''}
                    onChange={(e) =>
                      setTagDraft((prev) => {
                        const copy = [...prev]
                        copy[i] = e.target.value.toUpperCase()
                        return copy
                      })
                    }
                    className="font-mono"
                    placeholder={`${assetCode}-${floor?.code ?? ''}-${room.code}-${String(i + 1).padStart(3, '0')}`}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {tagDraft.slice(0, 40).map((tag) => (
                  <span key={tag} className="chip bg-brand-50 font-mono text-brand-800">
                    {tag}
                  </span>
                ))}
                {tagDraft.length > 40 && (
                  <span className="chip bg-slate-100 text-slate-600">+{tagDraft.length - 40}</span>
                )}
                {tagDraft.length === 0 && <span className="text-xs text-slate-400">—</span>}
              </div>
            )}
          </Card>
        </>
      )}


      {isUnlisted && existing && assetTypes.length > 0 && (
        <Card className="space-y-2 p-4">
          <span className="field-label mb-0">{t('convert.title')}</span>
          <p className="text-xs text-slate-500">{t('convert.hint')}</p>
          <div className="flex gap-2">
            <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className="flex-1">
              <option value="">{t('convert.choose')}</option>
              {assetTypes.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {assetName(lang, a.name, a.nameSw)}
                </option>
              ))}
            </Select>
            <Button type="button" variant="secondary" disabled={!moveTo || busy} onClick={() => void moveToType()}>
              {t('convert.move')}
            </Button>
          </div>
          {tagDraft.length > 0 && <p className="text-xs text-amber-700">{t('convert.tagsKept')}</p>}
        </Card>
      )}

      <Card className="p-4">
        <Field
          label={t('entry.remarks')}
          hint={t('common.optional')}
          edited={editedFields.has('remarks') ? t('history.edited') : undefined}
        >
          <TextArea value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        </Field>
      </Card>

      {history.length > 0 && (
        <Card className="p-4">
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            className="flex w-full items-center justify-between gap-2 text-left"
            aria-expanded={showHistory}
          >
            <span>
              <span className="block text-sm font-bold text-slate-800">{t('history.title')}</span>
              <span className="block text-xs text-slate-500">{t('history.count', { n: history.length })}</span>
            </span>
            <svg
              viewBox="0 0 24 24"
              className={`h-5 w-5 shrink-0 text-slate-400 transition ${showHistory ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {showHistory && (
            <ol className="mt-3 space-y-3 border-t border-slate-100 pt-3">
              {[...history].reverse().map((h, i) => (
                <li key={`${h.editedAt}-${h.field}-${i}`} className="text-xs">
                  <p className="font-bold text-slate-700">{fieldLabel(h.field)}</p>
                  <p className="mt-0.5 text-slate-600">
                    <span className="text-slate-400 line-through">{valueLabel(h.field, h.oldValue)}</span>
                    <span aria-hidden="true"> → </span>
                    <span className="font-semibold text-slate-900">{valueLabel(h.field, h.newValue)}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {whoById.get(h.editedBy) ?? t('common.inspector')} · {fmtWhen(h.editedAt)}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {error && (
        <p className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{t(error)}</p>
      )}

      <div className="space-y-2">
        <div className="flex gap-2">
          <Button variant="secondary" full onClick={() => void save(false)} disabled={busy || !breakdownOk}>
            {t('common.save')}
          </Button>
          <Button full onClick={() => void save(true)} disabled={busy || !breakdownOk}>
            {t('common.saveNext')}
          </Button>
        </div>
        {existing && (
          <Button variant="danger" full onClick={() => void remove()} disabled={busy}>
            {t('common.delete')}
          </Button>
        )}
      </div>

      <Toast message={toast} />
    </div>
  )
}
