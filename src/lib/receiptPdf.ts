import type { CashDesk, CashDocument, Settings } from '../types'
import { SIGNATURE_ROLES_BI, SIGNATURE_ROLES_BP, SIGNATURE_ROLE_LABELS } from '../types'
import { znesekZBesedo } from './besede'
import { docNo, fmtDate, fmtDateTime, fmtNum } from './util'
import { jpegToA4Pdf } from './simplePdf'

/** Create a single A4-landscape PDF with ONE BP/BI copy, including signatures. */
export async function receiptToPdf(doc: CashDocument, settings: Settings, desk?: CashDesk): Promise<Uint8Array> {
  const scale = 3 // 216 dpi; stays readable even when printed at A4
  const W = 841.89
  const H = 595.28
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(W * scale)
  canvas.height = Math.round(H * scale)
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Brskalnik ne podpira izrisa PDF dokumenta.')
  ctx.scale(scale, scale)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.textBaseline = 'alphabetic'

  const isBP = doc.type === 'BP'
  const dark = isBP ? '#064e3b' : '#7c2d12'
  const light = isBP ? '#ecfdf5' : '#fff7ed'
  const ink = '#182230'
  const muted = '#596577'
  const left = 42
  const right = W - 42
  const width = right - left

  const font = (size: number, bold = false) => { ctx.font = `${bold ? '700' : '400'} ${size}px Arial, Helvetica, sans-serif` }
  const text = (s: string, x: number, y: number, size = 11, color = ink, bold = false, align: CanvasTextAlign = 'left') => {
    font(size, bold); ctx.fillStyle = color; ctx.textAlign = align; ctx.fillText(String(s || ''), x, y)
  }
  const rect = (x: number, y: number, w: number, h: number, stroke = dark, fill?: string, lineWidth = 0.8) => {
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(x, y, w, h) }
    ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.strokeRect(x, y, w, h)
  }
  const line = (x: number, y: number, x2: number, y2: number, color = dark, dash: number[] = []) => {
    ctx.strokeStyle = color; ctx.lineWidth = 0.7; ctx.setLineDash(dash)
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([])
  }
  const wrap = (input: string, maxWidth: number, fontSize: number, bold = false): string[] => {
    font(fontSize, bold)
    const result: string[] = []
    for (const paragraph of String(input ?? '').split(/\r?\n/)) {
      let current = ''
      for (const word of (paragraph.match(/\S+/g) || [])) {
        const candidate = current ? `${current} ${word}` : word
        if (ctx.measureText(candidate).width <= maxWidth) { current = candidate; continue }
        if (current) { result.push(current); current = '' }
        // Break exceptionally long strings instead of cutting them off the page.
        for (const ch of word) {
          if (ctx.measureText(current + ch).width > maxWidth && current) { result.push(current); current = '' }
          current += ch
        }
      }
      result.push(current)
    }
    return result.length ? result : ['']
  }
  const wrappedText = (input: string, x: number, y: number, maxWidth: number, size = 10, leading = 14, color = ink, bold = false) => {
    const lines = wrap(input, maxWidth, size, bold)
    lines.forEach((s, i) => text(s, x, y + i * leading, size, color, bold))
    return y + lines.length * leading
  }

  // Header and official document number.
  text('izdajatelj', left + 3, 42, 9, muted)
  rect(left, 49, 270, 68)
  text(settings.company.name, left + 9, 67, 12, dark, true)
  const address = [settings.company.street, [settings.company.postalCode, settings.company.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')
  wrappedText(address, left + 9, 82, 250, 9.5, 12)
  if (desk) text(`Blagajna: ${desk.name}`, left + 9, 108, 9.5)

  const xRight = left + 290
  text(isBP ? 'Blagajniški prejemek' : 'Blagajniški izdatek', right, 66, 23, dark, true, 'right')
  line(xRight, 77, right, 77, dark)
  const number = doc.officialNumber != null
    ? docNo(doc.type, doc.officialNumber, doc.seqYear, settings.numberFormat, doc.monthKey)
    : ''
  text('št.', xRight, 103, 10, muted)
  text(number, xRight + 23, 103, 11, dark, true)
  text('datum', right - 165, 103, 9, muted)
  text(`${fmtDate(doc.transactionDate)} ${doc.transactionTime || ''}`, right, 115, 10, ink, false, 'right')

  // Cash receiver, amount and amount in words.
  text(isBP ? 'Vplačnik' : 'Prejemnik', left, 150, 11)
  text(doc.employeeName || '', left + 75, 150, 12, ink, true)
  line(left + 72, 158, right, 158, muted, [2, 2])
  text(isBP ? 'je vplačal z gotovino - znesek EUR' : 'je prejel z gotovino - znesek EUR', left, 182, 11)
  text(doc.amount != null ? `= ${fmtNum(doc.amount)} =` : '', right, 182, 16, dark, true, 'right')
  line(left, 191, right, 191, dark, [2, 2])
  rect(left, 204, width, 36, dark, light)
  text('z besedami evrov', left + 8, 225, 9, muted)
  const words = doc.amountWordsOverride || znesekZBesedo(doc.amount)
  // Long verbal amounts are wrapped inside the colored strip.
  const wordLines = wrap(words ? `= ${words} =` : '', width - 165, 10)
  wordLines.slice(0, 2).forEach((s, i) => text(s, left + 155, 221 + i * 12, 10, ink))

  // Purpose, attachments and accounting table. Notes are intentionally not printed.
  const detailTop = 265
  const accountLeft = 525
  text('za', left, detailTop, 11, dark, true)
  const purposeEnd = wrappedText(doc.purpose || '', left + 5, detailTop + 21, accountLeft - left - 30, 11, 16)
  line(left + 4, purposeEnd + 1, accountLeft - 14, purposeEnd + 1, muted, [2, 2])
  const attachmentNames = (doc.attachments || []).map((a) => a.name).join(', ')
  const attachY = Math.max(detailTop + 76, purposeEnd + 23)
  text('priloge', left, attachY, 10, muted)
  const attachmentEnd = wrappedText(
    attachmentNames ? `${doc.attachments.length}x (${attachmentNames})` : '',
    left + 42, attachY, accountLeft - left - 68, 9.5, 13,
  )
  line(left + 42, attachmentEnd + 1, accountLeft - 14, attachmentEnd + 1, muted, [2, 2])

  const aw = right - accountLeft
  // PaperDoc (the on-screen print template) has four bookkeeping rows.
  const ar = (doc.rows?.length ? doc.rows : [{ konto: '', znesek: doc.amount, opis: doc.purpose }]).slice(0, 4)
  const rowCount = 4
  const rowHeight = 22
  const tableY = detailTop - 4
  rect(accountLeft, tableY, aw, 27, dark, light)
  text(isBP ? 'v dobro' : 'v breme', accountLeft + aw / 2, tableY + 18, 11, dark, true, 'center')
  rect(accountLeft, tableY + 27, aw, 22)
  const separator = accountLeft + 113
  line(separator, tableY + 27, separator, tableY + 49 + rowCount * rowHeight + 26)
  text('konto', accountLeft + 55, tableY + 42, 10, dark, true, 'center')
  text('EUR', separator + (right - separator) / 2, tableY + 42, 10, dark, true, 'center')
  ar.forEach((r, i) => {
    const y = tableY + 49 + i * rowHeight
    rect(accountLeft, y, aw, rowHeight)
    text(r.konto || '', accountLeft + 55, y + 16, 10, ink, false, 'center')
    text(r.znesek != null ? fmtNum(r.znesek) : '', right - 8, y + 16, 10, ink, false, 'right')
  })
  for (let i = ar.length; i < rowCount; i++) rect(accountLeft, tableY + 49 + i * rowHeight, aw, rowHeight)
  const totalY = tableY + 49 + rowCount * rowHeight
  rect(accountLeft, totalY, aw, 26, dark, light)
  text('skupaj', separator - 8, totalY + 18, 10, dark, true, 'right')
  text(doc.amount != null ? fmtNum(doc.amount) : '', right - 8, totalY + 18, 11, dark, true, 'right')

  // Digitally captured signatures appear on the printout as actual ink images.
  let signatureTop = Math.max(441, totalY + 35, attachmentEnd + 34)
  // Reserve enough room for signatures and the footer on one landscape page.
  if (signatureTop > 457) signatureTop = 457
  const roles = isBP ? SIGNATURE_ROLES_BP : SIGNATURE_ROLES_BI
  const sigWidth = width / roles.length
  for (let i = 0; i < roles.length; i++) {
    const role = roles[i]
    const x = left + i * sigWidth
    const sig = doc.signatures?.find((s) => s.role === role)
    line(x + 4, signatureTop + 43, x + sigWidth - 9, signatureTop + 43)
    text(SIGNATURE_ROLE_LABELS[role], x + 5, signatureTop + 58, 9, dark, role === 'PREJEL')
    if (sig?.dataUrl) {
      try {
        const img = await loadSignature(sig.dataUrl)
        const maxWidth = sigWidth - 22
        const maxHeight = 42
        const ratio = Math.min(maxWidth / img.width, maxHeight / img.height)
        const imageW = img.width * ratio
        const imageH = img.height * ratio
        ctx.drawImage(img, x + (sigWidth - imageW) / 2, signatureTop + 40 - imageH, imageW, imageH)
      } catch { text('Podpis ni na voljo', x + 8, signatureTop + 30, 8, muted) }
    }
    if (sig) text(sig.signerName, x + 5, signatureTop + 72, 8, muted)
  }

  if (doc.status === 'STORNIRAN') {
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(-Math.PI / 10)
    ctx.globalAlpha = .20; text('STORNIRANO', 0, 0, 40, '#b91c1c', true, 'center'); ctx.restore()
    text(`STORNIRANO ${doc.cancelledAt ? fmtDateTime(doc.cancelledAt).split(' ')[0] : ''} - ${doc.cancelReason || ''}`, left, Math.min(541, signatureTop + 84), 10, '#b91c1c', true)
  } else if (doc.status === 'ODPRT') {
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(-Math.PI / 10)
    ctx.globalAlpha = .20; text('OSNUTEK - BREZ URADNE ŠTEVILKE', 0, 0, 28, muted, true, 'center'); ctx.restore()
  }
  {/*line(left, 550, right, 550, '#cbd5e1')
  text(`${settings.company.name} - interna blagajniška dokumentacija`, left, 567, 8, muted)
  text(`Obr. ${doc.type} · Blagajna Blu`, right, 567, 8, muted, false, 'right')
  */}
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error('Izris PDF ni uspel.')), 'image/jpeg', 0.94))
  return jpegToA4Pdf(new Uint8Array(await blob.arrayBuffer()), canvas.width, canvas.height, 'landscape')
}

function loadSignature(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Neveljaven digitalni podpis.'))
    img.src = dataUrl
  })
}
