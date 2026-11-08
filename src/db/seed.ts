import { db, setMeta, uid } from './db'
import { sha256 } from '../lib/hash'
import type { AssetType, Exercise, Floor, Inspector, Organization, Room } from '../types'

/** Sufa Schools sample layout from the brief: [floor name, floor code, [room name, room code][]] */
const FLOOR_PLAN: Array<[string, string, Array<[string, string]>]> = [
  [
    'Ground Floor',
    'GF',
    [
      ['Staff Room Nursery', 'SRN'],
      ['Head of Nursery', 'HON'],
      ['Canteen-Dora', 'CAN'],
      ['Lab Biology', 'LBI'],
      ['Lab Biology Office', 'LBO'],
      ['Lab Biology Store', 'LBS'],
      ['Lab Chemistry', 'LCH'],
      ['Lab Chemistry Office', 'LCO'],
      ['Lab Chemistry Store', 'LCS'],
      ['Lab Physics', 'LPH'],
      ['Lab Physics Office', 'LPO'],
      ['Lab Physics Store', 'LPS'],
      ['Toilet Boys', 'TB'],
      ['Toilet Girls', 'TG'],
      ['Dining', 'DIN'],
      ['Baby Class', 'BBC'],
      ['Middle A', 'MDA'],
    ],
  ],
  [
    '1st Floor',
    '1F',
    [
      ['Staffroom Primary', 'SRP'],
      ['P4', 'P4'],
      ['P3', 'P3'],
      ['P2', 'P2'],
      ['P1B', 'P1B'],
      ['P1A', 'P1A'],
      ['Toilet Girls', 'TG'],
      ['Toilet Boys', 'TB'],
      ['Primary Library', 'PLB'],
      ['Top', 'TOP'],
      ['Middle B', 'MDB'],
    ],
  ],
  [
    '2nd Floor',
    '2F',
    [
      ['Staffroom Secondary', 'SRS'],
      ['F1 Vocation', 'F1V'],
      ['F1 General', 'F1G'],
      ['P7', 'P7'],
      ['P6 B', 'P6B'],
      ['P6 A', 'P6A'],
      ['Toilet Girls', 'TG'],
      ['Toilet Boys', 'TB'],
      ['Secondary Library', 'SLB'],
      ['P5A', 'P5A'],
      ['P5B', 'P5B'],
    ],
  ],
  [
    '3rd Floor',
    '3F',
    [
      ['Discipline Room', 'DSC'],
      ['Form 6', 'F6'],
      ['Form 4', 'F4'],
      ['Form 3', 'F3'],
      ['Form 2 Vocation', 'F2V'],
      ['Form 2 General', 'F2G'],
      ['Toilet Girls', 'TG'],
      ['Toilet Boys', 'TB'],
      ['Computer Lab 1', 'CL1'],
      ['Computer Lab 2', 'CL2'],
      ['Store', 'STR'],
    ],
  ],
  ['Power Room', 'PR', [['Power Room', 'PWR']]],
]

/** [name, code, category, Swahili name] */
const ASSET_CATALOG: Array<[string, string, string, string]> = [
  ['Student Chair', 'SC', 'Furniture', 'Kiti cha Mwanafunzi'],
  ['Student Table', 'ST', 'Furniture', 'Meza ya Mwanafunzi'],
  ['Cabinet', 'CB', 'Furniture', 'Kabati'],
  ['Dustbin', 'DB', 'Fittings', 'Pipa la Taka'],
  ['White Board', 'WB', 'Teaching Equipment', 'Ubao Mweupe'],
  ['Smart Board', 'SB', 'Teaching Equipment', 'Ubao Janja'],
  ['Teacher Table', 'TT', 'Furniture', 'Meza ya Mwalimu'],
  ['Teacher Chair', 'TC', 'Furniture', 'Kiti cha Mwalimu'],
  ['Ceiling Fan', 'CF', 'Electrical', 'Feni ya Darini'],
  ['Smart Board Movable', 'SM', 'Teaching Equipment', 'Ubao Janja Unaohamishika'],
  ['TV Decoder', 'TD', 'Electrical', 'Kisimbuzi cha TV'],
  ['Water Dispenser', 'WD', 'Appliance', 'Mashine ya Maji'],
  ['Burner', 'BR', 'Lab Equipment', 'Kichomeo'],
  ['Battery', 'BT', 'Power', 'Betri'],
  ['Inverter', 'IV', 'Power', 'Inverta'],
  ['Solar Light Panel', 'SP', 'Power', 'Paneli ya Sola'],
]

