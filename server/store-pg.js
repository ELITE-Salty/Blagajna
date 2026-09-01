// PostgreSQL gonilnik — normalizirana relacijska shema.
// `records` ostane samo kot legacy vir za samodejno migracijo; novi znani zapisi
// se shranjujejo v company/app_settings/cash_desks/employees/cash_documents/... tabele.

const CANONICAL = {
  users: `CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
    pass_hash TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`,
  records: `CREATE TABLE records (
    tbl TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, updated_at TEXT NOT NULL,
    deleted BOOLEAN NOT NULL DEFAULT FALSE, server_seq BIGINT NOT NULL, PRIMARY KEY (tbl, id)
  )`,
  audit: `CREATE TABLE audit (
    id TEXT PRIMARY KEY, at TEXT NOT NULL, "user" TEXT NOT NULL, role TEXT NOT NULL, action TEXT NOT NULL,
    entity TEXT NOT NULL, entity_id TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', server_seq BIGINT NOT NULL
  )`,
  meta: `CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
}

const REQUIRED_COLS = {
  users: ['id', 'email', 'name', 'role', 'pass_hash', 'active', 'created_at', 'updated_at'],
  records: ['tbl', 'id', 'json', 'updated_at', 'deleted', 'server_seq'],
  audit: ['id', 'at', 'user', 'role', 'action', 'entity', 'entity_id', 'details', 'server_seq'],
  meta: ['k', 'v'],
}
const BOOL_COLS = { users: ['active'], records: ['deleted'] }
const COL_DEFAULT_DDL = {
  'users.active': 'BOOLEAN NOT NULL DEFAULT TRUE',
  'records.deleted': 'BOOLEAN NOT NULL DEFAULT FALSE',
  'records.server_seq': 'BIGINT NOT NULL DEFAULT 0',
  'audit.server_seq': 'BIGINT NOT NULL DEFAULT 0',
  'audit.details': `TEXT NOT NULL DEFAULT ''`,
}
const INT_TYPES = new Set(['integer', 'bigint', 'smallint', 'numeric'])

const NORMALIZED_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS company (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', street TEXT NOT NULL DEFAULT '', postal_code TEXT NOT NULL DEFAULT '',
    city TEXT NOT NULL DEFAULT '', country TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', fax TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '', declarant_name TEXT NOT NULL DEFAULT '', declarant_position TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS app_settings (
    id TEXT PRIMARY KEY, numbering_scope TEXT NOT NULL DEFAULT 'PER_DESK', number_format TEXT NOT NULL DEFAULT 'SLASH',
    finance_can_close BOOLEAN NOT NULL DEFAULT FALSE, require_purpose BOOLEAN NOT NULL DEFAULT TRUE, auto_sync BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TEXT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE, server_seq BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cash_desks (
    id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', code TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    active BOOLEAN NOT NULL DEFAULT TRUE, opening_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE, server_seq BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY, first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', display_name TEXT NOT NULL DEFAULT '',
    date_of_birth TEXT NOT NULL DEFAULT '', id_number TEXT NOT NULL DEFAULT '', employment_start TEXT NOT NULL DEFAULT '', employee_number TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '', vehicle TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE, server_seq BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cash_documents (
    id TEXT PRIMARY KEY, desk_id TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'BP', official_number INTEGER, seq_year INTEGER,
    transaction_date TEXT NOT NULL DEFAULT '', transaction_time TEXT NOT NULL DEFAULT '', month_key TEXT NOT NULL DEFAULT '',
    employee_id TEXT NOT NULL DEFAULT '', employee_name TEXT NOT NULL DEFAULT '', amount DOUBLE PRECISION,
    amount_words_override TEXT NOT NULL DEFAULT '', payment_method TEXT NOT NULL DEFAULT '', purpose TEXT NOT NULL DEFAULT '',
    prejel_status TEXT NOT NULL DEFAULT 'NI_PODPISANO', notes TEXT NOT NULL DEFAULT '', potrdilo_id TEXT,
    status TEXT NOT NULL DEFAULT 'ODPRT', sync_status TEXT NOT NULL DEFAULT 'SINHRONIZIRANO', created_at TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL, updated_by TEXT NOT NULL DEFAULT '', finalized_at TEXT, finalized_by TEXT, cancelled_at TEXT, cancelled_by TEXT,
    cancel_reason TEXT, correction_of_id TEXT, deleted BOOLEAN NOT NULL DEFAULT FALSE, server_seq BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS cash_document_rows (
    doc_id TEXT NOT NULL REFERENCES cash_documents(id) ON DELETE CASCADE, row_no INTEGER NOT NULL,
    opis TEXT NOT NULL DEFAULT '', konto TEXT NOT NULL DEFAULT '', znesek DOUBLE PRECISION, PRIMARY KEY (doc_id, row_no)
  )`,
  `CREATE TABLE IF NOT EXISTS cash_document_attachments (
    doc_id TEXT NOT NULL REFERENCES cash_documents(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', mime TEXT NOT NULL DEFAULT '',
    data_url TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (doc_id, id)
  )`,
  `CREATE TABLE IF NOT EXISTS cash_document_signatures (
    doc_id TEXT NOT NULL REFERENCES cash_documents(id) ON DELETE CASCADE, row_no INTEGER NOT NULL, role TEXT NOT NULL DEFAULT '', signer_name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'ROCNO', data_url TEXT, signed_at TEXT NOT NULL DEFAULT '', captured_by TEXT NOT NULL DEFAULT '', PRIMARY KEY (doc_id, row_no)
  )`,
  `CREATE TABLE IF NOT EXISTS activity_certificates (
    id TEXT PRIMARY KEY, employee_id TEXT NOT NULL DEFAULT '', employee_name TEXT NOT NULL DEFAULT '', employee_date_of_birth TEXT NOT NULL DEFAULT '',
    employee_id_number TEXT NOT NULL DEFAULT '', employee_employment_start TEXT NOT NULL DEFAULT '', from_at TEXT NOT NULL DEFAULT '', to_at TEXT NOT NULL DEFAULT '',
    activity_type TEXT NOT NULL DEFAULT '', company_place TEXT NOT NULL DEFAULT '', company_date TEXT NOT NULL DEFAULT '', driver_place TEXT NOT NULL DEFAULT '',
    driver_date TEXT NOT NULL DEFAULT '', declarant_name TEXT NOT NULL DEFAULT '', declarant_position TEXT NOT NULL DEFAULT '', sync_status TEXT NOT NULL DEFAULT 'SINHRONIZIRANO',
    created_at TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE, server_seq BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS activity_certificate_signatures (
    certificate_id TEXT NOT NULL REFERENCES activity_certificates(id) ON DELETE CASCADE, row_no INTEGER NOT NULL, role TEXT NOT NULL DEFAULT '',
    signer_name TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'ROCNO', data_url TEXT, signed_at TEXT NOT NULL DEFAULT '', captured_by TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (certificate_id, row_no)
  )`,
  `CREATE TABLE IF NOT EXISTS month_closes (
    id TEXT PRIMARY KEY, scope_key TEXT NOT NULL DEFAULT '', desk_id TEXT, year INTEGER NOT NULL DEFAULT 0, month INTEGER NOT NULL DEFAULT 0,
    month_key TEXT NOT NULL DEFAULT '', bp_start INTEGER NOT NULL DEFAULT 0, bp_end INTEGER NOT NULL DEFAULT 0, bi_start INTEGER NOT NULL DEFAULT 0,
    bi_end INTEGER NOT NULL DEFAULT 0, doc_count INTEGER NOT NULL DEFAULT 0, closed_by TEXT NOT NULL DEFAULT '', closed_at TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, deleted BOOLEAN NOT NULL DEFAULT FALSE, server_seq BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS month_close_manifest (
    close_id TEXT NOT NULL REFERENCES month_closes(id) ON DELETE CASCADE, row_no INTEGER NOT NULL, doc_id TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '',
    number INTEGER NOT NULL DEFAULT 0, transaction_at TEXT NOT NULL DEFAULT '', employee_name TEXT NOT NULL DEFAULT '', amount DOUBLE PRECISION NOT NULL DEFAULT 0,
    PRIMARY KEY (close_id, row_no)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_app_settings_seq ON app_settings (server_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_cash_desks_name ON cash_desks (name)`,
  `CREATE INDEX IF NOT EXISTS idx_cash_desks_seq ON cash_desks (server_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_employees_name ON employees (display_name)`,
  `CREATE INDEX IF NOT EXISTS idx_employees_number ON employees (employee_number)`,
  `CREATE INDEX IF NOT EXISTS idx_employees_seq ON employees (server_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_cash_documents_month ON cash_documents (month_key)`,
  `CREATE INDEX IF NOT EXISTS idx_cash_documents_desk_date ON cash_documents (desk_id, transaction_date, transaction_time)`,
  `CREATE INDEX IF NOT EXISTS idx_cash_documents_employee ON cash_documents (employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cash_documents_type_status ON cash_documents (type, status)`,
  `CREATE INDEX IF NOT EXISTS idx_cash_documents_seq ON cash_documents (server_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_cash_document_rows_konto ON cash_document_rows (konto)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_cert_employee ON activity_certificates (employee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_cert_period ON activity_certificates (from_at, to_at)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_cert_seq ON activity_certificates (server_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_month_closes_month ON month_closes (month_key)`,
  `CREATE INDEX IF NOT EXISTS idx_month_closes_scope_year ON month_closes (scope_key, year)`,
  `CREATE INDEX IF NOT EXISTS idx_month_closes_seq ON month_closes (server_seq)`,
]

