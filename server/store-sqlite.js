// SQLite gonilnik (privzeto) — normalizirana relacijska shema.
// Stara tabela `records` se ohrani samo zaradi samodejne migracije/rollback-a;
// novi zapisi se shranjujejo v namenske tabele in stolpce.
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  pass_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Legacy v1/v2 shramba. Po migraciji se vanjo ne piše več.
CREATE TABLE IF NOT EXISTS records (
  tbl TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL,
  PRIMARY KEY (tbl, id)
);
CREATE INDEX IF NOT EXISTS idx_records_seq ON records (server_seq);

CREATE TABLE IF NOT EXISTS company (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  street TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  fax TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  declarant_name TEXT NOT NULL DEFAULT '',
  declarant_position TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY,
  numbering_scope TEXT NOT NULL DEFAULT 'PER_DESK',
  number_format TEXT NOT NULL DEFAULT 'SLASH',
  finance_can_close INTEGER NOT NULL DEFAULT 0,
  require_purpose INTEGER NOT NULL DEFAULT 1,
  auto_sync INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_settings_seq ON app_settings (server_seq);

CREATE TABLE IF NOT EXISTS cash_desks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  is_group INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  opening_balance REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_desks_name ON cash_desks (name);
CREATE INDEX IF NOT EXISTS idx_cash_desks_seq ON cash_desks (server_seq);

CREATE TABLE IF NOT EXISTS cash_transfers (
  id TEXT PRIMARY KEY,
  from_desk_id TEXT NOT NULL DEFAULT '',
  to_desk_id TEXT NOT NULL DEFAULT '',
  transaction_date TEXT NOT NULL DEFAULT '',
  transaction_time TEXT NOT NULL DEFAULT '',
  month_key TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  sync_status TEXT NOT NULL DEFAULT 'SINHRONIZIRANO',
  created_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_transfers_month ON cash_transfers (month_key);
CREATE INDEX IF NOT EXISTS idx_cash_transfers_from ON cash_transfers (from_desk_id, transaction_date, transaction_time);
CREATE INDEX IF NOT EXISTS idx_cash_transfers_to ON cash_transfers (to_desk_id, transaction_date, transaction_time);
CREATE INDEX IF NOT EXISTS idx_cash_transfers_seq ON cash_transfers (server_seq);

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  date_of_birth TEXT NOT NULL DEFAULT '',
  id_number TEXT NOT NULL DEFAULT '',
  employment_start TEXT NOT NULL DEFAULT '',
  employee_number TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  vehicle TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_employees_name ON employees (display_name);
CREATE INDEX IF NOT EXISTS idx_employees_number ON employees (employee_number);
CREATE INDEX IF NOT EXISTS idx_employees_seq ON employees (server_seq);

CREATE TABLE IF NOT EXISTS cash_documents (
  id TEXT PRIMARY KEY,
  desk_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'BP',
  official_number INTEGER,
  seq_year INTEGER,
  transaction_date TEXT NOT NULL DEFAULT '',
  transaction_time TEXT NOT NULL DEFAULT '',
  month_key TEXT NOT NULL DEFAULT '',
  employee_id TEXT NOT NULL DEFAULT '',
  employee_name TEXT NOT NULL DEFAULT '',
  amount REAL,
  amount_words_override TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  prejel_status TEXT NOT NULL DEFAULT 'NI_PODPISANO',
  notes TEXT NOT NULL DEFAULT '',
  potrdilo_id TEXT,
  status TEXT NOT NULL DEFAULT 'ODPRT',
  sync_status TEXT NOT NULL DEFAULT 'SINHRONIZIRANO',
  created_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  finalized_at TEXT,
  finalized_by TEXT,
  cancelled_at TEXT,
  cancelled_by TEXT,
  cancel_reason TEXT,
  correction_of_id TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_documents_month ON cash_documents (month_key);
CREATE INDEX IF NOT EXISTS idx_cash_documents_desk_date ON cash_documents (desk_id, transaction_date, transaction_time);
CREATE INDEX IF NOT EXISTS idx_cash_documents_employee ON cash_documents (employee_id);
CREATE INDEX IF NOT EXISTS idx_cash_documents_type_status ON cash_documents (type, status);
CREATE INDEX IF NOT EXISTS idx_cash_documents_seq ON cash_documents (server_seq);

CREATE TABLE IF NOT EXISTS cash_document_rows (
  doc_id TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  opis TEXT NOT NULL DEFAULT '',
  konto TEXT NOT NULL DEFAULT '',
  znesek REAL,
  PRIMARY KEY (doc_id, row_no),
  FOREIGN KEY (doc_id) REFERENCES cash_documents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_cash_document_rows_konto ON cash_document_rows (konto);

CREATE TABLE IF NOT EXISTS cash_document_attachments (
  doc_id TEXT NOT NULL,
  id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  data_url TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (doc_id, id),
  FOREIGN KEY (doc_id) REFERENCES cash_documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cash_document_signatures (
  doc_id TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  signer_name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'ROCNO',
  data_url TEXT,
  signed_at TEXT NOT NULL DEFAULT '',
  captured_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (doc_id, row_no),
  FOREIGN KEY (doc_id) REFERENCES cash_documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS activity_certificates (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL DEFAULT '',
  employee_name TEXT NOT NULL DEFAULT '',
  employee_date_of_birth TEXT NOT NULL DEFAULT '',
  employee_id_number TEXT NOT NULL DEFAULT '',
  employee_employment_start TEXT NOT NULL DEFAULT '',
  from_at TEXT NOT NULL DEFAULT '',
  to_at TEXT NOT NULL DEFAULT '',
  activity_type TEXT NOT NULL DEFAULT '',
  company_place TEXT NOT NULL DEFAULT '',
  company_date TEXT NOT NULL DEFAULT '',
  driver_place TEXT NOT NULL DEFAULT '',
  driver_date TEXT NOT NULL DEFAULT '',
  declarant_name TEXT NOT NULL DEFAULT '',
  declarant_position TEXT NOT NULL DEFAULT '',
  sync_status TEXT NOT NULL DEFAULT 'SINHRONIZIRANO',
  created_at TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_cert_employee ON activity_certificates (employee_id);
CREATE INDEX IF NOT EXISTS idx_activity_cert_period ON activity_certificates (from_at, to_at);
CREATE INDEX IF NOT EXISTS idx_activity_cert_seq ON activity_certificates (server_seq);

CREATE TABLE IF NOT EXISTS activity_certificate_signatures (
  certificate_id TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  signer_name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'ROCNO',
  data_url TEXT,
  signed_at TEXT NOT NULL DEFAULT '',
  captured_by TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (certificate_id, row_no),
  FOREIGN KEY (certificate_id) REFERENCES activity_certificates(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS month_closes (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL DEFAULT '',
  desk_id TEXT,
  year INTEGER NOT NULL DEFAULT 0,
  month INTEGER NOT NULL DEFAULT 0,
  month_key TEXT NOT NULL DEFAULT '',
  bp_start INTEGER NOT NULL DEFAULT 0,
  bp_end INTEGER NOT NULL DEFAULT 0,
  bi_start INTEGER NOT NULL DEFAULT 0,
  bi_end INTEGER NOT NULL DEFAULT 0,
  doc_count INTEGER NOT NULL DEFAULT 0,
  closed_by TEXT NOT NULL DEFAULT '',
  closed_at TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  server_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_month_closes_month ON month_closes (month_key);
CREATE INDEX IF NOT EXISTS idx_month_closes_scope_year ON month_closes (scope_key, year);
CREATE INDEX IF NOT EXISTS idx_month_closes_seq ON month_closes (server_seq);

CREATE TABLE IF NOT EXISTS month_close_manifest (
  close_id TEXT NOT NULL,
  row_no INTEGER NOT NULL,
  doc_id TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT '',
  number INTEGER NOT NULL DEFAULT 0,
  transaction_at TEXT NOT NULL DEFAULT '',
  employee_name TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (close_id, row_no),
  FOREIGN KEY (close_id) REFERENCES month_closes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  user TEXT NOT NULL,
  role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  server_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit (server_seq);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`

const SUPPORTED = new Set(['docs', 'potrdila', 'employees', 'desks', 'settings', 'transfers', 'closes'])
const topTable = {
  docs: 'cash_documents',
  potrdila: 'activity_certificates',
  employees: 'employees',
  desks: 'cash_desks',
  settings: 'app_settings',
  transfers: 'cash_transfers',
  closes: 'month_closes',
}
const b = (v) => (v ? 1 : 0)
const bool = (v) => !!Number(v)
const emptyCompany = () => ({ name: '', street: '', postalCode: '', city: '', country: '', phone: '', fax: '', email: '', declarantName: '', declarantPosition: '' })

export function createSqliteStore(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'blagajna.sqlite'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  const deskCols = new Set(db.prepare('PRAGMA table_info(cash_desks)').all().map((r) => r.name))
  if (!deskCols.has('is_group')) db.exec('ALTER TABLE cash_desks ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0')
  if (!deskCols.has('parent_id')) db.exec('ALTER TABLE cash_desks ADD COLUMN parent_id TEXT')
  db.exec(`INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', '0')`)

  const readCompany = () => {
    const r = db.prepare(`SELECT * FROM company WHERE id = 'main'`).get()
    if (!r) return emptyCompany()
    return {
      name: r.name, street: r.street, postalCode: r.postal_code, city: r.city, country: r.country,
      phone: r.phone, fax: r.fax, email: r.email, declarantName: r.declarant_name, declarantPosition: r.declarant_position,
    }
  }

  const readBy = (tbl, id) => {
    if (tbl === 'desks') {
      const r = db.prepare('SELECT * FROM cash_desks WHERE id = ?').get(id)
      if (!r) return null
      return { json: { id: r.id, name: r.name, code: r.code, description: r.description, active: bool(r.active), isGroup: bool(r.is_group), parentId: r.parent_id ?? null, openingBalance: Number(r.opening_balance ?? 0), updatedAt: r.updated_at }, updatedAt: r.updated_at, deleted: bool(r.deleted) }
    }
    if (tbl === 'transfers') {
      const r = db.prepare('SELECT * FROM cash_transfers WHERE id = ?').get(id)
      if (!r) return null
      return { json: {
        id: r.id, fromDeskId: r.from_desk_id, toDeskId: r.to_desk_id,
        transactionDate: r.transaction_date, transactionTime: r.transaction_time, monthKey: r.month_key,
        amount: Number(r.amount ?? 0), notes: r.notes, syncStatus: r.sync_status,
        createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
      }, updatedAt: r.updated_at, deleted: bool(r.deleted) }
    }
    if (tbl === 'employees') {
      const r = db.prepare('SELECT * FROM employees WHERE id = ?').get(id)
      if (!r) return null
      return { json: {
        id: r.id, firstName: r.first_name, lastName: r.last_name, displayName: r.display_name,
        dateOfBirth: r.date_of_birth, idNumber: r.id_number, employmentStart: r.employment_start,
        employeeNumber: r.employee_number, phone: r.phone, vehicle: r.vehicle, notes: r.notes,
        active: bool(r.active), createdAt: r.created_at, updatedAt: r.updated_at,
      }, updatedAt: r.updated_at, deleted: bool(r.deleted) }
    }
    if (tbl === 'docs') {
      const r = db.prepare('SELECT * FROM cash_documents WHERE id = ?').get(id)
      if (!r) return null
      const rows = db.prepare('SELECT opis, konto, znesek FROM cash_document_rows WHERE doc_id = ? ORDER BY row_no').all(id).map((x) => ({ opis: x.opis, konto: x.konto, znesek: x.znesek == null ? null : Number(x.znesek) }))
      const attachments = db.prepare('SELECT id, name, mime, data_url, added_at FROM cash_document_attachments WHERE doc_id = ? ORDER BY rowid').all(id).map((x) => ({ id: x.id, name: x.name, mime: x.mime, dataUrl: x.data_url, addedAt: x.added_at }))
      const signatures = db.prepare('SELECT role, signer_name, type, data_url, signed_at, captured_by FROM cash_document_signatures WHERE doc_id = ? ORDER BY row_no').all(id).map((x) => ({ role: x.role, signerName: x.signer_name, type: x.type, ...(x.data_url ? { dataUrl: x.data_url } : {}), signedAt: x.signed_at, capturedBy: x.captured_by }))
      const json = {
        id: r.id, deskId: r.desk_id, type: r.type, officialNumber: r.official_number == null ? null : Number(r.official_number), seqYear: r.seq_year == null ? null : Number(r.seq_year),
        transactionDate: r.transaction_date, transactionTime: r.transaction_time, monthKey: r.month_key,
        employeeId: r.employee_id, employeeName: r.employee_name, amount: r.amount == null ? null : Number(r.amount), amountWordsOverride: r.amount_words_override,
        paymentMethod: r.payment_method, purpose: r.purpose, rows, attachments, signatures, prejelStatus: r.prejel_status,
        notes: r.notes, potrdiloId: r.potrdilo_id ?? null, status: r.status, syncStatus: r.sync_status,
        createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at, updatedBy: r.updated_by,
        ...(r.finalized_at ? { finalizedAt: r.finalized_at } : {}), ...(r.finalized_by ? { finalizedBy: r.finalized_by } : {}),
        ...(r.cancelled_at ? { cancelledAt: r.cancelled_at } : {}), ...(r.cancelled_by ? { cancelledBy: r.cancelled_by } : {}),
        ...(r.cancel_reason ? { cancelReason: r.cancel_reason } : {}), correctionOfId: r.correction_of_id ?? null,
      }
      return { json, updatedAt: r.updated_at, deleted: bool(r.deleted) }
    }
    if (tbl === 'potrdila') {
      const r = db.prepare('SELECT * FROM activity_certificates WHERE id = ?').get(id)
      if (!r) return null
      const signatures = db.prepare('SELECT role, signer_name, type, data_url, signed_at, captured_by FROM activity_certificate_signatures WHERE certificate_id = ? ORDER BY row_no').all(id).map((x) => ({ role: x.role, signerName: x.signer_name, type: x.type, ...(x.data_url ? { dataUrl: x.data_url } : {}), signedAt: x.signed_at, capturedBy: x.captured_by }))
      return { json: {
        id: r.id, employeeId: r.employee_id, employeeName: r.employee_name, employeeDateOfBirth: r.employee_date_of_birth,
        employeeIdNumber: r.employee_id_number, employeeEmploymentStart: r.employee_employment_start,
        fromAt: r.from_at, toAt: r.to_at, activityType: r.activity_type, companyPlace: r.company_place, companyDate: r.company_date,
        driverPlace: r.driver_place, driverDate: r.driver_date, declarantName: r.declarant_name, declarantPosition: r.declarant_position,
        signatures, syncStatus: r.sync_status, createdAt: r.created_at, createdBy: r.created_by, updatedAt: r.updated_at,
      }, updatedAt: r.updated_at, deleted: bool(r.deleted) }
    }
    if (tbl === 'settings') {
      const r = db.prepare('SELECT * FROM app_settings WHERE id = ?').get(id)
      if (!r) return null
      return { json: {
        id: 'main', company: readCompany(), numberingScope: r.numbering_scope, numberFormat: r.number_format,
        financeCanClose: bool(r.finance_can_close), requirePurpose: bool(r.require_purpose), autoSync: bool(r.auto_sync), updatedAt: r.updated_at,
      }, updatedAt: r.updated_at, deleted: bool(r.deleted) }
    }
    if (tbl === 'closes') {
      const r = db.prepare('SELECT * FROM month_closes WHERE id = ?').get(id)
      if (!r) return null
      const manifest = db.prepare('SELECT doc_id, type, number, transaction_at, employee_name, amount FROM month_close_manifest WHERE close_id = ? ORDER BY row_no').all(id).map((x) => ({ docId: x.doc_id, type: x.type, number: Number(x.number), transactionAt: x.transaction_at, employeeName: x.employee_name, amount: Number(x.amount) }))
      return { json: {
        id: r.id, scopeKey: r.scope_key, deskId: r.desk_id ?? null, year: Number(r.year), month: Number(r.month), monthKey: r.month_key,
        bpStart: Number(r.bp_start), bpEnd: Number(r.bp_end), biStart: Number(r.bi_start), biEnd: Number(r.bi_end), docCount: Number(r.doc_count),
        closedBy: r.closed_by, closedAt: r.closed_at, idempotencyKey: r.idempotency_key, manifest,
      }, updatedAt: r.updated_at, deleted: bool(r.deleted) }
    }
    return null
  }

  const writeAtSeq = (tbl, id, obj, updatedAt, deleted, seq) => {
    if (tbl === 'desks') {
      db.prepare(`INSERT INTO cash_desks (id,name,code,description,active,is_group,parent_id,opening_balance,updated_at,deleted,server_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,code=excluded.code,description=excluded.description,active=excluded.active,is_group=excluded.is_group,parent_id=excluded.parent_id,opening_balance=excluded.opening_balance,updated_at=excluded.updated_at,deleted=excluded.deleted,server_seq=excluded.server_seq`)
        .run(id, obj.name ?? '', obj.code ?? '', obj.description ?? '', b(obj.active !== false), b(!!obj.isGroup), obj.parentId ?? null, Number(obj.openingBalance ?? 0), updatedAt, b(deleted), seq)
      return
    }
    if (tbl === 'transfers') {
      db.prepare(`INSERT INTO cash_transfers (id,from_desk_id,to_desk_id,transaction_date,transaction_time,month_key,amount,notes,sync_status,created_at,created_by,updated_at,updated_by,deleted,server_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET from_desk_id=excluded.from_desk_id,to_desk_id=excluded.to_desk_id,transaction_date=excluded.transaction_date,transaction_time=excluded.transaction_time,month_key=excluded.month_key,amount=excluded.amount,notes=excluded.notes,sync_status=excluded.sync_status,created_at=excluded.created_at,created_by=excluded.created_by,updated_at=excluded.updated_at,updated_by=excluded.updated_by,deleted=excluded.deleted,server_seq=excluded.server_seq`)
        .run(id, obj.fromDeskId ?? '', obj.toDeskId ?? '', obj.transactionDate ?? '', obj.transactionTime ?? '', obj.monthKey ?? '', Number(obj.amount ?? 0), obj.notes ?? '', obj.syncStatus ?? 'SINHRONIZIRANO', obj.createdAt ?? '', obj.createdBy ?? '', updatedAt, obj.updatedBy ?? '', b(deleted), seq)
      return
    }
    if (tbl === 'employees') {
      db.prepare(`INSERT INTO employees (id,first_name,last_name,display_name,date_of_birth,id_number,employment_start,employee_number,phone,vehicle,notes,active,created_at,updated_at,deleted,server_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,display_name=excluded.display_name,date_of_birth=excluded.date_of_birth,id_number=excluded.id_number,employment_start=excluded.employment_start,employee_number=excluded.employee_number,phone=excluded.phone,vehicle=excluded.vehicle,notes=excluded.notes,active=excluded.active,created_at=excluded.created_at,updated_at=excluded.updated_at,deleted=excluded.deleted,server_seq=excluded.server_seq`)
        .run(id, obj.firstName ?? '', obj.lastName ?? '', obj.displayName ?? '', obj.dateOfBirth ?? '', obj.idNumber ?? '', obj.employmentStart ?? '', obj.employeeNumber ?? '', obj.phone ?? '', obj.vehicle ?? '', obj.notes ?? '', b(obj.active !== false), obj.createdAt ?? '', updatedAt, b(deleted), seq)
      return
    }
    if (tbl === 'docs') {
      db.prepare(`INSERT INTO cash_documents (id,desk_id,type,official_number,seq_year,transaction_date,transaction_time,month_key,employee_id,employee_name,amount,amount_words_override,payment_method,purpose,prejel_status,notes,potrdilo_id,status,sync_status,created_at,created_by,updated_at,updated_by,finalized_at,finalized_by,cancelled_at,cancelled_by,cancel_reason,correction_of_id,deleted,server_seq)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET desk_id=excluded.desk_id,type=excluded.type,official_number=excluded.official_number,seq_year=excluded.seq_year,transaction_date=excluded.transaction_date,transaction_time=excluded.transaction_time,month_key=excluded.month_key,employee_id=excluded.employee_id,employee_name=excluded.employee_name,amount=excluded.amount,amount_words_override=excluded.amount_words_override,payment_method=excluded.payment_method,purpose=excluded.purpose,prejel_status=excluded.prejel_status,notes=excluded.notes,potrdilo_id=excluded.potrdilo_id,status=excluded.status,sync_status=excluded.sync_status,created_at=excluded.created_at,created_by=excluded.created_by,updated_at=excluded.updated_at,updated_by=excluded.updated_by,finalized_at=excluded.finalized_at,finalized_by=excluded.finalized_by,cancelled_at=excluded.cancelled_at,cancelled_by=excluded.cancelled_by,cancel_reason=excluded.cancel_reason,correction_of_id=excluded.correction_of_id,deleted=excluded.deleted,server_seq=excluded.server_seq`)
        .run(id, obj.deskId ?? '', obj.type ?? 'BP', obj.officialNumber ?? null, obj.seqYear ?? null, obj.transactionDate ?? '', obj.transactionTime ?? '', obj.monthKey ?? '', obj.employeeId ?? '', obj.employeeName ?? '', obj.amount ?? null, obj.amountWordsOverride ?? '', obj.paymentMethod ?? '', obj.purpose ?? '', obj.prejelStatus ?? 'NI_PODPISANO', obj.notes ?? '', obj.potrdiloId ?? null, obj.status ?? 'ODPRT', obj.syncStatus ?? 'SINHRONIZIRANO', obj.createdAt ?? '', obj.createdBy ?? '', updatedAt, obj.updatedBy ?? '', obj.finalizedAt ?? null, obj.finalizedBy ?? null, obj.cancelledAt ?? null, obj.cancelledBy ?? null, obj.cancelReason ?? null, obj.correctionOfId ?? null, b(deleted), seq)
      db.prepare('DELETE FROM cash_document_rows WHERE doc_id = ?').run(id)
      db.prepare('DELETE FROM cash_document_attachments WHERE doc_id = ?').run(id)
      db.prepare('DELETE FROM cash_document_signatures WHERE doc_id = ?').run(id)
      if (!deleted) {
        const insRow = db.prepare('INSERT INTO cash_document_rows (doc_id,row_no,opis,konto,znesek) VALUES (?,?,?,?,?)')
        ;(obj.rows ?? []).forEach((x, i) => insRow.run(id, i, x.opis ?? '', x.konto ?? '', x.znesek ?? null))
        const insAtt = db.prepare('INSERT INTO cash_document_attachments (doc_id,id,name,mime,data_url,added_at) VALUES (?,?,?,?,?,?)')
        ;(obj.attachments ?? []).forEach((x) => insAtt.run(id, x.id ?? '', x.name ?? '', x.mime ?? '', x.dataUrl ?? '', x.addedAt ?? ''))
        const insSig = db.prepare('INSERT INTO cash_document_signatures (doc_id,row_no,role,signer_name,type,data_url,signed_at,captured_by) VALUES (?,?,?,?,?,?,?,?)')
        ;(obj.signatures ?? []).forEach((x, i) => insSig.run(id, i, x.role ?? '', x.signerName ?? '', x.type ?? 'ROCNO', x.dataUrl ?? null, x.signedAt ?? '', x.capturedBy ?? ''))
      }
      return
    }
    if (tbl === 'potrdila') {
      db.prepare(`INSERT INTO activity_certificates (id,employee_id,employee_name,employee_date_of_birth,employee_id_number,employee_employment_start,from_at,to_at,activity_type,company_place,company_date,driver_place,driver_date,declarant_name,declarant_position,sync_status,created_at,created_by,updated_at,deleted,server_seq)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET employee_id=excluded.employee_id,employee_name=excluded.employee_name,employee_date_of_birth=excluded.employee_date_of_birth,employee_id_number=excluded.employee_id_number,employee_employment_start=excluded.employee_employment_start,from_at=excluded.from_at,to_at=excluded.to_at,activity_type=excluded.activity_type,company_place=excluded.company_place,company_date=excluded.company_date,driver_place=excluded.driver_place,driver_date=excluded.driver_date,declarant_name=excluded.declarant_name,declarant_position=excluded.declarant_position,sync_status=excluded.sync_status,created_at=excluded.created_at,created_by=excluded.created_by,updated_at=excluded.updated_at,deleted=excluded.deleted,server_seq=excluded.server_seq`)
        .run(id, obj.employeeId ?? '', obj.employeeName ?? '', obj.employeeDateOfBirth ?? '', obj.employeeIdNumber ?? '', obj.employeeEmploymentStart ?? '', obj.fromAt ?? '', obj.toAt ?? '', obj.activityType ?? '', obj.companyPlace ?? '', obj.companyDate ?? '', obj.driverPlace ?? '', obj.driverDate ?? '', obj.declarantName ?? '', obj.declarantPosition ?? '', obj.syncStatus ?? 'SINHRONIZIRANO', obj.createdAt ?? '', obj.createdBy ?? '', updatedAt, b(deleted), seq)
      db.prepare('DELETE FROM activity_certificate_signatures WHERE certificate_id = ?').run(id)
      if (!deleted) {
        const ins = db.prepare('INSERT INTO activity_certificate_signatures (certificate_id,row_no,role,signer_name,type,data_url,signed_at,captured_by) VALUES (?,?,?,?,?,?,?,?)')
        ;(obj.signatures ?? []).forEach((x, i) => ins.run(id, i, x.role ?? '', x.signerName ?? '', x.type ?? 'ROCNO', x.dataUrl ?? null, x.signedAt ?? '', x.capturedBy ?? ''))
      }
      return
    }
    if (tbl === 'settings') {
      const c = { ...emptyCompany(), ...(obj.company ?? {}) }
      db.prepare(`INSERT INTO company (id,name,street,postal_code,city,country,phone,fax,email,declarant_name,declarant_position,updated_at) VALUES ('main',?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,street=excluded.street,postal_code=excluded.postal_code,city=excluded.city,country=excluded.country,phone=excluded.phone,fax=excluded.fax,email=excluded.email,declarant_name=excluded.declarant_name,declarant_position=excluded.declarant_position,updated_at=excluded.updated_at`)
        .run(c.name, c.street, c.postalCode, c.city, c.country, c.phone, c.fax, c.email, c.declarantName, c.declarantPosition, updatedAt)
      db.prepare(`INSERT INTO app_settings (id,numbering_scope,number_format,finance_can_close,require_purpose,auto_sync,updated_at,deleted,server_seq) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET numbering_scope=excluded.numbering_scope,number_format=excluded.number_format,finance_can_close=excluded.finance_can_close,require_purpose=excluded.require_purpose,auto_sync=excluded.auto_sync,updated_at=excluded.updated_at,deleted=excluded.deleted,server_seq=excluded.server_seq`)
        .run(id, obj.numberingScope ?? 'PER_DESK', obj.numberFormat ?? 'SLASH', b(!!obj.financeCanClose), b(obj.requirePurpose !== false), b(obj.autoSync !== false), updatedAt, b(deleted), seq)
      return
    }
    if (tbl === 'closes') {
      db.prepare(`INSERT INTO month_closes (id,scope_key,desk_id,year,month,month_key,bp_start,bp_end,bi_start,bi_end,doc_count,closed_by,closed_at,idempotency_key,updated_at,deleted,server_seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET scope_key=excluded.scope_key,desk_id=excluded.desk_id,year=excluded.year,month=excluded.month,month_key=excluded.month_key,bp_start=excluded.bp_start,bp_end=excluded.bp_end,bi_start=excluded.bi_start,bi_end=excluded.bi_end,doc_count=excluded.doc_count,closed_by=excluded.closed_by,closed_at=excluded.closed_at,idempotency_key=excluded.idempotency_key,updated_at=excluded.updated_at,deleted=excluded.deleted,server_seq=excluded.server_seq`)
        .run(id, obj.scopeKey ?? '', obj.deskId ?? null, Number(obj.year ?? 0), Number(obj.month ?? 0), obj.monthKey ?? '', Number(obj.bpStart ?? 0), Number(obj.bpEnd ?? 0), Number(obj.biStart ?? 0), Number(obj.biEnd ?? 0), Number(obj.docCount ?? 0), obj.closedBy ?? '', obj.closedAt ?? '', obj.idempotencyKey ?? '', updatedAt, b(deleted), seq)
      db.prepare('DELETE FROM month_close_manifest WHERE close_id = ?').run(id)
      if (!deleted) {
        const ins = db.prepare('INSERT INTO month_close_manifest (close_id,row_no,doc_id,type,number,transaction_at,employee_name,amount) VALUES (?,?,?,?,?,?,?,?)')
        ;(obj.manifest ?? []).forEach((x, i) => ins.run(id, i, x.docId ?? '', x.type ?? '', Number(x.number ?? 0), x.transactionAt ?? '', x.employeeName ?? '', Number(x.amount ?? 0)))
      }
    }
  }

  const migrateLegacy = () => {
    const done = db.prepare(`SELECT v FROM meta WHERE k = 'normalized_schema_v2'`).get()
    if (done?.v === '1') return
    const legacy = db.prepare(`SELECT tbl,id,json,updated_at,deleted,server_seq FROM records ORDER BY server_seq`).all()
    let moved = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of legacy) {
        if (!SUPPORTED.has(r.tbl)) continue
        const exists = db.prepare(`SELECT 1 AS x FROM ${topTable[r.tbl]} WHERE id = ?`).get(r.id)
        if (exists) continue
        let obj
        try { obj = JSON.parse(r.json) } catch { continue }
        writeAtSeq(r.tbl, r.id, obj, r.updated_at, bool(r.deleted), Number(r.server_seq))
        moved++
      }
      const seqValues = [
        Number(db.prepare(`SELECT v FROM meta WHERE k='seq'`).get()?.v ?? 0),
        Number(db.prepare(`SELECT COALESCE(MAX(server_seq),0) AS n FROM records`).get().n),
        Number(db.prepare(`SELECT COALESCE(MAX(server_seq),0) AS n FROM audit`).get().n),
        ...Object.values(topTable).map((t) => Number(db.prepare(`SELECT COALESCE(MAX(server_seq),0) AS n FROM ${t}`).get().n)),
      ]
      const maxSeq = Math.max(...seqValues)
      db.prepare(`INSERT INTO meta(k,v) VALUES('seq',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`).run(String(maxSeq))
      db.prepare(`INSERT INTO meta(k,v) VALUES('normalized_schema_v2','1') ON CONFLICT(k) DO UPDATE SET v='1'`).run()
      db.exec('COMMIT')
      if (moved) console.log(`[blagajna] SQLite: migriranih ${moved} legacy JSON zapisov v normalizirane tabele.`)
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      throw e
    }
  }
  migrateLegacy()

  const api = {
    driver: 'sqlite',

    async userCount() { return db.prepare('SELECT COUNT(*) AS n FROM users').get().n },
    async getUserByEmail(email) { return db.prepare('SELECT * FROM users WHERE email = ?').get(email) ?? null },
    async getUserById(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null },
    async listUsers() { return db.prepare('SELECT * FROM users ORDER BY name').all() },
    async insertUser(u) {
      db.prepare('INSERT INTO users (id, email, name, role, pass_hash, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(u.id, u.email, u.name, u.role, u.pass_hash, u.active ? 1 : 0, u.created_at, u.updated_at)
    },
    async updateUser(u) {
      db.prepare('UPDATE users SET name = ?, role = ?, active = ?, pass_hash = ?, updated_at = ? WHERE id = ?')
        .run(u.name, u.role, u.active ? 1 : 0, u.pass_hash, u.updated_at, u.id)
    },

    async nextSeq() {
      db.exec(`UPDATE meta SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) WHERE k = 'seq'`)
      return parseInt(db.prepare(`SELECT v FROM meta WHERE k = 'seq'`).get().v, 10)
    },

    async getRecord(tbl, id) {
      if (SUPPORTED.has(tbl)) return readBy(tbl, id)
      const r = db.prepare('SELECT json, updated_at, deleted FROM records WHERE tbl = ? AND id = ?').get(tbl, id)
      return r ? { json: JSON.parse(r.json), updatedAt: r.updated_at, deleted: bool(r.deleted) } : null
    },
    async putRecord(tbl, id, obj, updatedAt, deleted = false) {
      const seq = await api.nextSeq()
      if (SUPPORTED.has(tbl)) writeAtSeq(tbl, id, obj, updatedAt, deleted, seq)
      else {
        db.prepare(`INSERT INTO records (tbl,id,json,updated_at,deleted,server_seq) VALUES (?,?,?,?,?,?)
          ON CONFLICT(tbl,id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at,deleted=excluded.deleted,server_seq=excluded.server_seq`)
          .run(tbl, id, JSON.stringify(obj), updatedAt, b(deleted), seq)
      }
      return seq
    },
    async listTable(tbl, includeDeleted = false) {
      if (!SUPPORTED.has(tbl)) {
        const rows = db.prepare(`SELECT json FROM records WHERE tbl = ?${includeDeleted ? '' : ' AND deleted = 0'}`).all(tbl)
        return rows.map((r) => JSON.parse(r.json))
      }
      const ids = db.prepare(`SELECT id FROM ${topTable[tbl]}${includeDeleted ? '' : ' WHERE deleted = 0'} ORDER BY id`).all().map((r) => r.id)
      return ids.map((id) => readBy(tbl, id)?.json).filter(Boolean)
    },
    async pullSince(since) {
      const changes = db.prepare(`
        SELECT 'docs' AS tbl,id,deleted,server_seq FROM cash_documents WHERE server_seq > ?
        UNION ALL SELECT 'potrdila',id,deleted,server_seq FROM activity_certificates WHERE server_seq > ?
        UNION ALL SELECT 'employees',id,deleted,server_seq FROM employees WHERE server_seq > ?
        UNION ALL SELECT 'desks',id,deleted,server_seq FROM cash_desks WHERE server_seq > ?
        UNION ALL SELECT 'settings',id,deleted,server_seq FROM app_settings WHERE server_seq > ?
        UNION ALL SELECT 'transfers',id,deleted,server_seq FROM cash_transfers WHERE server_seq > ?
        UNION ALL SELECT 'closes',id,deleted,server_seq FROM month_closes WHERE server_seq > ?
        ORDER BY server_seq
      `).all(since, since, since, since, since, since, since)
      const records = changes.map((r) => {
        const rec = r.deleted ? null : readBy(r.tbl, r.id)
        return { tbl: r.tbl, id: r.id, json: JSON.stringify(rec?.json ?? {}), deleted: Number(r.deleted), server_seq: Number(r.server_seq) }
      })
      const audit = db.prepare('SELECT id, at, user, role, action, entity, entity_id AS entityId, details, server_seq FROM audit WHERE server_seq > ? ORDER BY server_seq').all(since)
      return { records, audit }
    },
    async addAudit(e) {
      const seq = await api.nextSeq()
      db.prepare('INSERT OR IGNORE INTO audit (id, at, user, role, action, entity, entity_id, details, server_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(e.id, e.at, e.user, e.role, e.action, e.entity, e.entityId ?? '', e.details ?? '', seq)
    },

    async tx(fn) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const r = await fn(api)
        db.exec('COMMIT')
        return r
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* already closed */ }
        throw e
      }
    },
  }
  return api
}
