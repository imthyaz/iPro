import { describe, expect, it } from 'vitest';
import { detectContentType, safeFileName } from './documents.service.js';

describe('safeFileName', () => {
  it('keeps the last path segment and drops control characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('C:\\Users\\x\\PAN card.pdf')).toBe('PAN card.pdf');
    expect(safeFileName('bad\u0000name\u001f.pdf')).toBe('badname.pdf');
    expect(safeFileName('   ')).toBe('file');
  });
});

describe('detectContentType', () => {
  it('recognises PDF, JPEG and PNG by their first bytes only', () => {
    expect(detectContentType(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(detectContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(detectContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('image/png');
    expect(detectContentType(Buffer.from('MZ executable'))).toBeNull();
    expect(detectContentType(Buffer.alloc(0))).toBeNull();
  });
});
