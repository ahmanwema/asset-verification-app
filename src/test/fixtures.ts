import { db, uid } from '../db/db'
import type { AssetType, Exercise, Floor, Inspector, Organization, Room } from '../types'

export interface Fixture {
  org: Organization
  exercise: Exercise
  floor: Floor
  room: Room
  room2: Room
  chair: AssetType
  table: AssetType
  inspector: Inspector
  inspector2: Inspector
}

/** Minimal but realistic exercise: one floor, two rooms, two asset types. */
export async function seedFixture(): Promise<Fixture> {
  const now = Date.now()
  const base = { updatedAt: now, syncStatus: 'pending' as const }

  const org: Organization = { id: uid('org_'), name: 'Sufa Schools', address: 'Dar es Salaam', ...base }
  const inspector: Inspector = {
    id: uid('insp_'),
    name: 'Team Leader',
    email: 'leader@sufa.ac.tz',
    role: 'inspector',
    active: true,
    ...base,
  }
  const inspector2: Inspector = {
    id: uid('insp_'),
    name: 'Inspector Two',
    email: 'two@sufa.ac.tz',
    role: 'inspector',
    active: true,
    ...base,
  }
  const exercise: Exercise = {
    id: uid('ex_'),
    orgId: org.id,
    name: 'Verification 2026',
    date: '2026-11-08',
    status: 'active',
    approvedBy: 'Board',
    teamLeaderId: inspector.id,
    ...base,
  }
  const floor: Floor = { id: uid('fl_'), exerciseId: exercise.id, name: '1st Floor', code: '1F', sortOrder: 0, ...base }
  const room: Room = {
    id: uid('rm_'),
    floorId: floor.id,
    exerciseId: exercise.id,
    name: 'P3',
    code: 'P3',
    sortOrder: 0,
    ...base,
  }
  const room2: Room = {
    id: uid('rm_'),
    floorId: floor.id,
    exerciseId: exercise.id,
    name: 'P4',
    code: 'P4',
    sortOrder: 1,
    ...base,
  }
  const chair: AssetType = {
    id: uid('at_'),
    orgId: org.id,
    name: 'Student Chair',
    nameSw: 'Kiti cha Mwanafunzi',
    code: 'SC',
    category: 'Furniture',
    sortOrder: 0,
    active: true,
    ...base,
  }
  const table: AssetType = {
    id: uid('at_'),
    orgId: org.id,
    name: 'Student Table',
    code: 'ST',
    category: 'Furniture',
    sortOrder: 1,
    active: true,
    ...base,
  }

  await db.organizations.add(org)
  await db.inspectors.bulkAdd([inspector, inspector2])
  await db.exercises.add(exercise)
  await db.floors.add(floor)
  await db.rooms.bulkAdd([room, room2])
  await db.assetTypes.bulkAdd([chair, table])
  await db.meta.put({ key: 'activeExerciseId', value: exercise.id })

  return { org, exercise, floor, room, room2, chair, table, inspector, inspector2 }
}

export async function resetDb(): Promise<void> {
  await db.delete()
  await db.open()
}
