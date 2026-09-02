export type XlsxPrimitive = string | number | boolean | null | undefined

export type XlsxCell = {
  value?: XlsxPrimitive
  style?: number
  formula?: string
  result?: string | number
}

export type XlsxDataValidation = {
  sqref: string
  formula1: string
  type?: 'list'
  allowBlank?: boolean
  errorTitle?: string
  error?: string
  promptTitle?: string
  prompt?: string
}

export type XlsxSheet = {
  name: string
  rows: XlsxCell[][]
  widths?: number[]
  merges?: string[]
  freezeRows?: number
  freezeCols?: number
  autoFilter?: string
  rowHeights?: Record<number, number>
  showGridLines?: boolean
  landscape?: boolean
  printArea?: string
  dataValidations?: XlsxDataValidation[]
}

export type XlsxWorkbook = {
  title?: string
  subject?: string
  creator?: string
  company?: string
  sheets: XlsxSheet[]
}

export const XLSX_STYLE = {
  NORMAL: 0,
  TITLE: 1,
  SUBTITLE: 2,
  HEADER: 3,
  BODY: 4,
  BODY_ALT: 5,
  DATE: 6,
  DATE_ALT: 7,
  MONEY_IN: 8,
  MONEY_IN_ALT: 9,
  MONEY_OUT: 10,
  MONEY_OUT_ALT: 11,
  TYPE_BP: 12,
  TYPE_BI: 13,
  STATUS_CLOSED: 14,
  STATUS_DRAFT: 15,
  STATUS_VOID: 16,
  TOTAL_LABEL: 17,
  TOTAL_MONEY: 18,
  KPI_GREEN: 19,
  KPI_RED: 20,
  KPI_BLUE: 21,
  KPI_TEAL: 22,
  TEMPLATE_DATE: 23,
  TEMPLATE_TEXT: 24,
  TEMPLATE_ACTIVE: 25,
  SECTION: 26,
} as const

const encoder = new TextEncoder()

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function colName(n: number): string {
  let out = ''
  while (n > 0) {
    n--
    out = String.fromCharCode(65 + (n % 26)) + out
    n = Math.floor(n / 26)
  }
  return out
}

function maxCols(rows: XlsxCell[][]): number {
  return rows.reduce((m, r) => Math.max(m, r.length), 1)
}

function cellXml(cell: XlsxCell | undefined, ref: string): string {
  if (!cell) return ''
  const style = cell.style != null ? ` s="${cell.style}"` : ''
  if (cell.formula) {
    const result = cell.result == null ? '' : `<v>${typeof cell.result === 'number' ? cell.result : esc(cell.result)}</v>`
    return `<c r="${ref}"${style}><f>${esc(cell.formula)}</f>${result}</c>`
  }
  const v = cell.value
  if (v == null || v === '') return cell.style != null ? `<c r="${ref}"${style}/>` : ''
  if (typeof v === 'number') return `<c r="${ref}"${style}><v>${Number.isFinite(v) ? v : 0}</v></c>`
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"${style}><v>${v ? 1 : 0}</v></c>`
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(v)}</t></is></c>`
}

function worksheetXml(sheet: XlsxSheet): string {
  const rowCount = Math.max(sheet.rows.length, 1)
  const cols = maxCols(sheet.rows)
  const dimension = `A1:${colName(cols)}${rowCount}`
  const freezeRows = sheet.freezeRows ?? 0
  const freezeCols = sheet.freezeCols ?? 0
  const activePane = freezeRows && freezeCols ? 'bottomRight' : freezeRows ? 'bottomLeft' : 'topRight'
  const pane = freezeRows || freezeCols
    ? `<pane${freezeCols ? ` xSplit="${freezeCols}"` : ''}${freezeRows ? ` ySplit="${freezeRows}"` : ''} topLeftCell="${colName(freezeCols + 1)}${freezeRows + 1}" activePane="${activePane}" state="frozen"/><selection pane="${activePane}" activeCell="${colName(freezeCols + 1)}${freezeRows + 1}" sqref="${colName(freezeCols + 1)}${freezeRows + 1}"/>`
    : '<selection activeCell="A1" sqref="A1"/>'
  const views = `<sheetViews><sheetView workbookViewId="0" showGridLines="${sheet.showGridLines === false ? 0 : 1}">${pane}</sheetView></sheetViews>`
  const widths = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    : ''
  const rows = sheet.rows.map((row, ri) => {
    const rn = ri + 1
    const cells = row.map((cell, ci) => cellXml(cell, `${colName(ci + 1)}${rn}`)).join('')
    const h = sheet.rowHeights?.[rn]
    return `<row r="${rn}"${h ? ` ht="${h}" customHeight="1"` : ''}>${cells}</row>`
  }).join('')
  const merges = sheet.merges?.length ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((r) => `<mergeCell ref="${r}"/>`).join('')}</mergeCells>` : ''
  const filter = sheet.autoFilter ? `<autoFilter ref="${esc(sheet.autoFilter)}"/>` : ''
  const validations = sheet.dataValidations?.length
    ? `<dataValidations count="${sheet.dataValidations.length}">${sheet.dataValidations.map((d) => `<dataValidation type="${d.type ?? 'list'}" allowBlank="${d.allowBlank === false ? 0 : 1}" showErrorMessage="1" showInputMessage="1" sqref="${esc(d.sqref)}"${d.errorTitle ? ` errorTitle="${esc(d.errorTitle)}"` : ''}${d.error ? ` error="${esc(d.error)}"` : ''}${d.promptTitle ? ` promptTitle="${esc(d.promptTitle)}"` : ''}${d.prompt ? ` prompt="${esc(d.prompt)}"` : ''}><formula1>${esc(d.formula1)}</formula1></dataValidation>`).join('')}</dataValidations>`
    : ''
  const printArea = sheet.printArea ? `<printOptions horizontalCentered="0" verticalCentered="0"/>` : ''
  const pageMargins = '<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>'
  const pageSetup = `<pageSetup orientation="${sheet.landscape === false ? 'portrait' : 'landscape'}" fitToWidth="1" fitToHeight="0" paperSize="9"/>`
  // CT_Worksheet has a strict child-element order in Excel/OpenXML.
  // In particular autoFilter MUST be emitted before mergeCells.
  // LibreOffice is lenient here, but desktop Excel repairs/discards a sheet
  // when these two elements are reversed.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="${dimension}"/>${views}<sheetFormatPr defaultRowHeight="15"/>${widths}<sheetData>${rows}</sheetData>${filter}${merges}${validations}${printArea}${pageMargins}${pageSetup}</worksheet>`
}

