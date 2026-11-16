import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import { assetName, useI18n, useT } from '../i18n'
import { useSession } from '../state/session'
import { entryConditionCounts } from '../lib/queries'
import { MoveEntriesError, markNotPresent, moveEntriesToRoom, reopenRoom, signoffRoom } from '../lib/entries'
import { printLabels, collectLabels } from '../lib/labels'
import {
  Button,
  CONDITION_STYLE,
  Card,
  EmptyState,
  Field,
  ProgressBar,
  SectionTitle,
  Select,
  Sheet,
  TextArea,
  TextInput,
  Toast,
} from '../components/ui'
import { CONDITIONS, type Condition, type InspectionEntry } from '../types'

export default function RoomPage() {
  const { roomId = '' } = useParams()
  const t = useT()
  const { lang } = useI18n()
  const navigate = useNavigate()
  const { exercise, inspector } = useSession()
  const [toast, setToast] = useState<string | null>(null)
  const [signSheet, setSignSheet] = useState(false)
  const [signNotes, setSignNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [assetSearch, setAssetSearch] = useState('')
  const [moveSheet, setMoveSheet] = useState(false)
  const [moveEntryIds, setMoveEntryIds] = useState<Set<string>>(new Set())
  const [moveTargetRoomId, setMoveTargetRoomId] = useState('')
  const [moveError, setMoveError] = useState<string | null>(null)

  const data = useLiveQuery(async () => {
    const room = await db.rooms.get(roomId)
    if (!room) return null
    const [floor, allAssetTypes, entries, signoff, inspectors, rooms, floors, blocks] = await Promise.all([
      db.floors.get(room.floorId),
      db.assetTypes.orderBy('sortOrder').toArray(),
      db.entries.where('roomId').equals(roomId).toArray(),
      db.signoffs.where('roomId').equals(roomId).first(),
      db.inspectors.toArray(),
      db.rooms.where('exerciseId').equals(room.exerciseId).toArray(),
      db.floors.where('exerciseId').equals(room.exerciseId).toArray(),
      db.blocks.where('exerciseId').equals(room.exerciseId).toArray(),
    ])
    return {
      room,
      floor,
      assetTypes: allAssetTypes.filter((a) => a.active),
      allAssetTypes,
      entries: entries.filter((e) => !e.deleted),
      signoff: signoff && !signoff.deleted ? signoff : undefined,
      inspectors,
      rooms,
      floors,
      blocks: blocks.filter((block) => !block.deleted),
    }
  }, [roomId])

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 1800)
  }

  if (data === undefined) return <p className="text-sm text-slate-500">{t('common.loading')}</p>
  if (data === null) return <EmptyState title={t('common.empty')} />

  const { room, floor, assetTypes, allAssetTypes, entries, signoff, inspectors, rooms, floors, blocks } = data
  const byType = new Map(entries.filter((e) => !e.isUnlistedItem).map((e) => [e.assetTypeId, e]))
  const unlisted = entries.filter((e) => e.isUnlistedItem)
  const checked = byType.size
  const itemsFound = entries.filter((e) => !e.notPresent).reduce((n, e) => n + e.quantity, 0)
  const tagCount = entries.reduce((n, e) => n + e.tagNumbers.length, 0)
  const signedBy = signoff ? inspectors.find((i) => i.id === signoff.inspectorId)?.name : undefined
  const assetNeedle = assetSearch.trim().toLocaleLowerCase()
  const visibleAssetTypes = assetTypes.filter((assetType) => {
    if (!assetNeedle) return true
    return `${assetType.name} ${assetType.nameSw ?? ''} ${assetType.code} ${assetType.category}`
      .toLocaleLowerCase()
      .includes(assetNeedle)
  })
  const effectiveBlockId = room.blockId ?? floor?.blockId
  const floorRoute = `/inspect/${room.floorId}?block=${encodeURIComponent(effectiveBlockId || 'unassigned')}`
  const assetTypeById = new Map(allAssetTypes.map((assetType) => [assetType.id, assetType]))
  const floorById = new Map(floors.map((candidate) => [candidate.id, candidate]))
  const blockById = new Map(blocks.map((candidate) => [candidate.id, candidate]))
  const entryLabel = (entry: InspectionEntry) => {
    if (entry.isUnlistedItem) return entry.unlistedItemName ?? t('entry.unlisted')
    const assetType = entry.assetTypeId ? assetTypeById.get(entry.assetTypeId) : undefined
    return assetType ? assetName(lang, assetType.name, assetType.nameSw) : t('entry.assetType')
  }
  const moveCandidates = [...entries].sort((a, b) => entryLabel(a).localeCompare(entryLabel(b)))
  const targetRooms = rooms
    .filter((candidate) => candidate.id !== room.id)
    .sort((a, b) => {
      const floorA = floorById.get(a.floorId)
      const floorB = floorById.get(b.floorId)
      const blockA = blockById.get(a.blockId ?? floorA?.blockId ?? '')
      const blockB = blockById.get(b.blockId ?? floorB?.blockId ?? '')
      return (
        (blockA?.sortOrder ?? Number.MAX_SAFE_INTEGER) - (blockB?.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
        (floorA?.sortOrder ?? Number.MAX_SAFE_INTEGER) - (floorB?.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
        a.sortOrder - b.sortOrder
      )
    })
  const selectedMoveEntries = moveCandidates.filter((entry) => moveEntryIds.has(entry.id))
  const selectedMoveItems = selectedMoveEntries.reduce(
    (sum, entry) => sum + (entry.notPresent ? 0 : entry.quantity),
    0,
  )

  function targetRoomLabel(target: typeof room): string {
    const targetFloor = floorById.get(target.floorId)
    const targetBlock = blockById.get(target.blockId ?? targetFloor?.blockId ?? '')
    return [targetBlock?.name, targetFloor?.name, target.name].filter(Boolean).join(' · ')
  }

  function openMoveItems() {
    setMoveEntryIds(new Set())
    setMoveTargetRoomId('')
    setMoveError(null)
    setMoveSheet(true)
  }

  async function doMoveItems() {
    if (!inspector || !moveTargetRoomId || moveEntryIds.size === 0) return
    setBusy(true)
    setMoveError(null)
    try {
      const result = await moveEntriesToRoom({
        sourceRoomId: room.id,
        targetRoomId: moveTargetRoomId,
        entryIds: [...moveEntryIds],
        actorId: inspector.id,
      })
      setMoveSheet(false)
      setMoveEntryIds(new Set())
      setMoveTargetRoomId('')
      flash(t('room.moveSuccess', { cards: result.movedCards, items: result.movedItems }))
    } catch (error) {
      if (error instanceof MoveEntriesError && error.code === 'destination-conflict') {
        setMoveError(t('room.moveConflict'))
      } else {
        setMoveError(t('room.moveFailed'))
      }
    } finally {
      setBusy(false)
    }
  }

  async function quickNotPresent(assetTypeId: string) {
    if (!exercise || !inspector || !floor) return
    const assetType = assetTypes.find((a) => a.id === assetTypeId)
    if (!assetType) return
    setBusy(true)
    try {
      await markNotPresent({ exerciseId: exercise.id, room, floor, assetType, inspectorId: inspector.id })
      flash(`${assetName(lang, assetType.name, assetType.nameSw)} — ${t('entry.notPresent')}`)
    } finally {
      setBusy(false)
    }
  }

  async function doSignoff() {
    if (!exercise || !inspector) return
    setBusy(true)
    try {
      await signoffRoom({ exerciseId: exercise.id, roomId: room.id, inspectorId: inspector.id, notes: signNotes })
      setSignSheet(false)
      setSignNotes('')
      flash(t('common.done'))
      navigate(floorRoute)
    } finally {
      setBusy(false)
    }
  }

  async function printRoomLabels() {
    if (!exercise) return
    const sheet = await collectLabels({ exerciseId: exercise.id, scope: 'room', roomId: room.id })
    if (sheet.labels.length === 0) {
      flash(t('labels.nothing'))
      return
    }
    const ok = await printLabels(sheet)
    if (!ok) flash(t('labels.nothing'))
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Link to={floorRoute} className="btn-ghost px-2" aria-label={t('common.back')}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-slate-900">{room.name}</h1>
          <p className="text-xs text-slate-500">
            {floor?.name} · {room.code}
          </p>
        </div>
        {signoff && (
          <span className="chip bg-emerald-100 text-emerald-800">{t('status.done')}</span>
        )}
      </div>

      <Card className="px-4 py-3">
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="font-semibold text-slate-700">
            {t('room.progress', { done: checked, total: assetTypes.length })}
          </span>
          <span className="text-slate-500">{t('room.itemsFound', { n: itemsFound })}</span>
        </div>
        <ProgressBar value={checked} total={assetTypes.length} />
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-500">
          <span>{t('entry.tagCount', { n: tagCount })}</span>
          {unlisted.length > 0 && <span>· {t('room.unlistedFound', { n: unlisted.length })}</span>}
          {signedBy && <span>· {t('room.signedBy', { name: signedBy })}</span>}
        </div>
      </Card>

      <SectionTitle
        action={
          <Link to={`/room/${room.id}/item/new`} className="text-xs font-bold text-brand-700">
            + {t('entry.addUnlisted')}
          </Link>
        }
      >
        {t('entry.assetType')}
      </SectionTitle>

      <TextInput
        type="search"
        aria-label={t('entry.searchAsset')}
        placeholder={t('entry.searchAssetPlaceholder')}
        value={assetSearch}
        onChange={(event) => setAssetSearch(event.target.value)}
      />

      {assetNeedle && (
        <p className="text-xs text-slate-500">
          {t('common.showingResults', { shown: visibleAssetTypes.length, total: assetTypes.length })}
        </p>
      )}

      <ul className="space-y-2">
        {visibleAssetTypes.map((at) => {
          const entry = byType.get(at.id)
          return (
            <li key={at.id}>
              <AssetRow
                label={assetName(lang, at.name, at.nameSw)}
                code={at.code}
                entry={entry}
                disabled={busy}
                onOpen={() => navigate(`/room/${room.id}/item/${at.id}`)}
                onNotPresent={() => void quickNotPresent(at.id)}
              />
            </li>
          )
        })}
      </ul>

      {visibleAssetTypes.length === 0 && (
        <EmptyState title={t('common.noResults')} hint={t('entry.searchAssetHint')} />
      )}

      {unlisted.length > 0 && (
        <>
          <SectionTitle>{t('entry.unlisted')}</SectionTitle>
          <ul className="space-y-2">
            {unlisted.map((e) => (
              <li key={e.id}>
                <AssetRow
                  label={e.unlistedItemName ?? t('entry.unlisted')}
                  code="UL"
                  entry={e}
                  disabled={busy}
                  onOpen={() => navigate(`/room/${room.id}/item/new?entry=${e.id}`)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="space-y-2 pt-2">
        {inspector?.role === 'admin' && entries.length > 0 && (
          <Button variant="secondary" full onClick={openMoveItems} disabled={busy}>
            {t('room.moveItems')}
          </Button>
        )}

        <Button variant="secondary" full onClick={() => void printRoomLabels()}>
          {t('labels.print')} — {t('labels.room')}
        </Button>

        {signoff ? (
          <Button variant="danger" full onClick={() => void reopenRoom(room.id)} disabled={busy}>
            {t('room.reopen')}
          </Button>
        ) : (
          <Button full onClick={() => setSignSheet(true)} disabled={busy || entries.length === 0}>
            {t('room.signoff')}
          </Button>
        )}
      </div>

      <Sheet open={moveSheet} onClose={() => setMoveSheet(false)} title={t('room.moveItems')}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">{t('room.moveItemsHint')}</p>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-slate-500">
              {t('room.moveSelectionCount', { selected: moveEntryIds.size, total: moveCandidates.length })}
            </span>
            <button
              type="button"
              onClick={() => {
                setMoveEntryIds(
                  moveEntryIds.size === moveCandidates.length
                    ? new Set()
                    : new Set(moveCandidates.map((entry) => entry.id)),
                )
                setMoveError(null)
              }}
              className="text-xs font-bold text-brand-700"
            >
              {moveEntryIds.size === moveCandidates.length ? t('room.clearSelection') : t('room.selectAllItems')}
            </button>
          </div>

          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {moveCandidates.map((entry) => {
              const checkedForMove = moveEntryIds.has(entry.id)
              const label = entryLabel(entry)
              return (
                <label
                  key={entry.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${
                    checkedForMove ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-white'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checkedForMove}
                    onChange={() => {
                      setMoveEntryIds((current) => {
                        const next = new Set(current)
                        if (next.has(entry.id)) next.delete(entry.id)
                        else next.add(entry.id)
                        return next
                      })
                      setMoveError(null)
                    }}
                    className="h-5 w-5 shrink-0 accent-brand-700"
                    aria-label={t('room.selectMoveItem', { item: label })}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-slate-900">{label}</span>
                    <span className="text-xs text-slate-500">
                      {entry.notPresent ? t('entry.notPresent') : t('room.moveQuantity', { n: entry.quantity })}
                    </span>
                  </span>
                </label>
              )
            })}
          </div>

          <Field label={t('room.moveDestination')}>
            <Select
              value={moveTargetRoomId}
              onChange={(event) => {
                setMoveTargetRoomId(event.target.value)
                setMoveError(null)
              }}
            >
              <option value="">{t('room.chooseDestination')}</option>
              {targetRooms.map((target) => (
                <option key={target.id} value={target.id}>
                  {targetRoomLabel(target)}
                </option>
              ))}
            </Select>
          </Field>

          {moveEntryIds.size > 0 && (
            <div className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
              <p className="font-semibold text-slate-800">
                {t('room.moveSummary', { cards: moveEntryIds.size, items: selectedMoveItems })}
              </p>
              <p className="mt-1">{t('room.moveKeepsData')}</p>
            </div>
          )}

          {moveError && (
            <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">
              {moveError}
            </p>
          )}

          <div className="flex gap-2">
            <Button variant="secondary" full onClick={() => setMoveSheet(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              full
              onClick={() => void doMoveItems()}
              disabled={busy || moveEntryIds.size === 0 || !moveTargetRoomId}
            >
              {moveEntryIds.size === moveCandidates.length
                ? t('room.moveAllItems')
                : t('room.moveSelectedItems', { n: moveEntryIds.size })}
            </Button>
          </div>
        </div>
      </Sheet>

      <Sheet open={signSheet} onClose={() => setSignSheet(false)} title={t('room.signoff')}>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">{t('room.signoffConfirm')}</p>
          <div className="rounded-xl bg-slate-50 p-3 text-sm">
            <p>
              <span className="text-slate-500">{t('room.progress', { done: checked, total: assetTypes.length })}</span>
            </p>
            <p className="font-semibold">{t('room.itemsFound', { n: itemsFound })}</p>
          </div>
          <Field label={t('room.signoffNotes')} hint={t('common.optional')}>
            <TextArea value={signNotes} onChange={(e) => setSignNotes(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button variant="secondary" full onClick={() => setSignSheet(false)}>
              {t('common.cancel')}
            </Button>
            <Button full onClick={() => void doSignoff()} disabled={busy}>
              {t('common.done')}
            </Button>
          </div>
        </div>
      </Sheet>

      <Toast message={toast} />
    </div>
  )
}

function AssetRow({
  label,
  code,
  entry,
  disabled,
  onOpen,
  onNotPresent,
}: {
  label: string
  code: string
  entry?: InspectionEntry
  disabled?: boolean
  onOpen: () => void
  onNotPresent?: () => void
}) {
  const tr = useT()
  const counts = entry ? entryConditionCounts(entry) : {}
  const state = !entry ? 'blank' : entry.notPresent ? 'absent' : 'recorded'

  return (
    <div
      className={`card flex items-center gap-3 px-3 py-3 ${
        state === 'recorded' ? 'border-l-4 border-l-brand-600' : state === 'absent' ? 'opacity-70' : ''
      }`}
    >
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left" disabled={disabled}>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-600">{code}</span>
          <span className="truncate font-semibold text-slate-900">{label}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
          {state === 'blank' && <span className="text-slate-400">{tr('entry.notRecorded')}</span>}
          {state === 'absent' && (
            <span className="chip bg-slate-200 text-slate-700">{tr('entry.notPresent')}</span>
          )}
          {state === 'recorded' && entry && (
            <>
              <span className="font-bold tabular-nums text-slate-900">{entry.quantity}×</span>
              {CONDITIONS.filter((c) => (counts[c] ?? 0) > 0).map((c: Condition) => (
                <span key={c} className={`chip ${CONDITION_STYLE[c].chip}`}>
                  {counts[c]} {tr(`condition.${c}`)}
                </span>
              ))}
              {entry.photoIds.length > 0 && <span className="text-slate-400">📷 {entry.photoIds.length}</span>}
            </>
          )}
        </div>
      </button>

      {state === 'blank' && onNotPresent && (
        <button
          type="button"
          onClick={onNotPresent}
          disabled={disabled}
          className="shrink-0 rounded-xl border border-slate-300 px-3 py-2 text-xs font-bold text-slate-600 active:bg-slate-100"
        >
          {tr('entry.notPresentShort')}
        </button>
      )}
    </div>
  )
}
