import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, uid } from '../db/db'
import { sha256 } from '../lib/hash'
import { deriveCode, deriveRoomCode } from '../lib/tags'
import { formatBytes, storageEstimate } from '../lib/photos'
import { createTeamAccount, getToken, resetLocalData } from '../lib/sync'
import type { StringKey } from '../i18n/strings'
import { startFresh } from '../db/seed'
import {
  VISION_MODELS,
  checkVisionAvailability,
  getVisionModel,
  setVisionModel,
  type VisionAvailability,
  type VisionModel,
} from '../lib/vision'
import { useSession } from '../state/session'
import { useT } from '../i18n'
import {
  Button,
  Card,
  Field,
  SectionTitle,
  Select,
  TextInput,
  Toast,
} from '../components/ui'
import type { AssetType, Floor, Inspector, Role, Room } from '../types'

type Tab = 'org' | 'floors' | 'assets' | 'team' | 'data'

/** Every write stamps updatedAt and re-queues the record for sync. */
async function patchFloor(id: string, fields: Partial<Floor>) {
  const row = await db.floors.get(id)
  if (row) await db.floors.put({ ...row, ...fields, updatedAt: Date.now(), syncStatus: 'pending' })
}
async function patchRoom(id: string, fields: Partial<Room>) {
  const row = await db.rooms.get(id)
  if (row) await db.rooms.put({ ...row, ...fields, updatedAt: Date.now(), syncStatus: 'pending' })
}
async function patchAsset(id: string, fields: Partial<AssetType>) {
  const row = await db.assetTypes.get(id)
  if (row) await db.assetTypes.put({ ...row, ...fields, updatedAt: Date.now(), syncStatus: 'pending' })
}
async function patchInspector(id: string, fields: Partial<Inspector>) {
  const row = await db.inspectors.get(id)
  if (row) await db.inspectors.put({ ...row, ...fields, updatedAt: Date.now(), syncStatus: 'pending' })
}