function stylesXml(): string {
  const euro = '#,##0.00 [$€-sl-SI];[Red]-#,##0.00 [$€-sl-SI]'
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/><numFmt numFmtId="165" formatCode="${esc(euro)}"/></numFmts>
  <fonts count="7">
    <font><sz val="11"/><name val="Aptos"/><color rgb="FF1F2937"/></font>
    <font><b/><sz val="18"/><name val="Aptos Display"/><color rgb="FF1E3A5F"/></font>
    <font><sz val="10"/><name val="Aptos"/><color rgb="FF64748B"/></font>
    <font><b/><sz val="11"/><name val="Aptos"/><color rgb="FFFFFFFF"/></font>
    <font><b/><sz val="11"/><name val="Aptos"/><color rgb="FF047857"/></font>
    <font><b/><sz val="11"/><name val="Aptos"/><color rgb="FFB91C1C"/></font>
    <font><b/><sz val="11"/><name val="Aptos"/><color rgb="FFB45309"/></font>
  </fonts>
  <fills count="12">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E3A5F"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF047857"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFB91C1C"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFCCFBF1"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left style="thin"><color rgb="FFCBD5E1"/></left><right style="thin"><color rgb="FFCBD5E1"/></right><top style="thin"><color rgb="FFCBD5E1"/></top><bottom style="thin"><color rgb="FFCBD5E1"/></bottom><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="27">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
    <xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="3" borderId="2" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="165" fontId="4" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="4" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="5" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="5" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="5" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="6" fillId="6" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="5" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="3" fillId="2" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="3" fillId="8" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="3" fillId="9" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="165" fontId="3" fillId="10" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="7" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="2" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="11" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="0"/>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`
}

function workbookXml(sheets: XlsxSheet[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`
}

function workbookRelsXml(sheetCount: number): string {
  const sheetRels = Array.from({ length: sheetCount }, (_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
}

function contentTypesXml(sheetCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheets}</Types>`
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`
}

function coreXml(book: XlsxWorkbook): string {
  const now = new Date().toISOString()
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(book.title ?? 'Blagajna')}</dc:title><dc:subject>${esc(book.subject ?? '')}</dc:subject><dc:creator>${esc(book.creator ?? 'Blagajna')}</dc:creator><cp:lastModifiedBy>${esc(book.creator ?? 'Blagajna')}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
}

function appXml(book: XlsxWorkbook): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Blagajna</Application><Company>${esc(book.company ?? '')}</Company><AppVersion>1.0</AppVersion></Properties>`
}

const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function u16(n: number): Uint8Array {
  return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF])
}
function u32(n: number): Uint8Array {
  return new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF])
}
function joinBytes(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const p of parts) { out.set(p, offset); offset += p.length }
  return out
}

function dosDateTime(d = new Date()): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

function makeZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0
  const dt = dosDateTime()
  for (const file of files) {
    const name = encoder.encode(file.name)
    const crc = crc32(file.data)
    const local = joinBytes([
      u32(0x04034B50), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date),
      u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0), name, file.data,
    ])
    localParts.push(local)
    const central = joinBytes([
      u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date),
      u32(crc), u32(file.data.length), u32(file.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ])
    centralParts.push(central)
    offset += local.length
  }
  const central = joinBytes(centralParts)
  const local = joinBytes(localParts)
  const end = joinBytes([u32(0x06054B50), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(local.length), u16(0)])
  return joinBytes([local, central, end])
}

export function buildXlsx(book: XlsxWorkbook): Uint8Array {
  const files: Array<{ name: string; data: Uint8Array }> = [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypesXml(book.sheets.length)) },
    { name: '_rels/.rels', data: encoder.encode(rootRelsXml()) },
    { name: 'docProps/core.xml', data: encoder.encode(coreXml(book)) },
    { name: 'docProps/app.xml', data: encoder.encode(appXml(book)) },
    { name: 'xl/workbook.xml', data: encoder.encode(workbookXml(book.sheets)) },
    { name: 'xl/_rels/workbook.xml.rels', data: encoder.encode(workbookRelsXml(book.sheets.length)) },
    { name: 'xl/styles.xml', data: encoder.encode(stylesXml()) },
  ]
  book.sheets.forEach((sheet, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: encoder.encode(worksheetXml(sheet)) }))
  return makeZip(files)
}

export function excelDateSerial(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return null
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Math.round((utc - Date.UTC(1899, 11, 30)) / 86400000)
}

export function downloadXlsx(book: XlsxWorkbook, filename: string): void {
  const bytes = buildXlsx(book)
  const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function downloadText(text: string, filename: string, type = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
