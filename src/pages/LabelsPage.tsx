import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db/db'
import {
  collectLabels,
  labelMatchesQuery,
  labelMatchesSearchTerms,
  labelSearchSuggestions,
  printLabels,
  type LabelData,
  type LabelScope,
  type LabelSearchField,
  type LabelSearchTerm,
} from '../lib/labels'
import { photoBlob } from '../lib/photos'
import { reissueTagsWithAssetCode } from '../lib/tags'
import {
  changeSelectedAssetNames,
  planRoomTagNames,
  retagRoomEntries,
  type AssetNameTarget,
  type RoomTagChange,
} from '../lib/entries'
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

interface EditableTagChange extends RoomTagChange {
  selected: boolean
  description: string
}

interface EditableAssetNameItem {
  entryId: string
  tagNumber: string
  selected: boolean
  description: string
  brand: string
  serial: string
}

interface ChosenAssetName {
  target: AssetNameTarget
  label: string
}

// Several labels can belong to one inspection entry. Keep their initial photo
// request shared so a quantity of 50 does not start 50 identical downloads.
const pendingPhotoLoads = new Map<string, Promise<number>>()

function ensureLabelPhotos(entryId: string): Promise<number> {
  const current = pendingPhotoLoads.get(entryId)
  if (current) return current

  const request = ensureEntryPhotos(entryId).finally(() => pendingPhotoLoads.delete(entryId))
  pendingPhotoLoads.set(entryId, request)
  return request
}

