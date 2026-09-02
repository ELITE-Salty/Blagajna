import type { CashDesk } from '../types'

export const isGroupDesk = (d: CashDesk | undefined | null) => !!d?.isGroup

export function childDesks(desks: CashDesk[], parentId: string): CashDesk[] {
  return desks.filter((d) => d.parentId === parentId)
}

export function descendantLocationIds(desks: CashDesk[], parentId: string): string[] {
  const out: string[] = []
  const visit = (id: string) => {
    for (const d of desks.filter((x) => x.parentId === id)) {
      if (d.isGroup) visit(d.id)
      else out.push(d.id)
    }
  }
  visit(parentId)
  return out
}

export function locationIdsForView(desks: CashDesk[], deskId: string): string[] {
  const d = desks.find((x) => x.id === deskId)
  if (!d) return []
  return d.isGroup ? descendantLocationIds(desks, d.id) : [d.id]
}

export function physicalDesks(desks: CashDesk[]): CashDesk[] {
  return desks.filter((d) => !d.isGroup)
}

export function deskPath(desks: CashDesk[], desk: CashDesk): string {
  const parent = desk.parentId ? desks.find((d) => d.id === desk.parentId) : undefined
  return parent ? `${parent.name} / ${desk.name}` : desk.name
}
