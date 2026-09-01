import type { Role, Settings } from '../types'

export type Capability =
  | 'CREATE_EDIT'
  | 'CREATE_POTRDILO'
  | 'SIGN'
  | 'PRINT'
  | 'PREVIEW_NUMBERING'
  | 'CLOSE_MONTH'
  | 'STORNO'
  | 'MANAGE_DESKS'
  | 'MANAGE_EMPLOYEES'
  | 'MANAGE_SETTINGS'
  | 'VIEW_AUDIT'

/** Matrika pravic iz PRD §44. */
export function can(role: Role, cap: Capability, s: Settings): boolean {
  switch (cap) {
    case 'CREATE_EDIT':
    case 'CREATE_POTRDILO':
    case 'SIGN':
    case 'PRINT':
      return true
    case 'PREVIEW_NUMBERING':
    case 'CLOSE_MONTH':
      return role === 'ADMIN' || role === 'RACUNOVODJA' || (role === 'FINANCE' && s.financeCanClose)
    case 'STORNO':
      return role === 'ADMIN' || role === 'RACUNOVODJA'
    case 'MANAGE_EMPLOYEES':
      // potrjena zahteva: zaposlene lahko dodaja/ureja tudi Računovodja
      return role === 'ADMIN' || role === 'RACUNOVODJA'
    case 'MANAGE_DESKS':
    case 'MANAGE_SETTINGS':
    case 'VIEW_AUDIT':
      return role === 'ADMIN'
    default:
      return false
  }
}