export default function LabelsPage() {
  const t = useT()
  const { exercise, inspector } = useSession()
  const [scope, setScope] = useState<LabelScope>('exercise')
  const [floorId, setFloorId] = useState('')
  const [roomId, setRoomId] = useState('')
  const [query, setQuery] = useState('')
  const [searchTerms, setSearchTerms] = useState<LabelSearchTerm[]>([])
  const [searchFocused, setSearchFocused] = useState(false)
  const [condition, setCondition] = useState<Condition | ''>('')
  const [photoFilter, setPhotoFilter] = useState<PhotoFilter>('all')
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [selected, setSelected] = useState<LabelData | null>(null)
  const [retagRoom, setRetagRoom] = useState<{ id: string; name: string } | null>(null)
  const [tagChanges, setTagChanges] = useState<EditableTagChange[]>([])
  const [tagCode, setTagCode] = useState('')
  const [retagError, setRetagError] = useState<string | null>(null)
  const [assetNameRoom, setAssetNameRoom] = useState<{ id: string; name: string } | null>(null)
  const [assetNameItems, setAssetNameItems] = useState<EditableAssetNameItem[]>([])
  const [assetNameQuery, setAssetNameQuery] = useState('')
  const [assetNameFocused, setAssetNameFocused] = useState(false)
  const [chosenAssetName, setChosenAssetName] = useState<ChosenAssetName | null>(null)
  const [assetNameError, setAssetNameError] = useState<string | null>(null)

  const floors = useLiveQuery(async () => {
    if (!exercise) return []
    return (await db.floors.where('exerciseId').equals(exercise.id).toArray())
      .filter((floor) => !floor.deleted)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }, [exercise?.id])

  const rooms = useLiveQuery(async () => {
    if (!floorId) return []
    return (await db.rooms.where('floorId').equals(floorId).toArray())
      .filter((room) => !room.deleted)
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }, [floorId])

  const assetTypes = useLiveQuery(async () => {
    if (!exercise) return []
    return (await db.assetTypes.where('orgId').equals(exercise.orgId).toArray())
      .filter((assetType) => assetType.active)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
  }, [exercise?.orgId])

  const sheet = useLiveQuery(async () => {
    if (!exercise) return undefined
    return collectLabels({ exerciseId: exercise.id, scope, roomId, floorId })
  }, [exercise?.id, scope, roomId, floorId])

  const suggestions = useMemo(
    () => labelSearchSuggestions(sheet?.labels ?? [], searchTerms, query),
    [sheet, searchTerms, query],
  )

  const filteredLabels = useMemo(() => {
    if (!sheet) return []
    return sheet.labels.filter((label) => {
      if (condition && label.condition !== condition) return false
      if (photoFilter === 'with' && label.photoCount === 0) return false
      if (photoFilter === 'without' && label.photoCount > 0) return false
      return labelMatchesSearchTerms(label, searchTerms) && labelMatchesQuery(label, query)
    })
  }, [sheet, query, searchTerms, condition, photoFilter])

  const visibleLabels = filteredLabels.slice(0, MAX_VISIBLE)
  const groups = useMemo(() => {
    const grouped = new Map<string, { roomId: string; block: string; floor: string; room: string; labels: LabelData[] }>()
    for (const label of visibleLabels) {
      const key = label.roomId
      const group = grouped.get(key) ?? {
        roomId: label.roomId,
        block: label.block,
        floor: label.floor,
        room: label.room,
        labels: [],
      }
      group.labels.push(label)
      grouped.set(key, group)
    }
    return [...grouped.values()]
  }, [visibleLabels])
  const mismatchedTagsByRoom = useMemo(() => {
    const counts = new Map<string, number>()
    for (const label of sheet?.labels ?? []) {
      if (!label.tagMatchesLocation) counts.set(label.roomId, (counts.get(label.roomId) ?? 0) + 1)
    }
    return counts
  }, [sheet])

  const hasFilters = Boolean(query.trim() || searchTerms.length || condition || photoFilter !== 'all')
  const selectedTagChanges = tagChanges.filter((change) => change.selected)
  const selectedTagNames = selectedTagChanges.map((change) => change.proposedTag.trim().toUpperCase())
  const tagChangesInvalid = selectedTagNames.some((tag) => !tag || /\s/.test(tag)) ||
    new Set(selectedTagNames).size !== selectedTagNames.length
  const selectedAssetNameItems = assetNameItems.filter((item) => item.selected)
  const assetNameSuggestions = useMemo(() => {
    const needle = assetNameQuery.trim().toLocaleLowerCase()
    return (assetTypes ?? []).filter((assetType) =>
      !needle || [assetType.name, assetType.nameSw ?? '', assetType.code, assetType.category]
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    )
  }, [assetTypes, assetNameQuery])

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

  async function openTagNameEditor(id: string, name: string) {
    setBusy(true)
    setRetagError(null)
    try {
      const plan = await planRoomTagNames(id)
      const plannedByTag = new Map(plan.map((change) => [`${change.entryId}\u0000${change.currentTag}`, change]))
      // Respect the active Labels filters. If the user narrowed Reception to
      // two benches, the editor must not unexpectedly include every other
      // asset in Reception.
      const roomLabels = filteredLabels.filter((label) => label.roomId === id)
      setTagChanges(roomLabels.map((label) => {
        const planned = plannedByTag.get(`${label.entryId}\u0000${label.tag}`)
        return {
          entryId: label.entryId,
          currentTag: label.tag,
          proposedTag: planned?.proposedTag ?? label.tag,
          selected: Boolean(planned),
          description: label.description,
        }
      }))
      setTagCode('')
      setRetagRoom({ id, name })
    } catch {
      setToast(t('labels.tagNamesFailed'))
      setTimeout(() => setToast(null), 2600)
    } finally {
      setBusy(false)
    }
  }

  function applyTagCodeToSelected() {
    const code = tagCode.trim().toUpperCase()
    const selectedKeys = new Set(
      selectedTagChanges.map((change) => `${change.entryId}\u0000${change.currentTag}`),
    )
    const occupiedTags = (sheet?.labels ?? [])
      .filter((label) => !selectedKeys.has(`${label.entryId}\u0000${label.tag}`))
      .map((label) => label.tag)
    const proposedTags = reissueTagsWithAssetCode(
      selectedTagChanges.map((change) => change.currentTag),
      code,
      occupiedTags,
    )
    if (!proposedTags || proposedTags.some((tag) => !tag)) {
      setRetagError(t('labels.tagCodeInvalid'))
      return
    }

    const proposedByKey = new Map(
      selectedTagChanges.map((change, index) => [
        `${change.entryId}\u0000${change.currentTag}`,
        proposedTags[index],
      ]),
    )
    setTagChanges((current) => current.map((change) => ({
      ...change,
      proposedTag: proposedByKey.get(`${change.entryId}\u0000${change.currentTag}`) ?? change.proposedTag,
    })))
    setRetagError(null)
  }

  async function updateRoomTagNames() {
    if (!retagRoom || !inspector) return
    const selectedChanges = selectedTagChanges
    if (selectedChanges.length === 0) return
    setBusy(true)
    setRetagError(null)
    try {
      const result = await retagRoomEntries({
        roomId: retagRoom.id,
        actorId: inspector.id,
        changes: selectedChanges,
      })
      setRetagRoom(null)
      setTagChanges([])
      setTagCode('')
      setToast(t('labels.tagNamesUpdated', { n: result.changedTags, room: retagRoom.name }))
      setTimeout(() => setToast(null), 2600)
    } catch {
      setRetagError(t('labels.tagNamesFailed'))
    } finally {
      setBusy(false)
    }
  }

  function closeAssetNameEditor() {
    setAssetNameRoom(null)
    setAssetNameItems([])
    setAssetNameQuery('')
    setAssetNameFocused(false)
    setChosenAssetName(null)
    setAssetNameError(null)
  }

  function openAssetNameEditor(id: string, name: string) {
    const labels = filteredLabels.filter((label) => label.roomId === id)
    setAssetNameItems(labels.map((label) => ({
      entryId: label.entryId,
      tagNumber: label.tag,
      selected: true,
      description: label.description,
      brand: label.brand,
      serial: label.serial,
    })))
    setAssetNameRoom({ id, name })
    setAssetNameQuery('')
    setChosenAssetName(null)
    setAssetNameError(null)
  }

  async function updateSelectedAssetNames() {
    if (!assetNameRoom || !chosenAssetName || !inspector || selectedAssetNameItems.length === 0) return
    setBusy(true)
    setAssetNameError(null)
    try {
      const result = await changeSelectedAssetNames({
        roomId: assetNameRoom.id,
        actorId: inspector.id,
        selections: selectedAssetNameItems.map((item) => ({
          entryId: item.entryId,
          tagNumber: item.tagNumber,
        })),
        target: chosenAssetName.target,
      })
      const roomName = assetNameRoom.name
      closeAssetNameEditor()
      setToast(t('labels.assetNamesUpdated', { n: result.changedItems, room: roomName }))
      setTimeout(() => setToast(null), 2600)
    } catch {
      setAssetNameError(t('labels.assetNamesFailed'))
    } finally {
      setBusy(false)
    }
  }

  function searchFieldLabel(field: LabelSearchField): string {
    if (field === 'block') return t('labels.searchFieldBlock')
    if (field === 'floor') return t('labels.searchFieldFloor')
    if (field === 'room') return t('labels.searchFieldRoom')
    if (field === 'brand') return t('labels.searchFieldBrand')
    return t('labels.searchFieldAsset')
  }

  function addSearchTerm(term: LabelSearchTerm) {
    setSearchTerms((current) => [...current, term])
    setQuery('')
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

        <div className="space-y-2">
          {searchTerms.length > 0 && (
            <div className="flex flex-wrap gap-2" aria-label={t('labels.selectedSearchFilters')}>
              {searchTerms.map((term) => {
                const fieldLabel = searchFieldLabel(term.field)
                return (
                  <span
                    key={`${term.field}:${term.value}`}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-brand-200 bg-brand-50 py-1 pl-2.5 pr-1 text-xs text-brand-900"
                  >
                    <span className="shrink-0 text-[10px] font-bold uppercase text-brand-600">{fieldLabel}</span>
                    <span className="truncate font-semibold">{term.value}</span>
                    <button
                      type="button"
                      onClick={() => setSearchTerms((current) => current.filter((candidate) => candidate !== term))}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-lg leading-none text-brand-700 hover:bg-brand-100"
                      aria-label={t('labels.removeSearchFilter', { field: fieldLabel, value: term.value })}
                    >
                      &times;
                    </button>
                  </span>
                )
              })}
            </div>
          )}

          <div className="relative">
            <Field label={t('common.search')} hint={t('labels.searchHint')}>
              <TextInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setSearchFocused(false)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && suggestions[0]) {
                    event.preventDefault()
                    addSearchTerm(suggestions[0])
                  } else if (event.key === 'Escape') {
                    setSearchFocused(false)
                  }
                }}
                placeholder={t('labels.searchPlaceholder')}
                type="search"
                autoComplete="off"
                aria-autocomplete="list"
                aria-expanded={searchFocused && suggestions.length > 0}
                aria-controls="label-search-suggestions"
              />
            </Field>

            {searchFocused && suggestions.length > 0 && (
              <div
                id="label-search-suggestions"
                role="listbox"
                aria-label={t('labels.searchSuggestions')}
                className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl"
              >
                {suggestions.map((suggestion) => {
                  const fieldLabel = searchFieldLabel(suggestion.field)
                  return (
                    <button
                      key={`${suggestion.field}:${suggestion.value}`}
                      type="button"
                      role="option"
                      aria-selected="false"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => addSearchTerm(suggestion)}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-brand-50 active:bg-brand-100"
                    >
                      <span className="w-16 shrink-0 text-[10px] font-bold uppercase text-slate-400">{fieldLabel}</span>
                      <span className="min-w-0 truncate text-sm font-semibold text-slate-800">{suggestion.value}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
          <span>{t('labels.showing', { shown: filteredLabels.length, total: sheet?.labels.length ?? 0 })}</span>
          {hasFilters && (
            <button
              type="button"
              className="font-bold text-brand-700"
              onClick={() => {
                setQuery('')
                setSearchTerms([])
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
              <section key={group.roomId}>
                <div className="mb-1.5 flex items-center justify-between gap-2 px-1">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-bold text-slate-800">{group.room || '—'}</p>
                    <p className="truncate text-[11px] text-slate-500">
                      {[group.block, group.floor].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    {inspector?.role === 'admin' && (
                      <button
                        type="button"
                        onClick={() => openAssetNameEditor(group.roomId, group.room)}
                        disabled={busy}
                        className="rounded-full border border-brand-300 bg-brand-50 px-2.5 py-1 text-[10px] font-bold text-brand-800 hover:bg-brand-100"
                      >
                        {t('labels.changeAssetNames')}
                      </button>
                    )}
                    {inspector?.role === 'admin' && (
                      <button
                        type="button"
                        onClick={() => void openTagNameEditor(group.roomId, group.room)}
                        disabled={busy}
                        className={`rounded-full border px-2.5 py-1 text-[10px] font-bold ${
                          (mismatchedTagsByRoom.get(group.roomId) ?? 0) > 0
                            ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {t('labels.editTagNames')}
                      </button>
                    )}
                    <span className="chip bg-slate-100 text-slate-600">
                      {t('labels.count', { n: group.labels.length })}
                    </span>
                  </div>
                </div>

                <Card className="divide-y divide-slate-100 p-0">
                  {group.labels.map((label) => (
                    <div key={label.tag} className="flex w-full items-center gap-3 px-3 py-3">
                      <LabelPhotoCarousel label={label} />
                      <button
                        type="button"
                        onClick={() => setSelected(label)}
                        className="flex min-w-0 flex-1 flex-col items-start self-stretch py-1 text-left active:opacity-70"
                      >
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="font-mono text-xs font-bold text-slate-900">{label.tag}</span>
                          {label.photoCount > 0 && (
                            <span className="text-[11px] font-semibold text-brand-700">📷 {label.photoCount}</span>
                          )}
                        </div>
                        <p className="truncate text-xs text-slate-600">{label.description}</p>
                        {label.brand && (
                          <p className="max-w-full truncate text-[11px] font-semibold text-brand-700">
                            {t('entry.brand')}: {label.brand}
                          </p>
                        )}
                        {label.serial && <p className="truncate text-[11px] text-slate-400">{label.serial}</p>}
                        <span className={`chip mt-auto inline-block ${CONDITION_STYLE[label.condition].chip}`}>
                          {t(`condition.${label.condition}`)}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelected(label)}
                        className="flex h-10 w-7 shrink-0 items-center justify-end text-slate-300 active:text-brand-700"
                        aria-label={label.tag}
                      >
                        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </div>
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
      <Sheet
        open={Boolean(retagRoom)}
        onClose={() => {
          setRetagRoom(null)
          setTagChanges([])
          setTagCode('')
          setRetagError(null)
        }}
        title={t('labels.updateTagNamesTitle')}
      >
        <div className="max-h-[calc(100dvh-7rem)] space-y-4 overflow-y-auto pr-1">
          <p className="text-sm text-slate-700">
            {t('labels.updateTagNamesConfirm', { n: tagChanges.length, room: retagRoom?.name ?? '' })}
          </p>
          <p className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">{t('labels.updateTagNamesHint')}</p>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-slate-500">
              {t('labels.tagSelectionCount', {
                selected: selectedTagChanges.length,
                total: tagChanges.length,
              })}
            </span>
            <button
              type="button"
              onClick={() => {
                const select = !tagChanges.every((change) => change.selected)
                setTagChanges((current) => current.map((change) => ({ ...change, selected: select })))
                setRetagError(null)
              }}
              className="text-xs font-bold text-brand-700"
            >
              {tagChanges.every((change) => change.selected)
                ? t('labels.clearTagSelection')
                : t('labels.selectAllTags')}
            </button>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <Field label={t('labels.tagCode')} hint={t('labels.tagCodeHint')}>
              <div className="flex gap-2">
                <TextInput
                  value={tagCode}
                  onChange={(event) => {
                    setTagCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))
                    setRetagError(null)
                  }}
                  placeholder={t('labels.tagCodePlaceholder')}
                  autoComplete="off"
                />
                <Button
                  onClick={applyTagCodeToSelected}
                  disabled={!tagCode.trim() || selectedTagChanges.length === 0}
                >
                  {t('labels.applyTagCode')}
                </Button>
              </div>
            </Field>
          </div>

          <div className="max-h-[38dvh] space-y-2 overflow-y-auto pr-1">
            {tagChanges.map((change, index) => (
              <div
                key={`${change.entryId}:${change.currentTag}`}
                className={`rounded-xl border p-3 ${
                  change.selected ? 'border-brand-300 bg-brand-50/50' : 'border-slate-200 bg-white'
                }`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={change.selected}
                    onChange={(event) => {
                      const selected = event.target.checked
                      setTagChanges((current) => current.map((candidate, candidateIndex) =>
                        candidateIndex === index ? { ...candidate, selected } : candidate,
                      ))
                      setRetagError(null)
                    }}
                    className="mt-1 h-5 w-5 shrink-0 accent-brand-700"
                    aria-label={t('labels.selectTagForUpdate', { tag: change.currentTag })}
                  />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div>
                      <p className="truncate font-mono text-xs font-bold text-slate-800">{change.currentTag}</p>
                      {change.description && (
                        <p className="truncate text-[11px] text-slate-500">{change.description}</p>
                      )}
                    </div>
                    <TextInput
                      value={change.proposedTag}
                      onChange={(event) => {
                        const proposedTag = event.target.value.toUpperCase()
                        setTagChanges((current) => current.map((candidate, candidateIndex) =>
                          candidateIndex === index ? { ...candidate, proposedTag, selected: true } : candidate,
                        ))
                        setRetagError(null)
                      }}
                      disabled={!change.selected}
                      aria-label={t('labels.newTagNameFor', { tag: change.currentTag })}
                      autoComplete="off"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          {retagError && (
            <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{retagError}</p>
          )}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              full
              onClick={() => {
                setRetagRoom(null)
                setTagChanges([])
                setTagCode('')
                setRetagError(null)
              }}
              disabled={busy}
            >
              {t('common.cancel')}
            </Button>
            <Button
              full
              onClick={() => void updateRoomTagNames()}
              disabled={
                busy ||
                !retagRoom ||
                selectedTagChanges.length === 0 ||
                tagChangesInvalid
              }
            >
              {t('labels.updateSelectedTagNames', {
                n: selectedTagChanges.length,
              })}
            </Button>
          </div>
        </div>
      </Sheet>
      <Sheet
        open={Boolean(assetNameRoom)}
        onClose={closeAssetNameEditor}
        title={t('labels.changeAssetNamesTitle')}
      >
        <div className="max-h-[calc(100dvh-7rem)] space-y-4 overflow-y-auto pr-1">
          <p className="text-sm text-slate-700">
            {t('labels.changeAssetNamesConfirm', {
              room: assetNameRoom?.name ?? '',
              n: assetNameItems.length,
            })}
          </p>
          <p className="rounded-xl bg-brand-50 p-3 text-xs text-brand-900">{t('labels.changeAssetNamesHint')}</p>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-semibold text-slate-500">
              {t('labels.assetSelectionCount', {
                selected: selectedAssetNameItems.length,
                total: assetNameItems.length,
              })}
            </span>
            <button
              type="button"
              onClick={() => {
                const select = !assetNameItems.every((item) => item.selected)
                setAssetNameItems((current) => current.map((item) => ({ ...item, selected: select })))
                setAssetNameError(null)
              }}
              className="text-xs font-bold text-brand-700"
            >
              {assetNameItems.every((item) => item.selected)
                ? t('labels.clearAssetSelection')
                : t('labels.selectAllAssets')}
            </button>
          </div>

          <div className="max-h-[30dvh] space-y-2 overflow-y-auto pr-1">
            {assetNameItems.map((item, index) => (
              <label
                key={`${item.entryId}:${item.tagNumber}`}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${
                  item.selected ? 'border-brand-300 bg-brand-50/50' : 'border-slate-200 bg-white'
                }`}
              >
                <input
                  type="checkbox"
                  checked={item.selected}
                  onChange={(event) => {
                    const selected = event.target.checked
                    setAssetNameItems((current) => current.map((candidate, candidateIndex) =>
                      candidateIndex === index ? { ...candidate, selected } : candidate,
                    ))
                    setAssetNameError(null)
                  }}
                  className="mt-1 h-5 w-5 shrink-0 accent-brand-700"
                  aria-label={t('labels.selectAssetForNameChange', { tag: item.tagNumber })}
                />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs font-bold text-slate-800">{item.tagNumber}</span>
                  <span className="block truncate text-xs text-slate-600">{item.description}</span>
                  {(item.brand || item.serial) && (
                    <span className="block truncate text-[11px] text-slate-400">
                      {[item.brand, item.serial].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </span>
              </label>
            ))}
          </div>

          <div className="space-y-2">
            <div className="relative">
              <Field label={t('labels.correctAssetName')} hint={t('labels.correctAssetNameHint')}>
                <TextInput
                  value={assetNameQuery}
                  onChange={(event) => {
                    setAssetNameQuery(event.target.value)
                    setChosenAssetName(null)
                    setAssetNameError(null)
                  }}
                  onFocus={() => setAssetNameFocused(true)}
                  onBlur={() => setAssetNameFocused(false)}
                  placeholder={t('labels.assetNamePlaceholder')}
                  autoComplete="off"
                  aria-autocomplete="list"
                  aria-expanded={assetNameFocused && assetNameSuggestions.length > 0}
                />
              </Field>
              {assetNameFocused && assetNameSuggestions.length > 0 && (
                <div
                  role="listbox"
                  aria-label={t('labels.assetNameSuggestions')}
                  className="absolute inset-x-0 top-full z-20 mt-1 max-h-52 overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl"
                >
                  {assetNameSuggestions.map((assetType) => (
                    <button
                      key={assetType.id}
                      type="button"
                      role="option"
                      aria-selected="false"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        setChosenAssetName({
                          target: { kind: 'catalog', assetTypeId: assetType.id },
                          label: assetType.name,
                        })
                        setAssetNameQuery(assetType.name)
                        setAssetNameFocused(false)
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left hover:bg-brand-50"
                    >
                      <span className="w-12 shrink-0 text-[10px] font-bold uppercase text-slate-400">{assetType.code}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-slate-800">{assetType.name}</span>
                        <span className="block truncate text-[11px] text-slate-400">{assetType.category}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {assetNameQuery.trim() && !chosenAssetName && (
              <button
                type="button"
                onClick={() => setChosenAssetName({
                  target: { kind: 'custom', name: assetNameQuery.trim() },
                  label: assetNameQuery.trim(),
                })}
                className="w-full rounded-xl border border-dashed border-brand-300 px-3 py-2.5 text-left text-sm font-bold text-brand-800 hover:bg-brand-50"
              >
                {t('labels.useCustomAssetName', { name: assetNameQuery.trim() })}
              </button>
            )}

            {chosenAssetName && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-brand-300 bg-brand-50 p-3">
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase text-brand-600">{t('labels.selectedAssetName')}</p>
                  <p className="truncate text-sm font-bold text-brand-900">{chosenAssetName.label}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setChosenAssetName(null)
                    setAssetNameQuery('')
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-xl text-brand-700 hover:bg-brand-100"
                  aria-label={t('labels.removeSelectedAssetName')}
                >
                  &times;
                </button>
              </div>
            )}
          </div>

          {assetNameError && (
            <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{assetNameError}</p>
          )}

          <div className="flex gap-2">
            <Button variant="secondary" full onClick={closeAssetNameEditor} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              full
              onClick={() => void updateSelectedAssetNames()}
              disabled={busy || selectedAssetNameItems.length === 0 || !chosenAssetName}
            >
              {t('labels.changeSelectedAssetNames', { n: selectedAssetNameItems.length })}
            </Button>
          </div>
        </div>
      </Sheet>
      <Toast message={toast} />
    </div>
  )
}

/** Large, swipeable photo preview with previous/next controls for every label. */
function LabelPhotoCarousel({ label }: { label: LabelData }) {
  const t = useT()
  const scroller = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const photoIdsKey = label.photoIds.join('\u0000')

  useEffect(() => {
    if (label.photoIds.length > 0) void ensureLabelPhotos(label.entryId)
  }, [label.entryId, photoIdsKey])

  const photos = useLiveQuery(async () => {
    if (label.photoIds.length === 0) return []
    const candidates = await db.photos.bulkGet(label.photoIds)
    return candidates.filter((candidate) => candidate !== undefined)
  }, [label.entryId, photoIdsKey])

  const urls = useMemo(
    () => (photos ?? []).map((photo) => ({ id: photo.id, url: URL.createObjectURL(photoBlob(photo)) })),
    [photos],
  )
  useEffect(() => () => {
    urls.forEach((photo) => URL.revokeObjectURL(photo.url))
  }, [urls])

  useEffect(() => setActive(0), [photoIdsKey])

  function showPhoto(index: number) {
    const next = Math.max(0, Math.min(index, urls.length - 1))
    setActive(next)
    const node = scroller.current
    if (!node) return
    if (typeof node.scrollTo === 'function') {
      node.scrollTo({ left: next * node.clientWidth, behavior: 'smooth' })
    } else {
      node.scrollLeft = next * node.clientWidth
    }
  }

  return (
    <div className="w-28 shrink-0 sm:w-36">
      <div
        ref={scroller}
        className="flex h-24 snap-x snap-mandatory overflow-x-auto rounded-xl bg-slate-100 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:h-28"
        onScroll={(event) => {
          const width = event.currentTarget.clientWidth
          if (width > 0) setActive(Math.min(urls.length - 1, Math.max(0, Math.round(event.currentTarget.scrollLeft / width))))
        }}
      >
        {urls.length > 0 ? urls.map((photo, index) => (
          <img
            key={photo.id}
            src={photo.url}
            alt={t('labels.photoPreview', { item: label.description })}
            className="h-full min-w-full snap-center object-cover"
            loading={index === 0 ? 'eager' : 'lazy'}
          />
        )) : photos === undefined ? (
          <span className="h-full min-w-full animate-pulse bg-slate-200" aria-hidden="true" />
        ) : (
          <span className="flex h-full min-w-full items-center justify-center">
            <svg
              viewBox="0 0 24 24"
              className="h-7 w-7 text-slate-300"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-label={label.photoCount > 0 ? t('labels.photoPreview', { item: label.description }) : t('labels.noPhoto')}
            >
              <path d="M4 8.5A1.5 1.5 0 015.5 7H8l1-2h6l1 2h2.5A1.5 1.5 0 0120 8.5v8a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 16.5v-8z" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M9.5 12.5a2.5 2.5 0 105 0 2.5 2.5 0 00-5 0z" strokeLinecap="round" />
              {label.photoCount === 0 && <path d="M5 19L19 5" strokeLinecap="round" />}
            </svg>
          </span>
        )}
      </div>

      {urls.length > 0 && (
        <div className="mt-1 flex h-7 items-center gap-1">
          <button
            type="button"
            onClick={() => showPhoto(active - 1)}
            disabled={active === 0}
            className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 disabled:text-slate-200"
            aria-label={t('labels.previousPhoto', { item: label.description })}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M15 6l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="min-w-0 flex-1">
            <p className="text-center text-[9px] font-semibold leading-none text-slate-400" aria-live="polite">
              {active + 1} / {urls.length}
            </p>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-200">
              <span
                className="block h-full rounded-full bg-brand-600 transition-transform"
                style={{ width: `${100 / urls.length}%`, transform: `translateX(${active * 100}%)` }}
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => showPhoto(active + 1)}
            disabled={active >= urls.length - 1}
            className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 disabled:text-slate-200"
            aria-label={t('labels.nextPhoto', { item: label.description })}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}

/** Shows every photo attached to the selected label's inspection entry. */
function LabelPhotoSheet({ label, onClose }: { label: LabelData | null; onClose: () => void }) {
  const t = useT()
  const [zoomedPhoto, setZoomedPhoto] = useState<{ id: string; url: string } | null>(null)

  useEffect(() => {
    if (!label) return
    void ensureEntryPhotos(label.entryId)
  }, [label?.entryId])

  useEffect(() => setZoomedPhoto(null), [label?.entryId, label?.tag])

  const photos = useLiveQuery(
    async () => (label ? db.photos.where('entryId').equals(label.entryId).toArray() : []),
    [label?.entryId],
  )

  const urls = useMemo(
    () => (photos ?? [])
      .filter((photo) => !label || label.photoIds.includes(photo.id))
      .map((photo) => ({ id: photo.id, url: URL.createObjectURL(photoBlob(photo)) })),
    [photos, label],
  )
  useEffect(() => () => urls.forEach((item) => URL.revokeObjectURL(item.url)), [urls])

  if (!label) return null

  return (
    <Sheet open onClose={onClose} title={label.tag}>
      <div className="space-y-3">
        <div>
          <p className="font-semibold text-slate-900">{label.description}</p>
          {label.brand && (
            <p className="text-sm font-semibold text-brand-700">
              {t('entry.brand')}: {label.brand}
            </p>
          )}
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
              <button
                key={item.id}
                type="button"
                onClick={() => setZoomedPhoto(item)}
                className="relative overflow-hidden rounded-xl bg-slate-100 text-left"
                aria-label={t('labels.openZoom', { item: label.description })}
              >
                <img
                  src={item.url}
                  alt={t('labels.photoPreview', { item: label.description })}
                  className="aspect-square w-full object-cover"
                />
                <span className="absolute bottom-2 right-2 flex h-8 w-8 items-center justify-center rounded-full bg-slate-950/70 text-white shadow">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="6" />
                    <path d="M15.5 15.5L20 20M11 8v6M8 11h6" strokeLinecap="round" />
                  </svg>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {zoomedPhoto && (
        <ZoomPhotoViewer
          photo={zoomedPhoto}
          item={label.description}
          tag={label.tag}
          onClose={() => setZoomedPhoto(null)}
        />
      )}
    </Sheet>
  )
}

/** Full-screen viewer that can enlarge fine print such as serial numbers. */
function ZoomPhotoViewer({
  photo,
  item,
  tag,
  onClose,
}: {
  photo: { id: string; url: string }
  item: string
  tag: string
  onClose: () => void
}) {
  const t = useT()
  const viewport = useRef<HTMLDivElement>(null)
  const pinchStart = useRef<{ distance: number; zoom: number } | null>(null)
  const [zoom, setZoom] = useState(1)

  useEffect(() => {
    setZoom(1)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [photo.id, onClose])

  function changeZoom(value: number) {
    const next = Math.max(1, Math.min(5, value))
    const node = viewport.current
    const centerX = node && node.scrollWidth > 0 ? (node.scrollLeft + node.clientWidth / 2) / node.scrollWidth : 0.5
    const centerY = node && node.scrollHeight > 0 ? (node.scrollTop + node.clientHeight / 2) / node.scrollHeight : 0.5
    setZoom(next)
    if (!node) return
    requestAnimationFrame(() => {
      node.scrollLeft = centerX * node.scrollWidth - node.clientWidth / 2
      node.scrollTop = centerY * node.scrollHeight - node.clientHeight / 2
    })
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col bg-slate-950 text-white"
      role="dialog"
      aria-modal="true"
      aria-label={t('labels.zoomViewer', { item })}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/15 bg-slate-950/95 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-bold">{tag}</p>
          <p className="truncate text-xs text-slate-300">{item}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-3xl leading-none"
          aria-label={t('common.close')}
        >
          &times;
        </button>
      </div>

      <div
        ref={viewport}
        className="min-h-0 flex-1 overflow-auto overscroll-contain bg-black"
        style={{ touchAction: 'pan-x pan-y' }}
        onDoubleClick={() => changeZoom(zoom > 1 ? 1 : 3)}
        onTouchStart={(event) => {
          if (event.touches.length !== 2) return
          const [a, b] = [event.touches[0], event.touches[1]]
          pinchStart.current = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom }
        }}
        onTouchMove={(event) => {
          if (event.touches.length !== 2 || !pinchStart.current) return
          event.preventDefault()
          const [a, b] = [event.touches[0], event.touches[1]]
          const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
          setZoom(Math.max(1, Math.min(5, pinchStart.current.zoom * distance / pinchStart.current.distance)))
        }}
        onTouchEnd={(event) => {
          if (event.touches.length < 2) pinchStart.current = null
        }}
      >
        <div
          className="flex items-center justify-center"
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%`, minWidth: '100%', minHeight: '100%' }}
        >
          <img
            src={photo.url}
            alt={t('labels.photoPreview', { item })}
            className="h-full w-full select-none object-contain"
            draggable={false}
          />
        </div>
      </div>

      <div className="shrink-0 border-t border-white/15 bg-slate-950 px-3 pb-[calc(.75rem+var(--safe-bottom))] pt-2">
        <p className="mb-2 text-center text-[11px] text-slate-300">{t('labels.zoomHint')}</p>
        <div className="mx-auto flex max-w-md items-center gap-3">
          <button
            type="button"
            onClick={() => changeZoom(zoom - 0.5)}
            disabled={zoom <= 1}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-2xl font-bold disabled:opacity-30"
            aria-label={t('labels.zoomOut')}
          >
            &minus;
          </button>
          <input
            type="range"
            min="1"
            max="5"
            step="0.25"
            value={zoom}
            onChange={(event) => changeZoom(Number(event.target.value))}
            className="min-w-0 flex-1 accent-brand-400"
            aria-label={t('labels.zoomLevel')}
          />
          <button
            type="button"
            onClick={() => changeZoom(zoom + 0.5)}
            disabled={zoom >= 5}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/10 text-2xl font-bold disabled:opacity-30"
            aria-label={t('labels.zoomIn')}
          >
            +
          </button>
          <button
            type="button"
            onClick={() => changeZoom(1)}
            className="h-11 min-w-[3.5rem] shrink-0 rounded-xl bg-white/10 px-2 text-xs font-bold"
            aria-label={t('labels.resetZoom')}
          >
            {Math.round(zoom * 100)}%
          </button>
        </div>
      </div>
    </div>
  )
}
