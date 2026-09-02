// ---------- Skupni tipi ----------
export type Role = 'ADMIN' | 'RACUNOVODJA' | 'FINANCE'
export type DocType = 'BP' | 'BI'
export type DocStatus = 'ODPRT' | 'ZAKLJUCEN' | 'STORNIRAN'
export type SyncStatus = 'LOKALNO' | 'SINHRONIZIRANO'
export type PrejelStatus = 'NI_PODPISANO' | 'DIGITALNO' | 'NATISNJENO' | 'ROCNO'
export type ActivityType =
  | 'SICK_LEAVE'
  | 'ANNUAL_LEAVE'
  | 'LEAVE_OR_REST'
  | 'EXEMPT_VEHICLE'
  | 'OTHER_WORK'
  | 'AVAILABLE'
export type NumberingScope = 'PER_DESK' | 'COMPANY'
export type NumberFormat = 'SLASH' | 'DASH'

export interface AccountingRow {
  opis: string
  konto: string
  znesek: number | null
}

export interface Attachment {
  id: string
  name: string
  mime: string
  dataUrl: string
  addedAt: string
}

export interface SignatureRec {
  role: string
  signerName: string
  type: 'DIGITALNO' | 'ROCNO'
  dataUrl?: string
  signedAt: string
  capturedBy: string
}

export interface CashDocument {
  id: string
  deskId: string
  type: DocType
  officialNumber: number | null
  seqYear: number | null
  transactionDate: string // YYYY-MM-DD
  transactionTime: string // HH:mm
  monthKey: string // YYYY-MM
  employeeId: string
  employeeName: string // snapshot
  amount: number | null
  amountWordsOverride: string
  paymentMethod: 'GOTOVINA' | ''
  purpose: string
  rows: AccountingRow[]
  attachments: Attachment[]
  signatures: SignatureRec[]
  prejelStatus: PrejelStatus
  notes: string
  potrdiloId: string | null
  status: DocStatus
  syncStatus: SyncStatus
  createdAt: string
  createdBy: string
  updatedAt: string
  updatedBy: string
  finalizedAt?: string
  finalizedBy?: string
  cancelledAt?: string
  cancelledBy?: string
  cancelReason?: string
  correctionOfId?: string | null
}

export interface CashTransfer {
  id: string
  fromDeskId: string
  toDeskId: string
  transactionDate: string // YYYY-MM-DD
  transactionTime: string // HH:mm
  monthKey: string // YYYY-MM
  amount: number
  notes: string
  syncStatus: SyncStatus
  createdAt: string
  createdBy: string
  updatedAt: string
  updatedBy: string
}

export interface CashDesk {
  id: string
  name: string
  code: string
  description: string
  active: boolean
  /** Globalna blagajna je zbirnik lokacij in nima neposrednih dokumentov. */
  isGroup?: boolean
  /** Nadrejena globalna blagajna za interno lokacijo. */
  parentId?: string | null
  /** Začetno stanje gotovine (EUR) — osnova za izračun stanja blagajne. */
  openingBalance?: number
  /** Čas zadnje spremembe za zanesljivo strežniško sinhronizacijo. */
  updatedAt?: string
}

