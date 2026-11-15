import { renderLetterPdf } from '../src/letters/pdf.js';

/**
 * Synthetic policy files for tests (decision #89): a PDF with a text layer, made with the letter
 * renderer; Word files come from ./docx.ts.
 */
export function policyPdf(title: string, lines: string[]): Promise<Buffer> {
  return renderLetterPdf({
    title,
    companyName: 'Ideassion (synthetic)',
    date: '1 Jan 2026',
    blocks: [
      { kind: 'heading', text: title },
      ...lines.map((text) => ({ kind: 'paragraph' as const, text })),
    ],
  });
}

/** A one-page PDF with no text at all, as a scan would be. */
export async function blankPdf(): Promise<Buffer> {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

export { policyDocx } from './docx.js';
