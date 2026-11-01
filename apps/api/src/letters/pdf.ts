import { createRequire } from 'node:module';
import path from 'node:path';
import pdfmake from 'pdfmake';
import type { Block } from './merge-fields.js';

// Roboto ships with pdfmake (Apache-2.0) and covers ₹ and the Latin characters letters use.
const fontDir = path.join(
  path.dirname(createRequire(import.meta.url).resolve('pdfmake')),
  '..',
  'fonts',
  'Roboto',
);
const font = (file: string) => path.join(fontDir, file);

pdfmake.addFonts({
  Roboto: {
    normal: font('Roboto-Regular.ttf'),
    bold: font('Roboto-Medium.ttf'),
    italics: font('Roboto-Italic.ttf'),
    bolditalics: font('Roboto-MediumItalic.ttf'),
  },
});
// Letters never load files or URLs: only the bundled fonts may be read.
pdfmake.setLocalAccessPolicy((file) => path.resolve(file).startsWith(path.resolve(fontDir)));
pdfmake.setUrlAccessPolicy(() => false);

export interface LetterPdf {
  title: string;
  companyName: string;
  date: string;
  blocks: Block[];
}

/** A plain A4 letter: company name and date at the top, the merged text, page numbers in the footer. */
export function renderLetterPdf(letter: LetterPdf): Promise<Buffer> {
  return pdfmake
    .createPdf({
      info: { title: letter.title, creator: 'iPro', producer: 'iPro' },
      pageSize: 'A4',
      pageMargins: [56, 72, 56, 64],
      defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.35 },
      header: {
        columns: [
          { text: letter.companyName, bold: true, fontSize: 12 },
          { text: letter.date, alignment: 'right', color: '#5a6476' },
        ],
        margin: [56, 32, 56, 0],
      },
      footer: (current: number, total: number) => ({
        text: `Page ${current} of ${total}`,
        alignment: 'center',
        fontSize: 8,
        color: '#5a6476',
        margin: [0, 24, 0, 0],
      }),
      content: letter.blocks.map((block) =>
        block.kind === 'heading'
          ? { text: block.text, bold: true, fontSize: 14, margin: [0, 8, 0, 10] }
          : { text: block.text, margin: [0, 0, 0, 10] },
      ),
    })
    .getBuffer();
}