export interface Employee {
  id: string
  firstName: string
  lastName: string
  displayName: string
  dateOfBirth: string
  idNumber: string // vozniško dovoljenje / osebna izkaznica / potni list
  employmentStart: string
  employeeNumber: string
  phone: string
  vehicle: string
  notes: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface Potrdilo {
  id: string
  employeeId: string
  employeeName: string
  employeeDateOfBirth: string
  employeeIdNumber: string
  employeeEmploymentStart: string
  fromAt: string // YYYY-MM-DDTHH:mm
  toAt: string
  activityType: ActivityType
  companyPlace: string
  companyDate: string
  driverPlace: string
  driverDate: string
  declarantName: string
  declarantPosition: string
  signatures: SignatureRec[]
  syncStatus: SyncStatus
  createdAt: string
  createdBy: string
  updatedAt: string
}

export interface ManifestRow {
  docId: string
  type: DocType
  number: number
  transactionAt: string
  employeeName: string
  amount: number
}

export interface MonthClose {
  id: string // `${scopeKey}|${monthKey}`
  scopeKey: string // deskId ali 'COMPANY'
  deskId: string | null
  year: number
  month: number
  monthKey: string
  bpStart: number
  bpEnd: number
  biStart: number
  biEnd: number
  docCount: number
  closedBy: string
  closedAt: string
  idempotencyKey: string
  manifest: ManifestRow[]
}

export interface AuditEvent {
  id: string
  at: string
  user: string
  role: Role
  action: string
  entity: string
  entityId: string
  details: string
}

export interface CompanyInfo {
  name: string
  street: string
  postalCode: string
  city: string
  country: string
  phone: string
  fax: string
  email: string
  declarantName: string
  declarantPosition: string
}

export interface Settings {
  id: 'main'
  company: CompanyInfo
  numberingScope: NumberingScope
  numberFormat: NumberFormat
  financeCanClose: boolean
  requirePurpose: boolean
  autoSync?: boolean
  currentRole: Role
  currentUserName: string
  activeDeskId: string
  /** Čas zadnje spremembe za zanesljivo strežniško sinhronizacijo. */
  updatedAt?: string
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN: 'Admin',
  RACUNOVODJA: 'Računovodja',
  FINANCE: 'Finance',
}

export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  SICK_LEAVE: 'je bil na bolniškem dopustu',
  ANNUAL_LEAVE: 'je bil na letnem dopustu',
  LEAVE_OR_REST: 'je bil na dopustu ali počitku',
  EXEMPT_VEHICLE: 'je vozil vozilo, izvzeto iz Uredbe (ES) št. 561/2006 ali AETR',
  OTHER_WORK: 'je opravljal drugo delo, razen vožnje',
  AVAILABLE: 'je bil dosegljiv',
}

export const ACTIVITY_FIELD_NO: Record<ActivityType, number> = {
  SICK_LEAVE: 14,
  ANNUAL_LEAVE: 15,
  LEAVE_OR_REST: 16,
  EXEMPT_VEHICLE: 17,
  OTHER_WORK: 18,
  AVAILABLE: 19,
}

export const PREJEL_LABELS: Record<PrejelStatus, string> = {
  NI_PODPISANO: 'Ni podpisano',
  DIGITALNO: 'Podpisano na zaslonu',
  NATISNJENO: 'Natisnjeno za podpis',
  ROCNO: 'Ročno podpisano / potrjeno',
}

// Podpisne vloge po vrsti dokumenta (vrstni red kot na papirnem obrazcu)
export const SIGNATURE_ROLES_BP = [
  'PREJEL_BLAGAJNIK',
  'PREIZKUSIL',
  'ODOBRIL',
  'VPLACAL',
  'KONTIRAL',
  'VKNJIZIL',
] as const
export const SIGNATURE_ROLES_BI = [
  'IZPLACAL_BLAGAJNIK',
  'PREIZKUSIL',
  'ODOBRIL',
  'PREJEL',
  'KONTIRAL',
  'VKNJIZIL',
] as const

export const SIGNATURE_ROLE_LABELS: Record<string, string> = {
  PREJEL_BLAGAJNIK: 'Prejel blagajnik',
  IZPLACAL_BLAGAJNIK: 'Izplačal blagajnik',
  PREIZKUSIL: 'Preizkusil',
  ODOBRIL: 'Odobril',
  VPLACAL: 'Vplačal',
  PREJEL: 'Prejel',
  KONTIRAL: 'Kontiral',
  VKNJIZIL: 'Vknjižil',
  PODJETJE: 'Podpis podjetja',
  VOZNIK: 'Podpis voznika',
}
