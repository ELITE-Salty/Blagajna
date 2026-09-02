import type { BlagajnaDB, OutboxRow } from '../db'
import type { AuditEvent, CashDesk, CashTransfer, Employee, Settings } from '../types'
import { nowIso } from './util'

type QueuedTable = OutboxRow['tbl']

async function replaceQueueEntry(db: BlagajnaDB, tbl: QueuedTable, id: string, del = false) {
  const old = await db.outbox.where('[tbl+id]').equals([tbl, id]).primaryKeys()
  if (old.length) await db.outbox.bulkDelete(old as number[])
  await db.outbox.add({ tbl, id, ...(del ? { del: true } : {}) })
}

/**
 * Local-first persistence for records that use the outbox. The entity change and
 * its queue marker are committed in one IndexedDB transaction so a reload cannot
 * leave one without the other.
 */
export async function updateDesk(db: BlagajnaDB, id: string, patch: Partial<CashDesk>): Promise<CashDesk> {
  const at = nowIso()
  let result!: CashDesk
  await db.transaction('rw', db.desks, db.outbox, async () => {
    const current = await db.desks.get(id)
    if (!current) throw new Error('Blagajna ne obstaja.')
    result = { ...current, ...patch, updatedAt: at }
    await db.desks.put(result)
    await replaceQueueEntry(db, 'desks', id)
  })
  return result
}

export async function putDesk(db: BlagajnaDB, desk: CashDesk): Promise<CashDesk> {
  const result = { ...desk, updatedAt: desk.updatedAt || nowIso() }
  await db.transaction('rw', db.desks, db.outbox, async () => {
    await db.desks.put(result)
    await replaceQueueEntry(db, 'desks', result.id)
  })
  return result
}

export async function saveSettingsPatch(db: BlagajnaDB, patch: Partial<Settings>): Promise<Settings> {
  const localOnly = new Set<keyof Settings>(['currentRole', 'currentUserName', 'activeDeskId'])
  const needsServerSync = (Object.keys(patch) as (keyof Settings)[]).some((k) => !localOnly.has(k))
  if (!needsServerSync) {
    const current = await db.settings.get('main')
    if (!current) throw new Error('Nastavitve niso inicializirane.')
    const result = { ...current, ...patch, id: 'main' as const }
    await db.settings.put(result)
    return result
  }

  const at = nowIso()
  let result!: Settings
  await db.transaction('rw', db.settings, db.outbox, async () => {
    const current = await db.settings.get('main')
    if (!current) throw new Error('Nastavitve niso inicializirane.')
    result = { ...current, ...patch, id: 'main', updatedAt: at }
    await db.settings.put(result)
    await replaceQueueEntry(db, 'settings', 'main')
  })
  return result
}

export async function putEmployee(db: BlagajnaDB, employee: Employee): Promise<Employee> {
  const result = { ...employee, updatedAt: nowIso() }
  await db.transaction('rw', db.employees, db.outbox, async () => {
    await db.employees.put(result)
    await replaceQueueEntry(db, 'employees', result.id)
  })
  return result
}

export async function putAudit(db: BlagajnaDB, event: AuditEvent): Promise<void> {
  await db.transaction('rw', db.audit, db.outbox, async () => {
    await db.audit.put(event)
    await replaceQueueEntry(db, 'audit', event.id)
  })
}

export async function deleteDocument(db: BlagajnaDB, id: string): Promise<void> {
  await db.transaction('rw', db.docs, db.outbox, async () => {
    await db.docs.delete(id)
    await replaceQueueEntry(db, 'docs', id, true)
  })
}


export async function putTransfer(db: BlagajnaDB, transfer: CashTransfer): Promise<CashTransfer> {
  const result = { ...transfer, updatedAt: nowIso(), syncStatus: 'LOKALNO' as const }
  await db.transaction('rw', db.transfers, db.outbox, async () => {
    await db.transfers.put(result)
    await replaceQueueEntry(db, 'transfers', result.id)
  })
  return result
}

export async function deleteTransfer(db: BlagajnaDB, id: string): Promise<void> {
  await db.transaction('rw', db.transfers, db.outbox, async () => {
    await db.transfers.delete(id)
    await replaceQueueEntry(db, 'transfers', id, true)
  })
}
