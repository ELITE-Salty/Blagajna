/**
 * Small dependency-free PDF writer for one full-page JPEG (A4 portrait or landscape).
 * The receipt is drawn at high resolution on canvas so Slovene characters,
 * digital signatures and the printed appearance survive PDF export.
 */
const textEncoder = new TextEncoder()
const ascii = (s: string): Uint8Array => textEncoder.encode(s)

export function jpegToA4Pdf(
  jpeg: Uint8Array, pixelWidth: number, pixelHeight: number,
  orientation: 'portrait' | 'landscape' = 'portrait',
): Uint8Array {
  if (!jpeg.length || pixelWidth <= 0 || pixelHeight <= 0 || !Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) {
    throw new Error('Neveljavna slika za PDF dokument.')
  }
  const pageWidth = orientation === 'landscape' ? 841.89 : 595.28
  const pageHeight = orientation === 'landscape' ? 595.28 : 841.89
  const parts: Uint8Array[] = []
  const offsets: number[] = [0]
  let size = 0
  const append = (chunk: Uint8Array | string) => {
    const bytes = typeof chunk === 'string' ? ascii(chunk) : chunk
    parts.push(bytes)
    size += bytes.length
  }
  const begin = (id: number) => { offsets[id] = size; append(`${id} 0 obj\n`) }
  const end = () => append('\nendobj\n')

  append('%PDF-1.4\n%Blagajna\n')
  begin(1); append('<< /Type /Catalog /Pages 2 0 R >>'); end()
  begin(2); append('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'); end()
  begin(3)
  append(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /PageImage 5 0 R >> >> /Contents 4 0 R >>`)
  end()
  const command = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/PageImage Do\nQ\n`
  begin(4); append(`<< /Length ${ascii(command).length} >>\nstream\n${command}endstream`); end()
  begin(5)
  append(`<< /Type /XObject /Subtype /Image /Width ${Math.round(pixelWidth)} /Height ${Math.round(pixelHeight)} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`)
  append(jpeg); append('\nendstream'); end()

  const xref = size
  append('xref\n0 6\n0000000000 65535 f \n')
  for (let i = 1; i <= 5; i++) append(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`)
  append(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const pdf = new Uint8Array(size)
  let at = 0
  for (const part of parts) { pdf.set(part, at); at += part.length }
  return pdf
}
