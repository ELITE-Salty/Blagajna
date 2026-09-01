// Znesek z besedo v slovenščini — računovodski zapis: "sto petindvajset 50/100 EUR"
const ENOTE = [
  'nič', 'ena', 'dva', 'tri', 'štiri', 'pet', 'šest', 'sedem', 'osem', 'devet',
  'deset', 'enajst', 'dvanajst', 'trinajst', 'štirinajst', 'petnajst',
  'šestnajst', 'sedemnajst', 'osemnajst', 'devetnajst',
]
const DESETICE = ['', '', 'dvajset', 'trideset', 'štirideset', 'petdeset', 'šestdeset', 'sedemdeset', 'osemdeset', 'devetdeset']
const STOTICE = ['', 'sto', 'dvesto', 'tristo', 'štiristo', 'petsto', 'šeststo', 'sedemsto', 'osemsto', 'devetsto']

function do999(n: number): string {
  const s = Math.floor(n / 100)
  const r = n % 100
  const sto = STOTICE[s]
  if (r === 0) return sto || ''
  let rw: string
  if (r < 20) rw = ENOTE[r]
  else {
    const d = Math.floor(r / 10)
    const e = r % 10
    rw = e === 0 ? DESETICE[d] : `${ENOTE[e]}in${DESETICE[d]}`
  }
  return sto ? `${sto} ${rw}` : rw
}

export function stevilkaZBesedo(n: number): string {
  if (n === 0) return 'nič'
  const mio = Math.floor(n / 1_000_000)
  const tis = Math.floor((n % 1_000_000) / 1000)
  const rest = n % 1000
  const parts: string[] = []
  if (mio) parts.push(mio === 1 ? 'en milijon' : mio === 2 ? 'dva milijona' : `${do999(mio)} milijonov`)
  if (tis) parts.push(tis === 1 ? 'tisoč' : `${do999(tis)} tisoč`)
  if (rest) parts.push(do999(rest))
  return parts.join(' ')
}

/** 125.5 → "sto petindvajset 50/100 EUR" */
export function znesekZBesedo(amount: number | null | undefined): string {
  if (amount == null || isNaN(amount)) return ''
  const total = Math.round(amount * 100)
  const eur = Math.floor(total / 100)
  const cents = total % 100
  return `${stevilkaZBesedo(eur)} ${String(cents).padStart(2, '0')}/100 EUR`
}