const SEED_TEAM: Array<[string, string, 'admin' | 'inspector']> = [
  ['Admin', 'admin@sufa.ac.tz', 'admin'],
  ['Team Leader', 'leader@sufa.ac.tz', 'inspector'],
  ['Inspector Two', 'inspector2@sufa.ac.tz', 'inspector'],
  ['Inspector Three', 'inspector3@sufa.ac.tz', 'inspector'],
]

/** Default password for every seeded account. Change it in Setup before real use. */
export const SEED_PASSWORD = 'verify123'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Loads the Sufa Schools sample exercise. Idempotent: it does nothing once any
 * organization exists, so a half-finished exercise is never overwritten.
 */
export async function seedIfEmpty(): Promise<void> {
  const existing = await db.organizations.count()
  if (existing > 0) return

  const now = Date.now()
  const pwHash = await sha256(SEED_PASSWORD)

  const org: Organization = {
    id: uid('org_'),
    name: 'Sufa Schools Company Limited',
    address: 'P.O. Box 1234, Dar es Salaam, Tanzania',
    updatedAt: now,
    syncStatus: 'pending',
  }

  const inspectors: Inspector[] = SEED_TEAM.map(([name, email, role], i) => ({
    id: uid('insp_'),
    name,
    email,
    role,
    active: true,
    passwordHash: pwHash,
    updatedAt: now + i,
    syncStatus: 'pending',
  }))

  const exercise: Exercise = {
    id: uid('ex_'),
    orgId: org.id,
    name: `Asset Verification ${new Date().getFullYear()}`,
    date: today(),
    status: 'active',
    approvedBy: '',
    teamLeaderId: inspectors[1].id,
    updatedAt: now,
    syncStatus: 'pending',
  }

  const floors: Floor[] = []
  const rooms: Room[] = []
  FLOOR_PLAN.forEach(([floorName, floorCode, roomList], fi) => {
    const floor: Floor = {
      id: uid('fl_'),
      exerciseId: exercise.id,
      name: floorName,
      code: floorCode,
      sortOrder: fi,
      updatedAt: now,
      syncStatus: 'pending',
    }
    floors.push(floor)
    roomList.forEach(([roomName, roomCode], ri) => {
      rooms.push({
        id: uid('rm_'),
        floorId: floor.id,
        exerciseId: exercise.id,
        name: roomName,
        code: roomCode,
        sortOrder: ri,
        updatedAt: now,
        syncStatus: 'pending',
      })
    })
  })

  const assetTypes: AssetType[] = ASSET_CATALOG.map(([name, code, category, nameSw], i) => ({
    id: uid('at_'),
    orgId: org.id,
    name,
    nameSw,
    code,
    category,
    sortOrder: i,
    active: true,
    updatedAt: now,
    syncStatus: 'pending',
  }))

  await db.transaction(
    'rw',
    [db.organizations, db.exercises, db.floors, db.rooms, db.assetTypes, db.inspectors, db.meta],
    async () => {
      await db.organizations.add(org)
      await db.inspectors.bulkAdd(inspectors)
      await db.exercises.add(exercise)
      await db.floors.bulkAdd(floors)
      await db.rooms.bulkAdd(rooms)
      await db.assetTypes.bulkAdd(assetTypes)
      await setMeta('activeExerciseId', exercise.id)
      await setMeta('seededAt', now)
    },
  )
}
