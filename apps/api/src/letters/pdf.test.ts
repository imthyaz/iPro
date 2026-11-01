import { describe, expect, it } from 'vitest';
import { renderLetterPdf } from './pdf.js';

describe('renderLetterPdf', () => {
  it('produces a PDF, including the ₹ sign', async () => {
    const pdf = await renderLetterPdf({
      title: 'Offer letter',
      companyName: 'Ideassion India (dev)',
      date: '1 Nov 2026',
      blocks: [
        { kind: 'heading', text: 'Offer of employment' },
        { kind: 'paragraph', text: 'Your annual CTC will be ₹12,00,000 – payable monthly.' },
      ],
    });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
    // Fonts are embedded as subsets; the subset must include the rupee glyph's font.
    expect(pdf.toString('latin1')).toContain('/FontFile2');
  });
});