async function reconcileSchema(pool) {
  const warn = (m, e) => console.warn(`[blagajna] uskladitev sheme: ${m}${e ? ` (${e.message})` : ''}`)
  for (const table of Object.keys(CANONICAL)) {
    let cols = new Map()
    try {
      const r = await pool.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema()`, [table])
      for (const row of r.rows) cols.set(row.column_name, row.data_type)
    } catch (e) { warn(`ne morem prebrati stolpcev za ${table}`, e) }
    if (cols.size === 0) { await pool.query(CANONICAL[table]); continue }
    const missing = REQUIRED_COLS[table].filter((c) => !cols.has(c))
    const wrongBool = (BOOL_COLS[table] ?? []).filter((c) => cols.has(c) && cols.get(c) !== 'boolean')
    let pkMissing = false
    try {
      const pk = await pool.query(`SELECT COUNT(*) AS n FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`, [table])
      pkMissing = parseInt(pk.rows[0].n, 10) === 0
    } catch { /* pg-mem */ }
    if (missing.length === 0 && wrongBool.length === 0 && !pkMissing) continue
    let count = 1
    try { count = parseInt((await pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n, 10) } catch { /* cautious */ }
    if (count === 0) {
      try { await pool.query(`DROP TABLE ${table}`); await pool.query(CANONICAL[table]); warn(`tabela ${table} je bila prazna in napačne oblike — poustvarjena kanonično`); continue }
      catch (e) { warn(`poustvaritev tabele ${table} ni uspela`, e) }
    }
    for (const c of missing) {
      const ddl = COL_DEFAULT_DDL[`${table}.${c}`]
      if (!ddl) { warn(`tabeli ${table} manjka stolpec ${c} brez znane privzete vrednosti — ročno posredovanje`); continue }
      try { await pool.query(`ALTER TABLE ${table} ADD COLUMN ${c === 'user' ? '"user"' : c} ${ddl}`); warn(`tabeli ${table} dodan manjkajoči stolpec ${c}`) }
      catch (e) { warn(`dodajanje stolpca ${table}.${c} ni uspelo`, e) }
    }
    for (const c of wrongBool) {
      if (!INT_TYPES.has(cols.get(c))) { warn(`stolpec ${table}.${c} je tipa ${cols.get(c)} — pričakovan boolean; ročno posredovanje`); continue }
      try {
        await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${c} DROP DEFAULT`)
        await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${c} TYPE BOOLEAN USING (${c} <> 0)`)
        await pool.query(`ALTER TABLE ${table} ALTER COLUMN ${c} SET DEFAULT ${c === 'active' ? 'TRUE' : 'FALSE'}`)
      } catch (e) { warn(`pretvorba ${table}.${c} v BOOLEAN ni uspela`, e) }
    }
    if (pkMissing && count > 0) {
      try { await pool.query(table === 'records' ? `ALTER TABLE records ADD PRIMARY KEY (tbl, id)` : `ALTER TABLE ${table} ADD PRIMARY KEY (${table === 'meta' ? 'k' : 'id'})`) }
      catch (e) { warn(`dodajanje primarnega ključa na ${table} ni uspelo`, e) }
    }
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_records_seq ON records (server_seq)`).catch(() => {})
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit (server_seq)`).catch(() => {})
  for (const sql of NORMALIZED_SCHEMA) await pool.query(sql)
}

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v)
const isoStr = (v) => (v instanceof Date ? v.toISOString() : v)
const truthy = (v) => v === true || v === 1 || v === '1' || v === 't' || v === 'true'
const SUPPORTED = new Set(['docs', 'potrdila', 'employees', 'desks', 'settings', 'closes'])
const topTable = { docs: 'cash_documents', potrdila: 'activity_certificates', employees: 'employees', desks: 'cash_desks', settings: 'app_settings', closes: 'month_closes' }
const emptyCompany = () => ({ name: '', street: '', postalCode: '', city: '', country: '', phone: '', fax: '', email: '', declarantName: '', declarantPosition: '' })

async function readBy(q, tbl, id) {
  if (tbl === 'desks') {
    const r = (await q('SELECT * FROM cash_desks WHERE id=$1', [id]))[0]; if (!r) return null
    return { json: { id: r.id, name: r.name, code: r.code, description: r.description, active: truthy(r.active), openingBalance: Number(r.opening_balance ?? 0), updatedAt: isoStr(r.updated_at) }, updatedAt: isoStr(r.updated_at), deleted: truthy(r.deleted) }
  }
  if (tbl === 'employees') {
    const r = (await q('SELECT * FROM employees WHERE id=$1', [id]))[0]; if (!r) return null
    return { json: { id:r.id, firstName:r.first_name, lastName:r.last_name, displayName:r.display_name, dateOfBirth:r.date_of_birth, idNumber:r.id_number, employmentStart:r.employment_start, employeeNumber:r.employee_number, phone:r.phone, vehicle:r.vehicle, notes:r.notes, active:truthy(r.active), createdAt:isoStr(r.created_at), updatedAt:isoStr(r.updated_at) }, updatedAt:isoStr(r.updated_at), deleted:truthy(r.deleted) }
  }
  if (tbl === 'docs') {
    const r = (await q('SELECT * FROM cash_documents WHERE id=$1', [id]))[0]; if (!r) return null
    const rows = (await q('SELECT opis,konto,znesek FROM cash_document_rows WHERE doc_id=$1 ORDER BY row_no',[id])).map((x)=>({opis:x.opis,konto:x.konto,znesek:x.znesek==null?null:Number(x.znesek)}))
    const attachments = (await q('SELECT id,name,mime,data_url,added_at FROM cash_document_attachments WHERE doc_id=$1 ORDER BY id',[id])).map((x)=>({id:x.id,name:x.name,mime:x.mime,dataUrl:x.data_url,addedAt:isoStr(x.added_at)}))
    const signatures = (await q('SELECT role,signer_name,type,data_url,signed_at,captured_by FROM cash_document_signatures WHERE doc_id=$1 ORDER BY row_no',[id])).map((x)=>({role:x.role,signerName:x.signer_name,type:x.type,...(x.data_url?{dataUrl:x.data_url}:{}),signedAt:isoStr(x.signed_at),capturedBy:x.captured_by}))
    const json = { id:r.id,deskId:r.desk_id,type:r.type,officialNumber:r.official_number==null?null:Number(r.official_number),seqYear:r.seq_year==null?null:Number(r.seq_year),transactionDate:r.transaction_date,transactionTime:r.transaction_time,monthKey:r.month_key,employeeId:r.employee_id,employeeName:r.employee_name,amount:r.amount==null?null:Number(r.amount),amountWordsOverride:r.amount_words_override,paymentMethod:r.payment_method,purpose:r.purpose,rows,attachments,signatures,prejelStatus:r.prejel_status,notes:r.notes,potrdiloId:r.potrdilo_id??null,status:r.status,syncStatus:r.sync_status,createdAt:isoStr(r.created_at),createdBy:r.created_by,updatedAt:isoStr(r.updated_at),updatedBy:r.updated_by,...(r.finalized_at?{finalizedAt:isoStr(r.finalized_at)}:{}),...(r.finalized_by?{finalizedBy:r.finalized_by}:{}),...(r.cancelled_at?{cancelledAt:isoStr(r.cancelled_at)}:{}),...(r.cancelled_by?{cancelledBy:r.cancelled_by}:{}),...(r.cancel_reason?{cancelReason:r.cancel_reason}:{}),correctionOfId:r.correction_of_id??null }
    return { json, updatedAt:isoStr(r.updated_at), deleted:truthy(r.deleted) }
  }
  if (tbl === 'potrdila') {
    const r=(await q('SELECT * FROM activity_certificates WHERE id=$1',[id]))[0]; if(!r)return null
    const signatures=(await q('SELECT role,signer_name,type,data_url,signed_at,captured_by FROM activity_certificate_signatures WHERE certificate_id=$1 ORDER BY row_no',[id])).map((x)=>({role:x.role,signerName:x.signer_name,type:x.type,...(x.data_url?{dataUrl:x.data_url}:{}),signedAt:isoStr(x.signed_at),capturedBy:x.captured_by}))
    return {json:{id:r.id,employeeId:r.employee_id,employeeName:r.employee_name,employeeDateOfBirth:r.employee_date_of_birth,employeeIdNumber:r.employee_id_number,employeeEmploymentStart:r.employee_employment_start,fromAt:r.from_at,toAt:r.to_at,activityType:r.activity_type,companyPlace:r.company_place,companyDate:r.company_date,driverPlace:r.driver_place,driverDate:r.driver_date,declarantName:r.declarant_name,declarantPosition:r.declarant_position,signatures,syncStatus:r.sync_status,createdAt:isoStr(r.created_at),createdBy:r.created_by,updatedAt:isoStr(r.updated_at)},updatedAt:isoStr(r.updated_at),deleted:truthy(r.deleted)}
  }
  if (tbl === 'settings') {
    const r=(await q('SELECT * FROM app_settings WHERE id=$1',[id]))[0]; if(!r)return null
    const c=(await q(`SELECT * FROM company WHERE id='main'`))[0]
    const company=c?{name:c.name,street:c.street,postalCode:c.postal_code,city:c.city,country:c.country,phone:c.phone,fax:c.fax,email:c.email,declarantName:c.declarant_name,declarantPosition:c.declarant_position}:emptyCompany()
    return {json:{id:'main',company,numberingScope:r.numbering_scope,numberFormat:r.number_format,financeCanClose:truthy(r.finance_can_close),requirePurpose:truthy(r.require_purpose),autoSync:truthy(r.auto_sync),updatedAt:isoStr(r.updated_at)},updatedAt:isoStr(r.updated_at),deleted:truthy(r.deleted)}
  }
  if (tbl === 'closes') {
    const r=(await q('SELECT * FROM month_closes WHERE id=$1',[id]))[0]; if(!r)return null
    const manifest=(await q('SELECT doc_id,type,number,transaction_at,employee_name,amount FROM month_close_manifest WHERE close_id=$1 ORDER BY row_no',[id])).map((x)=>({docId:x.doc_id,type:x.type,number:Number(x.number),transactionAt:x.transaction_at,employeeName:x.employee_name,amount:Number(x.amount)}))
    return {json:{id:r.id,scopeKey:r.scope_key,deskId:r.desk_id??null,year:Number(r.year),month:Number(r.month),monthKey:r.month_key,bpStart:Number(r.bp_start),bpEnd:Number(r.bp_end),biStart:Number(r.bi_start),biEnd:Number(r.bi_end),docCount:Number(r.doc_count),closedBy:r.closed_by,closedAt:isoStr(r.closed_at),idempotencyKey:r.idempotency_key,manifest},updatedAt:isoStr(r.updated_at),deleted:truthy(r.deleted)}
  }
  return null
}

async function writeAtSeq(q,tbl,id,obj,updatedAt,deleted,seq){
  if(tbl==='desks'){
    await q(`INSERT INTO cash_desks(id,name,code,description,active,opening_balance,updated_at,deleted,server_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,code=EXCLUDED.code,description=EXCLUDED.description,active=EXCLUDED.active,opening_balance=EXCLUDED.opening_balance,updated_at=EXCLUDED.updated_at,deleted=EXCLUDED.deleted,server_seq=EXCLUDED.server_seq`,[id,obj.name??'',obj.code??'',obj.description??'',obj.active!==false,Number(obj.openingBalance??0),updatedAt,!!deleted,seq]); return
  }
  if(tbl==='employees'){
    await q(`INSERT INTO employees(id,first_name,last_name,display_name,date_of_birth,id_number,employment_start,employee_number,phone,vehicle,notes,active,created_at,updated_at,deleted,server_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      ON CONFLICT(id) DO UPDATE SET first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,display_name=EXCLUDED.display_name,date_of_birth=EXCLUDED.date_of_birth,id_number=EXCLUDED.id_number,employment_start=EXCLUDED.employment_start,employee_number=EXCLUDED.employee_number,phone=EXCLUDED.phone,vehicle=EXCLUDED.vehicle,notes=EXCLUDED.notes,active=EXCLUDED.active,created_at=EXCLUDED.created_at,updated_at=EXCLUDED.updated_at,deleted=EXCLUDED.deleted,server_seq=EXCLUDED.server_seq`,[id,obj.firstName??'',obj.lastName??'',obj.displayName??'',obj.dateOfBirth??'',obj.idNumber??'',obj.employmentStart??'',obj.employeeNumber??'',obj.phone??'',obj.vehicle??'',obj.notes??'',obj.active!==false,obj.createdAt??'',updatedAt,!!deleted,seq]); return
  }
  if(tbl==='docs'){
    await q(`INSERT INTO cash_documents(id,desk_id,type,official_number,seq_year,transaction_date,transaction_time,month_key,employee_id,employee_name,amount,amount_words_override,payment_method,purpose,prejel_status,notes,potrdilo_id,status,sync_status,created_at,created_by,updated_at,updated_by,finalized_at,finalized_by,cancelled_at,cancelled_by,cancel_reason,correction_of_id,deleted,server_seq)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31)
      ON CONFLICT(id) DO UPDATE SET desk_id=EXCLUDED.desk_id,type=EXCLUDED.type,official_number=EXCLUDED.official_number,seq_year=EXCLUDED.seq_year,transaction_date=EXCLUDED.transaction_date,transaction_time=EXCLUDED.transaction_time,month_key=EXCLUDED.month_key,employee_id=EXCLUDED.employee_id,employee_name=EXCLUDED.employee_name,amount=EXCLUDED.amount,amount_words_override=EXCLUDED.amount_words_override,payment_method=EXCLUDED.payment_method,purpose=EXCLUDED.purpose,prejel_status=EXCLUDED.prejel_status,notes=EXCLUDED.notes,potrdilo_id=EXCLUDED.potrdilo_id,status=EXCLUDED.status,sync_status=EXCLUDED.sync_status,created_at=EXCLUDED.created_at,created_by=EXCLUDED.created_by,updated_at=EXCLUDED.updated_at,updated_by=EXCLUDED.updated_by,finalized_at=EXCLUDED.finalized_at,finalized_by=EXCLUDED.finalized_by,cancelled_at=EXCLUDED.cancelled_at,cancelled_by=EXCLUDED.cancelled_by,cancel_reason=EXCLUDED.cancel_reason,correction_of_id=EXCLUDED.correction_of_id,deleted=EXCLUDED.deleted,server_seq=EXCLUDED.server_seq`,[id,obj.deskId??'',obj.type??'BP',obj.officialNumber??null,obj.seqYear??null,obj.transactionDate??'',obj.transactionTime??'',obj.monthKey??'',obj.employeeId??'',obj.employeeName??'',obj.amount??null,obj.amountWordsOverride??'',obj.paymentMethod??'',obj.purpose??'',obj.prejelStatus??'NI_PODPISANO',obj.notes??'',obj.potrdiloId??null,obj.status??'ODPRT',obj.syncStatus??'SINHRONIZIRANO',obj.createdAt??'',obj.createdBy??'',updatedAt,obj.updatedBy??'',obj.finalizedAt??null,obj.finalizedBy??null,obj.cancelledAt??null,obj.cancelledBy??null,obj.cancelReason??null,obj.correctionOfId??null,!!deleted,seq])
    await q('DELETE FROM cash_document_rows WHERE doc_id=$1',[id]); await q('DELETE FROM cash_document_attachments WHERE doc_id=$1',[id]); await q('DELETE FROM cash_document_signatures WHERE doc_id=$1',[id])
    if(!deleted){for(const [i,x] of (obj.rows??[]).entries())await q('INSERT INTO cash_document_rows(doc_id,row_no,opis,konto,znesek) VALUES($1,$2,$3,$4,$5)',[id,i,x.opis??'',x.konto??'',x.znesek??null]); for(const x of obj.attachments??[])await q('INSERT INTO cash_document_attachments(doc_id,id,name,mime,data_url,added_at) VALUES($1,$2,$3,$4,$5,$6)',[id,x.id??'',x.name??'',x.mime??'',x.dataUrl??'',x.addedAt??'']); for(const [i,x] of (obj.signatures??[]).entries())await q('INSERT INTO cash_document_signatures(doc_id,row_no,role,signer_name,type,data_url,signed_at,captured_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,i,x.role??'',x.signerName??'',x.type??'ROCNO',x.dataUrl??null,x.signedAt??'',x.capturedBy??''])}; return
  }
  if(tbl==='potrdila'){
    await q(`INSERT INTO activity_certificates(id,employee_id,employee_name,employee_date_of_birth,employee_id_number,employee_employment_start,from_at,to_at,activity_type,company_place,company_date,driver_place,driver_date,declarant_name,declarant_position,sync_status,created_at,created_by,updated_at,deleted,server_seq)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
      ON CONFLICT(id) DO UPDATE SET employee_id=EXCLUDED.employee_id,employee_name=EXCLUDED.employee_name,employee_date_of_birth=EXCLUDED.employee_date_of_birth,employee_id_number=EXCLUDED.employee_id_number,employee_employment_start=EXCLUDED.employee_employment_start,from_at=EXCLUDED.from_at,to_at=EXCLUDED.to_at,activity_type=EXCLUDED.activity_type,company_place=EXCLUDED.company_place,company_date=EXCLUDED.company_date,driver_place=EXCLUDED.driver_place,driver_date=EXCLUDED.driver_date,declarant_name=EXCLUDED.declarant_name,declarant_position=EXCLUDED.declarant_position,sync_status=EXCLUDED.sync_status,created_at=EXCLUDED.created_at,created_by=EXCLUDED.created_by,updated_at=EXCLUDED.updated_at,deleted=EXCLUDED.deleted,server_seq=EXCLUDED.server_seq`,[id,obj.employeeId??'',obj.employeeName??'',obj.employeeDateOfBirth??'',obj.employeeIdNumber??'',obj.employeeEmploymentStart??'',obj.fromAt??'',obj.toAt??'',obj.activityType??'',obj.companyPlace??'',obj.companyDate??'',obj.driverPlace??'',obj.driverDate??'',obj.declarantName??'',obj.declarantPosition??'',obj.syncStatus??'SINHRONIZIRANO',obj.createdAt??'',obj.createdBy??'',updatedAt,!!deleted,seq])
    await q('DELETE FROM activity_certificate_signatures WHERE certificate_id=$1',[id]); if(!deleted)for(const [i,x] of (obj.signatures??[]).entries())await q('INSERT INTO activity_certificate_signatures(certificate_id,row_no,role,signer_name,type,data_url,signed_at,captured_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,i,x.role??'',x.signerName??'',x.type??'ROCNO',x.dataUrl??null,x.signedAt??'',x.capturedBy??'']); return
  }
  if(tbl==='settings'){
    const c={...emptyCompany(),...(obj.company??{})}
    await q(`INSERT INTO company(id,name,street,postal_code,city,country,phone,fax,email,declarant_name,declarant_position,updated_at) VALUES('main',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,street=EXCLUDED.street,postal_code=EXCLUDED.postal_code,city=EXCLUDED.city,country=EXCLUDED.country,phone=EXCLUDED.phone,fax=EXCLUDED.fax,email=EXCLUDED.email,declarant_name=EXCLUDED.declarant_name,declarant_position=EXCLUDED.declarant_position,updated_at=EXCLUDED.updated_at`,[c.name,c.street,c.postalCode,c.city,c.country,c.phone,c.fax,c.email,c.declarantName,c.declarantPosition,updatedAt])
    await q(`INSERT INTO app_settings(id,numbering_scope,number_format,finance_can_close,require_purpose,auto_sync,updated_at,deleted,server_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT(id) DO UPDATE SET numbering_scope=EXCLUDED.numbering_scope,number_format=EXCLUDED.number_format,finance_can_close=EXCLUDED.finance_can_close,require_purpose=EXCLUDED.require_purpose,auto_sync=EXCLUDED.auto_sync,updated_at=EXCLUDED.updated_at,deleted=EXCLUDED.deleted,server_seq=EXCLUDED.server_seq`,[id,obj.numberingScope??'PER_DESK',obj.numberFormat??'SLASH',!!obj.financeCanClose,obj.requirePurpose!==false,obj.autoSync!==false,updatedAt,!!deleted,seq]); return
  }
  if(tbl==='closes'){
    await q(`INSERT INTO month_closes(id,scope_key,desk_id,year,month,month_key,bp_start,bp_end,bi_start,bi_end,doc_count,closed_by,closed_at,idempotency_key,updated_at,deleted,server_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(id) DO UPDATE SET scope_key=EXCLUDED.scope_key,desk_id=EXCLUDED.desk_id,year=EXCLUDED.year,month=EXCLUDED.month,month_key=EXCLUDED.month_key,bp_start=EXCLUDED.bp_start,bp_end=EXCLUDED.bp_end,bi_start=EXCLUDED.bi_start,bi_end=EXCLUDED.bi_end,doc_count=EXCLUDED.doc_count,closed_by=EXCLUDED.closed_by,closed_at=EXCLUDED.closed_at,idempotency_key=EXCLUDED.idempotency_key,updated_at=EXCLUDED.updated_at,deleted=EXCLUDED.deleted,server_seq=EXCLUDED.server_seq`,[id,obj.scopeKey??'',obj.deskId??null,Number(obj.year??0),Number(obj.month??0),obj.monthKey??'',Number(obj.bpStart??0),Number(obj.bpEnd??0),Number(obj.biStart??0),Number(obj.biEnd??0),Number(obj.docCount??0),obj.closedBy??'',obj.closedAt??'',obj.idempotencyKey??'',updatedAt,!!deleted,seq])
    await q('DELETE FROM month_close_manifest WHERE close_id=$1',[id]); if(!deleted)for(const [i,x] of (obj.manifest??[]).entries())await q('INSERT INTO month_close_manifest(close_id,row_no,doc_id,type,number,transaction_at,employee_name,amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,i,x.docId??'',x.type??'',Number(x.number??0),x.transactionAt??'',x.employeeName??'',Number(x.amount??0)]); return
  }
}

export async function createPgStore(pool) {
  await reconcileSchema(pool)
  await pool.query(`INSERT INTO meta (k, v) VALUES ('seq', '0') ON CONFLICT (k) DO NOTHING`)
  const rootQ=(s,p)=>pool.query(s,p).then((x)=>x.rows)

  // Enkratna, idempotentna migracija stare JSON shrambe v nove tabele.
  const marker=(await rootQ(`SELECT v FROM meta WHERE k='normalized_schema_v2'`))[0]
  if(marker?.v!=='1'){
    const legacy=await rootQ('SELECT tbl,id,json,updated_at,deleted,server_seq FROM records ORDER BY server_seq')
    let moved=0
    for(const r of legacy){
      if(!SUPPORTED.has(r.tbl))continue
      const exists=(await rootQ(`SELECT 1 AS x FROM ${topTable[r.tbl]} WHERE id=$1`,[r.id]))[0]
      if(exists)continue
      let obj; try{obj=parseJson(r.json)}catch{continue}
      await writeAtSeq(rootQ,r.tbl,r.id,obj,isoStr(r.updated_at),truthy(r.deleted),Number(r.server_seq)); moved++
    }
    let maxSeq=Number((await rootQ(`SELECT v FROM meta WHERE k='seq'`))[0]?.v??0)
    for(const t of ['records','audit',...Object.values(topTable)]){const n=Number((await rootQ(`SELECT COALESCE(MAX(server_seq),0) AS n FROM ${t}`))[0]?.n??0); maxSeq=Math.max(maxSeq,n)}
    await rootQ(`INSERT INTO meta(k,v) VALUES('seq',$1) ON CONFLICT(k) DO UPDATE SET v=EXCLUDED.v`,[String(maxSeq)])
    await rootQ(`INSERT INTO meta(k,v) VALUES('normalized_schema_v2','1') ON CONFLICT(k) DO UPDATE SET v='1'`)
    if(moved)console.log(`[blagajna] PostgreSQL: migriranih ${moved} legacy JSON zapisov v normalizirane tabele.`)
  }

  const mk=(q)=>{
    const api={
      driver:'postgres',
      async userCount(){return parseInt((await q('SELECT COUNT(*) AS n FROM users'))[0].n,10)},
      async getUserByEmail(email){return (await q('SELECT * FROM users WHERE email=$1',[email]))[0]??null},
      async getUserById(id){return (await q('SELECT * FROM users WHERE id=$1',[id]))[0]??null},
      async listUsers(){return q('SELECT * FROM users ORDER BY name')},
      async insertUser(u){await q('INSERT INTO users(id,email,name,role,pass_hash,active,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[u.id,u.email,u.name,u.role,u.pass_hash,truthy(u.active),u.created_at,u.updated_at])},
      async updateUser(u){await q('UPDATE users SET name=$1,role=$2,active=$3,pass_hash=$4,updated_at=$5 WHERE id=$6',[u.name,u.role,truthy(u.active),u.pass_hash,u.updated_at,u.id])},
      async nextSeq(){const rows=await q(`UPDATE meta SET v=((v)::bigint+1)::text WHERE k='seq' RETURNING v`); return parseInt(rows[0].v,10)},
      async getRecord(tbl,id){if(SUPPORTED.has(tbl))return readBy(q,tbl,id); const r=(await q('SELECT json,updated_at,deleted FROM records WHERE tbl=$1 AND id=$2',[tbl,id]))[0]; return r?{json:parseJson(r.json),updatedAt:isoStr(r.updated_at),deleted:truthy(r.deleted)}:null},
      async putRecord(tbl,id,obj,updatedAt,deleted=false){const seq=await api.nextSeq(); if(SUPPORTED.has(tbl))await writeAtSeq(q,tbl,id,obj,updatedAt,deleted,seq); else await q(`INSERT INTO records(tbl,id,json,updated_at,deleted,server_seq) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tbl,id) DO UPDATE SET json=EXCLUDED.json,updated_at=EXCLUDED.updated_at,deleted=EXCLUDED.deleted,server_seq=EXCLUDED.server_seq`,[tbl,id,JSON.stringify(obj),updatedAt,!!deleted,seq]); return seq},
      async listTable(tbl,includeDeleted=false){if(!SUPPORTED.has(tbl)){const rows=await q(`SELECT json FROM records WHERE tbl=$1${includeDeleted?'':' AND deleted=FALSE'}`,[tbl]);return rows.map((r)=>parseJson(r.json))} const ids=await q(`SELECT id FROM ${topTable[tbl]}${includeDeleted?'':' WHERE deleted=FALSE'} ORDER BY id`); const out=[]; for(const x of ids){const r=await readBy(q,tbl,x.id);if(r)out.push(r.json)} return out},
      async pullSince(since){
        const changes=await q(`SELECT * FROM (
          SELECT 'docs' AS tbl,id,deleted,server_seq FROM cash_documents WHERE server_seq>$1
          UNION ALL SELECT 'potrdila',id,deleted,server_seq FROM activity_certificates WHERE server_seq>$1
          UNION ALL SELECT 'employees',id,deleted,server_seq FROM employees WHERE server_seq>$1
          UNION ALL SELECT 'desks',id,deleted,server_seq FROM cash_desks WHERE server_seq>$1
          UNION ALL SELECT 'settings',id,deleted,server_seq FROM app_settings WHERE server_seq>$1
          UNION ALL SELECT 'closes',id,deleted,server_seq FROM month_closes WHERE server_seq>$1
        ) x ORDER BY server_seq`,[since])
        const records=[]; for(const r of changes){const rec=truthy(r.deleted)?null:await readBy(q,r.tbl,r.id);records.push({tbl:r.tbl,id:r.id,json:JSON.stringify(rec?.json??{}),deleted:truthy(r.deleted)?1:0,server_seq:Number(r.server_seq)})}
        const audit=await q('SELECT id,at,"user",role,action,entity,entity_id AS "entityId",details,server_seq FROM audit WHERE server_seq>$1 ORDER BY server_seq',[since])
        return {records,audit:audit.map((a)=>({...a,at:isoStr(a.at),server_seq:Number(a.server_seq)}))}
      },
      async addAudit(e){const seq=await api.nextSeq();await q('INSERT INTO audit(id,at,"user",role,action,entity,entity_id,details,server_seq) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING',[e.id,e.at,e.user,e.role,e.action,e.entity,e.entityId??'',e.details??'',seq])},
      async tx(fn){const client=await pool.connect();try{await client.query('BEGIN');const r=await fn(mk((s,p)=>client.query(s,p).then((x)=>x.rows)));await client.query('COMMIT');return r}catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}finally{client.release()}},
    };return api
  }
  return mk(rootQ)
}
