/** Shared domain types. Every syncable record carries updatedAt + syncStatus. */

export type SyncStatus = 'pending' | 'synced' | 'conflict'
export type Condition = 'G' | 'F' | 'P' | 'U'
export type Role = 'admin' | 'inspector'
export type ExerciseStatus = 'draft' | 'active' | 'completed'
export type Lang = 'en' | 'sw'
export type DepreciationMethod = 'diminishing_balance'

export const CONDITIONS: Condition[] = ['G', 'F', 'P', 'U']

export interface Organization {
  id: string
  name: string
  address: string
  logo?: string // data URL
  updatedAt: number
  syncStatus: SyncStatus
}

export interface Exercise {
  id: string
  orgId: string
  name: string
  date: string // ISO yyyy-mm-dd
  status: ExerciseStatus
  approvedBy: string
  teamLeaderId: string
  updatedAt: number
  syncStatus: SyncStatus
}

export interface Floor {
  id: string
  exerciseId: string
  name: string
  code: string // used in tag numbers, e.g. GF, 1F
  sortOrder: number
  updatedAt: number
  syncStatus: SyncStatus
}

export interface Room {
  id: string
  floorId: string
  exerciseId: string
  name: string
  code: string // used in tag numbers, e.g. P3
  sortOrder: number
  updatedAt: number
  syncStatus: SyncStatus
}

export interface AssetType {
  id: string
  orgId: string
  name: string
  nameSw?: string
  code: string // e.g. SC
  category: string
  sortOrder: number
  active: boolean
  updatedAt: number
  syncStatus: SyncStatus
}

export interface Inspector {
  id: string
  /** Tenant that owns this cached account. Used to keep offline sign-in isolated. */
  orgId?: string
  name: string
  role: Role
  email: string
  phone?: string
  active: boolean
  /** SHA-256 of the password, for offline login. The server stores a scrypt hash. */
  passwordHash?: string
  updatedAt: number
  syncStatus: SyncStatus
}

/**
 * One field-level change to an entry that was already saved.
 *
 * Values are stored as the strings the data model holds — a condition is `"G"`,
 * a quantity `"3"` — not as display text, so the log can be rendered in either
 * language and in the English reports from the same record.
 */
export interface EditRecord {
  /** Canonical field key, e.g. "quantity", "material". */
  field: string
  oldValue: string
  newValue: string
  /** Inspector id of whoever made the change. */
  editedBy: string
  editedAt: number
}

/** Counts per condition; used when quantity > 1 and items differ. */
export type ConditionBreakdown = Partial<Record<Condition, number>>

/**
 * Accounting details for one physical asset/tag. An inspection entry can hold
 * many identical items, but each tagged item needs its own acquisition history
 * and carrying amount.
 */
export interface AssetFinancialRecord {
  tagNumber: string
  acquisitionDate: string
  availableForUseDate: string
  originalCost: number
  residualValue: number
  usefulLifeMonths: number
  depreciationMethod: DepreciationMethod
  /** Fixed annual reducing-balance rate, expressed as a percentage (e.g. 25). */
  annualDepreciationRate: number
  openingAccumulatedDepreciation: number
  openingBalanceDate: string
  supplier: string
  invoiceNumber: string
  fundingSource: string
  notes: string
  updatedAt: number
  updatedBy: string
}

export interface InspectionEntry {
  id: string
  exerciseId: string
  roomId: string
  assetTypeId: string | null // null only for unlisted items
  quantity: number
  serialNumbers: string[]
  model: string
  brand: string
  tagNumbers: string[]
  condition: Condition
  /** Set when the quantity splits across conditions, e.g. { G: 28, P: 2 }. */
  conditionBreakdown?: ConditionBreakdown
  photoIds: string[]
  remarks: string

  /** One accounting record per tag number; older entries legitimately omit it. */
  financialRecords?: AssetFinancialRecord[]

  // --- Detailed description fields (optional, captured under "More details") ---
  /** What the item is made of, e.g. "Wooden seat and backrest with metal frame". */
  material: string
  /** Visible colours, e.g. "Light Brown / Grey". */
  colour: string
  /** Sub-type within the asset type, e.g. "Top-Loading Water Dispenser". */
  itemType: string
  /** Notable extras, e.g. "pen groove on tabletop", "three water taps". */
  additionalFeatures: string
  /** Full sentence describing the item physically. */
  description: string
  /** Where it sits in the room, e.g. "Front left corner", "Mounted on east wall". */
  specificPosition: string
  /** Set when the fields were pre-filled by photo recognition and not yet edited. */
  aiAssisted?: boolean
  /**
   * Where the item belongs, when that is not the room it was found in.
   * A physical verification records what is there; this records that it is
   * there by mistake, so it can be put back.
   */
  expectedRoomId?: string

  /**
   * Field-level change log, oldest first. Entries created before schema v3 are
   * backfilled with an empty array by the migration; readers still default to
   * `[]` so a record pulled from a client that predates v3 cannot crash a report.
   */
  editHistory: EditRecord[]

  inspectorId: string
  inspectedAt: number
  isUnlistedItem: boolean
  unlistedItemName?: string
  /** True when the inspector tapped "Not present" (quantity 0). */
  notPresent: boolean
  updatedAt: number
  deleted: boolean
  syncStatus: SyncStatus
  /** Server copy kept aside when a conflict is detected. */
  conflictWith?: Omit<InspectionEntry, 'conflictWith'>
}

export interface RoomSignoff {
  id: string
  exerciseId: string
  roomId: string
  inspectorId: string
  signedAt: number
  totalItemsFound: number
  notes: string
  updatedAt: number
  deleted: boolean
  syncStatus: SyncStatus
}

export interface Photo {
  id: string
  entryId: string
  exerciseId: string
  /**
   * Raw JPEG bytes rather than a Blob: older iOS Safari mishandles Blobs stored
   * in IndexedDB, and bytes survive every structured-clone implementation.
   */
  data: ArrayBuffer
  contentType: string
  width: number
  height: number
  createdAt: number
  remoteUrl?: string
  syncStatus: SyncStatus
}

export interface Meta {
  key: string
  value: unknown
}

/** Room progress rollup used by the dashboard and room list. */
export type RoomStatus = 'not_started' | 'in_progress' | 'done'