export default function SetupPage() {
  const t = useT()
  const { exercise, isAdmin, refresh } = useSession()
  const [tab, setTab] = useState<Tab>('org')
  const [toast, setToast] = useState<string | null>(null)

  function flash(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 2000)
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold text-slate-900">{t('setup.title')}</h1>
        {!isAdmin && <p className="text-xs font-semibold text-amber-700">{t('setup.adminOnly')}</p>}
      </div>

      <div className="grid grid-cols-5 gap-1 rounded-xl border border-slate-300 bg-slate-100 p-1 text-[11px] font-bold">
        {(
          [
            ['org', t('setup.org')],
            ['floors', t('setup.floors')],
            ['assets', t('setup.assets')],
            ['team', t('setup.team')],
            ['data', t('setup.data')],
          ] as Array<[Tab, string]>
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            aria-pressed={tab === key}
            className={`truncate rounded-lg px-1 py-2 transition ${
              tab === key ? 'bg-white text-brand-800 shadow-sm' : 'text-slate-600'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'org' && <OrgTab canEdit={isAdmin} onSaved={() => void refresh()} flash={flash} />}
      {tab === 'floors' && <FloorsTab canEdit={isAdmin} exerciseId={exercise?.id} flash={flash} />}
      {tab === 'assets' && <AssetsTab canEdit={isAdmin} orgId={exercise?.orgId} flash={flash} />}
      {tab === 'team' && <TeamTab canEdit={isAdmin} flash={flash} />}
      {tab === 'data' && <DataTab />}

      <Toast message={toast} />
    </div>
  )
}

// ----------------------------------------------------------------- org ------

function OrgTab({
  canEdit,
  onSaved,
  flash,
}: {
  canEdit: boolean
  onSaved: () => void
  flash: (m: string) => void
}) {
  const t = useT()
  const data = useLiveQuery(async () => {
    const [orgs, exercises, inspectors] = await Promise.all([
      db.organizations.toArray(),
      db.exercises.toArray(),
      db.inspectors.toArray(),
    ])
    return { org: orgs[0], exercise: exercises.sort((a, b) => b.updatedAt - a.updatedAt)[0], inspectors }
  }, [])

  if (!data?.org || !data.exercise) return <p className="text-sm text-slate-500">{t('common.loading')}</p>
  const { org, exercise, inspectors } = data

  async function saveOrg(fields: Partial<typeof org>) {
    await db.organizations.put({ ...org, ...fields, updatedAt: Date.now(), syncStatus: 'pending' })
  }
  async function saveExercise(fields: Partial<typeof exercise>) {
    await db.exercises.put({ ...exercise, ...fields, updatedAt: Date.now(), syncStatus: 'pending' })
    onSaved()
  }

  async function onLogo(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => void saveOrg({ logo: String(reader.result) })
    reader.readAsDataURL(file)
    flash(t('entry.saved'))
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <SectionTitle>{t('setup.org')}</SectionTitle>
        <Field label={t('setup.orgName')}>
          <TextInput
            defaultValue={org.name}
            disabled={!canEdit}
            onBlur={(e) => void saveOrg({ name: e.target.value })}
          />
        </Field>
        <Field label={t('setup.orgAddress')}>
          <TextInput
            defaultValue={org.address}
            disabled={!canEdit}
            onBlur={(e) => void saveOrg({ address: e.target.value })}
          />
        </Field>
        <Field label={t('setup.orgLogo')} hint={t('common.optional')}>
          <div className="flex items-center gap-3">
            {org.logo && <img src={org.logo} alt="" className="h-12 w-12 rounded-lg object-contain" />}
            <input
              type="file"
              accept="image/*"
              disabled={!canEdit}
              onChange={(e) => void onLogo(e.target.files?.[0])}
              className="text-xs"
            />
          </div>
        </Field>
      </Card>

      <Card className="space-y-3 p-4">
        <SectionTitle>{t('setup.exercise')}</SectionTitle>
        <Field label={t('setup.exerciseName')}>
          <TextInput
            defaultValue={exercise.name}
            disabled={!canEdit}
            onBlur={(e) => void saveExercise({ name: e.target.value })}
          />
        </Field>
        <Field label={t('setup.exerciseDate')}>
          <TextInput
            type="date"
            defaultValue={exercise.date}
            disabled={!canEdit}
            onChange={(e) => void saveExercise({ date: e.target.value })}
          />
        </Field>
        <Field label={t('setup.teamLeader')}>
          <Select
            value={exercise.teamLeaderId}
            disabled={!canEdit}
            onChange={(e) => void saveExercise({ teamLeaderId: e.target.value })}
          >
            <option value="">—</option>
            {inspectors.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('setup.approvedBy')}>
          <TextInput
            defaultValue={exercise.approvedBy}
            disabled={!canEdit}
            onBlur={(e) => void saveExercise({ approvedBy: e.target.value })}
          />
        </Field>
        <Field label={t('common.status')}>
          <Select
            value={exercise.status}
            disabled={!canEdit}
            onChange={(e) => void saveExercise({ status: e.target.value as typeof exercise.status })}
          >
            <option value="draft">{t('exercise.status.draft')}</option>
            <option value="active">{t('exercise.status.active')}</option>
            <option value="completed">{t('exercise.status.completed')}</option>
          </Select>
        </Field>
      </Card>
    </div>
  )
}

// -------------------------------------------------------------- floors -----

function FloorsTab({
  canEdit,
  exerciseId,
  flash,
}: {
  canEdit: boolean
  exerciseId?: string
  flash: (m: string) => void
}) {
  const t = useT()
  const [openFloor, setOpenFloor] = useState<string | null>(null)
  const [newFloor, setNewFloor] = useState('')
  const [newRoom, setNewRoom] = useState('')

  const data = useLiveQuery(async () => {
    if (!exerciseId) return undefined
    const [floors, rooms, entries] = await Promise.all([
      db.floors.where('exerciseId').equals(exerciseId).toArray(),
      db.rooms.where('exerciseId').equals(exerciseId).toArray(),
      db.entries.where('exerciseId').equals(exerciseId).toArray(),
    ])
    const used = new Set(entries.filter((e) => !e.deleted).map((e) => e.roomId))
    return {
      floors: floors.sort((a, b) => a.sortOrder - b.sortOrder),
      rooms: rooms.sort((a, b) => a.sortOrder - b.sortOrder),
      used,
    }
  }, [exerciseId])

  if (!data || !exerciseId) return <p className="text-sm text-slate-500">{t('common.loading')}</p>

  // Bind the narrowed values: hoisted function declarations below would
  // otherwise see the optional types again.
  const { floors, rooms, used } = data
  const exId = exerciseId

  async function addFloor() {
    const name = newFloor.trim()
    if (!name) return
    await db.floors.add({
      id: uid('fl_'),
      exerciseId: exId,
      name,
      code: deriveCode(name, 3),
      sortOrder: floors.length,
      updatedAt: Date.now(),
      syncStatus: 'pending',
    })
    setNewFloor('')
  }

  async function addRoom(floorId: string) {
    const name = newRoom.trim()
    if (!name) return
    const siblings = rooms.filter((r) => r.floorId === floorId)
    await db.rooms.add({
      id: uid('rm_'),
      floorId,
      exerciseId: exId,
      name,
      code: deriveRoomCode(name),
      sortOrder: siblings.length,
      updatedAt: Date.now(),
      syncStatus: 'pending',
    })
    setNewRoom('')
  }

  async function removeRoom(room: Room) {
    if (used.has(room.id)) {
      flash(t('setup.deleteBlocked'))
      return
    }
    await db.rooms.delete(room.id)
  }

  async function removeFloor(floor: Floor) {
    const floorRooms = rooms.filter((r) => r.floorId === floor.id)
    if (floorRooms.some((r) => used.has(r.id))) {
      flash(t('setup.deleteBlocked'))
      return
    }
    await db.rooms.bulkDelete(floorRooms.map((r) => r.id))
    await db.floors.delete(floor.id)
  }

  return (
    <div className="space-y-3">
      {floors.map((floor) => {
        const floorRooms = rooms.filter((r) => r.floorId === floor.id)
        const open = openFloor === floor.id
        return (
          <Card key={floor.id} className="p-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOpenFloor(open ? null : floor.id)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate font-semibold text-slate-900">{floor.name}</p>
                <p className="text-xs text-slate-500">
                  {floor.code} · {floorRooms.length} {t('common.rooms')}
                </p>
              </button>
              <svg
                viewBox="0 0 24 24"
                className={`h-5 w-5 text-slate-400 transition ${open ? 'rotate-90' : ''}`}
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            {open && (
              <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <Field label={t('setup.floorName')}>
                      <TextInput
                        defaultValue={floor.name}
                        disabled={!canEdit}
                        onBlur={(e) => void patchFloor(floor.id, { name: e.target.value })}
                      />
                    </Field>
                  </div>
                  <Field label={t('common.code')} hint={t('setup.codeHint')}>
                    <TextInput
                      defaultValue={floor.code}
                      disabled={!canEdit}
                      onBlur={(e) => void patchFloor(floor.id, { code: e.target.value.toUpperCase() })}
                      className="font-mono"
                    />
                  </Field>
                </div>

                <ul className="space-y-1.5">
                  {floorRooms.map((room) => (
                    <li key={room.id} className="flex items-center gap-2">
                      <TextInput
                        defaultValue={room.name}
                        disabled={!canEdit}
                        onBlur={(e) => void patchRoom(room.id, { name: e.target.value })}
                        className="py-2"
                      />
                      <TextInput
                        defaultValue={room.code}
                        disabled={!canEdit}
                        onBlur={(e) => void patchRoom(room.id, { code: e.target.value.toUpperCase() })}
                        className="w-20 py-2 text-center font-mono"
                      />
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => void removeRoom(room)}
                          className="shrink-0 rounded-lg px-2 py-2 text-lg text-slate-400 hover:bg-red-50 hover:text-red-600"
                          aria-label={t('common.delete')}
                        >
                          ×
                        </button>
                      )}
                    </li>
                  ))}
                </ul>

                {canEdit && (
                  <>
                    <div className="flex gap-2">
                      <TextInput
                        placeholder={t('setup.roomName')}
                        value={newRoom}
                        onChange={(e) => setNewRoom(e.target.value)}
                        className="py-2"
                      />
                      <Button variant="secondary" className="shrink-0 px-3" onClick={() => void addRoom(floor.id)}>
                        {t('setup.addRoom')}
                      </Button>
                    </div>
                    <Button variant="danger" full onClick={() => void removeFloor(floor)}>
                      {t('common.delete')} — {floor.name}
                    </Button>
                  </>
                )}
              </div>
            )}
          </Card>
        )
      })}

      {canEdit && (
        <Card className="flex gap-2 p-3">
          <TextInput
            placeholder={t('setup.floorName')}
            value={newFloor}
            onChange={(e) => setNewFloor(e.target.value)}
          />
          <Button className="shrink-0 px-3" onClick={() => void addFloor()}>
            {t('setup.addFloor')}
          </Button>
        </Card>
      )}
    </div>
  )
}

// -------------------------------------------------------------- assets -----

function AssetsTab({ canEdit, orgId, flash }: { canEdit: boolean; orgId?: string; flash: (m: string) => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')

  const data = useLiveQuery(async () => {
    const [assetTypes, entries] = await Promise.all([db.assetTypes.orderBy('sortOrder').toArray(), db.entries.toArray()])
    const used = new Set(entries.filter((e) => !e.deleted).map((e) => e.assetTypeId))
    return { assetTypes, used }
  }, [])

  if (!data) return <p className="text-sm text-slate-500">{t('common.loading')}</p>

  const { assetTypes, used } = data

  async function add() {
    const n = name.trim()
    if (!n || !orgId) return
    const c = (code.trim() || deriveCode(n)).toUpperCase()
    if (assetTypes.some((a) => a.code === c)) {
      flash(`${t('common.code')} ${c} — ${t('common.required')}`)
      return
    }
    await db.assetTypes.add({
      id: uid('at_'),
      orgId,
      name: n,
      code: c,
      category: 'Other',
      sortOrder: assetTypes.length,
      active: true,
      updatedAt: Date.now(),
      syncStatus: 'pending',
    })
    setName('')
    setCode('')
  }

  async function remove(at: AssetType) {
    if (used.has(at.id)) {
      flash(t('setup.deleteBlocked'))
      return
    }
    await db.assetTypes.delete(at.id)
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        {assetTypes.filter((a) => a.active).length} / {assetTypes.length} {t('common.items')}
      </p>

      <Card className="divide-y divide-slate-100">
        {assetTypes.map((at) => (
          <div key={at.id} className="space-y-2 p-3">
            <div className="flex items-center gap-2">
              <TextInput
                defaultValue={at.name}
                disabled={!canEdit}
                onBlur={(e) => void patchAsset(at.id, { name: e.target.value })}
                className="py-2"
              />
              <TextInput
                defaultValue={at.code}
                disabled={!canEdit}
                onBlur={(e) => void patchAsset(at.id, { code: e.target.value.toUpperCase() })}
                className="w-20 py-2 text-center font-mono"
              />
            </div>
            <div className="flex items-center gap-2">
              <TextInput
                defaultValue={at.nameSw ?? ''}
                placeholder="Kiswahili"
                disabled={!canEdit}
                onBlur={(e) => void patchAsset(at.id, { nameSw: e.target.value })}
                className="py-2 text-sm"
              />
              <TextInput
                defaultValue={at.category}
                placeholder={t('common.category')}
                disabled={!canEdit}
                onBlur={(e) => void patchAsset(at.id, { category: e.target.value })}
                className="py-2 text-sm"
              />
            </div>
            {canEdit && (
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <input
                    type="checkbox"
                    checked={at.active}
                    onChange={(e) => void patchAsset(at.id, { active: e.target.checked })}
                    className="h-5 w-5 rounded border-slate-300"
                  />
                  {at.active ? t('exercise.active') : t('setup.inactive')}
                </label>
                <button
                  type="button"
                  onClick={() => void remove(at)}
                  className="rounded-lg px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
                >
                  {t('common.delete')}
                </button>
              </div>
            )}
          </div>
        ))}
      </Card>

      {canEdit && (
        <Card className="space-y-2 p-3">
          <div className="flex gap-2">
            <TextInput placeholder={t('common.name')} value={name} onChange={(e) => setName(e.target.value)} />
            <TextInput
              placeholder={name.trim() ? deriveCode(name.trim()) : t('common.code')}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              className="w-20 text-center font-mono"
              aria-label={t('common.code')}
            />
          </div>
          <Button full onClick={() => void add()}>
            {t('setup.addAsset')}
          </Button>
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- team -----

function TeamTab({ canEdit, flash }: { canEdit: boolean; flash: (m: string) => void }) {
  const t = useT()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('inspector')
  const [password, setPassword] = useState('')

  const inspectorsQuery = useLiveQuery(() => db.inspectors.toArray(), [])
  if (!inspectorsQuery) return <p className="text-sm text-slate-500">{t('common.loading')}</p>

  const inspectors = inspectorsQuery

  async function add() {
    const n = name.trim()
    const e = email.trim().toLowerCase()
    if (!n || !e || !password) {
      flash(t('common.required'))
      return
    }
    if (password.length < 8) {
      flash(t('team.errPassword'))
      return
    }
    if (inspectors.some((i) => i.email.toLowerCase() === e)) {
      flash(t('team.errEmailTaken'))
      return
    }

    // Create it on the server when we can, so the colleague can sign in from
    // their own phone straight away rather than only from this device.
    const remote = await createTeamAccount({ name: n, email: e, password, role })
    if (!remote.ok && remote.error !== 'offline' && remote.error !== 'not-connected') {
      const messages: Record<string, StringKey> = {
        'email-taken': 'team.errEmailTaken',
        'password-too-short': 'team.errPassword',
        'admin-only': 'team.errAdminOnly',
      }
      flash(t(messages[remote.error] ?? 'sync.failed'))
      return
    }

    await db.inspectors.add({
      id: remote.ok && remote.id ? remote.id : uid('insp_'),
      name: n,
      email: e,
      role,
      active: true,
      passwordHash: await sha256(password),
      updatedAt: Date.now(),
      // A locally created account is pushed up on the next sync; one the
      // server already has must not be pushed back as a change.
      syncStatus: remote.ok ? 'synced' : 'pending',
    })
    setName('')
    setEmail('')
    setPassword('')
    flash(remote.ok ? t('team.addOnServer') : t('team.addLocal'))
  }

  async function setPw(id: string, pw: string) {
    if (!pw) return
    await patchInspector(id, { passwordHash: await sha256(pw) })
    flash(t('entry.saved'))
  }

  return (
    <div className="space-y-3">
      <Card className="divide-y divide-slate-100">
        {inspectors.map((i) => (
          <div key={i.id} className="space-y-2 p-3">
            <div className="flex items-center gap-2">
              <TextInput
                defaultValue={i.name}
                disabled={!canEdit}
                onBlur={(e) => void patchInspector(i.id, { name: e.target.value })}
                className="py-2"
              />
              <Select
                value={i.role}
                disabled={!canEdit}
                onChange={(e) => void patchInspector(i.id, { role: e.target.value as Role })}
                className="w-32 py-2 text-sm"
              >
                <option value="inspector">{t('setup.role.inspector')}</option>
                <option value="admin">{t('setup.role.admin')}</option>
              </Select>
            </div>
            <TextInput
              defaultValue={i.email}
              disabled={!canEdit}
              onBlur={(e) => void patchInspector(i.id, { email: e.target.value.toLowerCase() })}
              className="py-2 text-sm"
              inputMode="email"
              autoCapitalize="none"
            />
            {canEdit && (
              <div className="flex items-center gap-2">
                <TextInput
                  type="password"
                  placeholder={`${t('setup.password')} — ${t('setup.passwordKeep')}`}
                  onBlur={(e) => {
                    void setPw(i.id, e.target.value)
                    e.target.value = ''
                  }}
                  className="py-2 text-sm"
                />
                <label className="flex shrink-0 items-center gap-1.5 text-xs font-semibold text-slate-600">
                  <input
                    type="checkbox"
                    checked={i.active}
                    onChange={(e) => void patchInspector(i.id, { active: e.target.checked })}
                    className="h-5 w-5 rounded border-slate-300"
                  />
                  {i.active ? t('exercise.active') : t('setup.inactive')}
                </label>
              </div>
            )}
          </div>
        ))}
      </Card>

      {canEdit && (
        <Card className="space-y-2 p-3">
          <SectionTitle>{t('setup.addInspector')}</SectionTitle>
          <TextInput placeholder={t('common.name')} value={name} onChange={(e) => setName(e.target.value)} />
          <TextInput
            placeholder={t('login.email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputMode="email"
            autoCapitalize="none"
          />
          <div className="flex gap-2">
            <TextInput
              type="password"
              placeholder={t('setup.password')}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-32">
              <option value="inspector">{t('setup.role.inspector')}</option>
              <option value="admin">{t('setup.role.admin')}</option>
            </Select>
          </div>
          <Button full onClick={() => void add()}>
            {t('common.add')}
          </Button>
        </Card>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- data -----

/** Photo recognition settings. The API key itself lives only on the server. */
function VisionSettings() {
  const t = useT()
  const [availability, setAvailability] = useState<VisionAvailability | null | undefined>(undefined)
  const [model, setModel] = useState<VisionModel | ''>('')

  useEffect(() => {
    let cancelled = false
    void checkVisionAvailability().then((a) => {
      if (!cancelled) setAvailability(a)
    })
    void getVisionModel().then((m) => {
      if (!cancelled) setModel(m ?? '')
    })
    return () => {
      cancelled = true
    }
  }, [])

  const status =
    availability === undefined
      ? t('common.loading')
      : availability === null
        ? t('ai.notConnected')
        : availability.configured
          ? `${t('ai.statusReady')} · ${availability.model}`
          : t('ai.statusMissingKey')

  return (
    <Card className="space-y-3 p-4">
      <SectionTitle>{t('ai.section')}</SectionTitle>
      <p className="flex items-center gap-2 text-sm">
        <span
          className={`h-2.5 w-2.5 rounded-full ${
            availability?.configured ? 'bg-emerald-500' : 'bg-slate-300'
          }`}
        />
        <span className="text-slate-600">{status}</span>
      </p>
      <Field label={t('ai.model')} hint={t('ai.modelHint')}>
        <Select
          value={model}
          onChange={(e) => {
            const next = (e.target.value || null) as VisionModel | null
            setModel(next ?? '')
            void setVisionModel(next)
          }}
        >
          <option value="">{`${t('common.none')} — ${availability?.model ?? 'gpt-4o'}`}</option>
          {VISION_MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </Field>
    </Card>
  )
}

function DataTab() {
  const t = useT()
  const storage = useLiveQuery(() => storageEstimate(), [])
  const connected = useLiveQuery(async () => Boolean(await getToken()), [])

  const counts = useLiveQuery(async () => {
    const [entries, photos, rooms, signoffs] = await Promise.all([
      db.entries.count(),
      db.photos.count(),
      db.rooms.count(),
      db.signoffs.count(),
    ])
    return { entries, photos, rooms, signoffs }
  }, [])

  return (
    <div className="space-y-3">
      <Card className="space-y-1 p-4 text-sm">
        <p className="flex justify-between">
          <span className="text-slate-600">{t('setup.countEntries')}</span>
          <span className="font-bold tabular-nums">{counts?.entries ?? 0}</span>
        </p>
        <p className="flex justify-between">
          <span className="text-slate-600">{t('setup.countPhotos')}</span>
          <span className="font-bold tabular-nums">{counts?.photos ?? 0}</span>
        </p>
        <p className="flex justify-between">
          <span className="text-slate-600">{t('setup.countRooms')}</span>
          <span className="font-bold tabular-nums">{counts?.rooms ?? 0}</span>
        </p>
        <p className="flex justify-between">
          <span className="text-slate-600">{t('setup.countSignoffs')}</span>
          <span className="font-bold tabular-nums">{counts?.signoffs ?? 0}</span>
        </p>
        <p className="flex justify-between border-t border-slate-100 pt-1">
          <span className="text-slate-600">{t('setup.build')}</span>
          <span className="font-mono text-xs font-bold">{__BUILD_ID__}</span>
        </p>
        {storage && (
          <p className="flex justify-between border-t border-slate-100 pt-1">
            <span className="text-slate-600">{t('setup.storage')}</span>
            <span className="font-bold tabular-nums">{formatBytes(storage.usage)}</span>
          </p>
        )}
      </Card>

      <VisionSettings />

      <div className="space-y-2">
        <Button
          variant="danger"
          full
          onClick={() => {
            if (!window.confirm(t('setup.startFreshConfirm'))) return
            void startFresh().then(() => location.reload())
          }}
        >
          {t('setup.startFresh')}
        </Button>
        <p className="text-xs text-slate-500">{t('setup.startFreshHint')}</p>

        {/* Loading the sample over a real exercise is never what anyone wants,
            so this is offered only on a device that is not attached to an
            institution on the server. */}
        {!connected && (
          <Button
            variant="secondary"
            full
            onClick={() => {
              if (window.confirm(t('setup.resetConfirm'))) void resetLocalData()
            }}
          >
            {t('setup.resetDemo')}
          </Button>
        )}
      </div>
    </div>
  )
}
