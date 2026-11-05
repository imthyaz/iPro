import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('reads a header and rows, with quotes, CRLF and blank lines', () => {
    const text =
      '\uFEFFEmployee_Code, leave_type ,balance\r\nIDS-0001,CL,3\r\n\r\n"IDS-0002","E""L",2.5\n';
    expect(parseCsv(text)).toEqual([
      { employee_code: 'IDS-0001', leave_type: 'CL', balance: '3' },
      { employee_code: 'IDS-0002', leave_type: 'E"L', balance: '2.5' },
    ]);
  });

  it('keeps commas and new lines inside quotes', () => {
    expect(parseCsv('a,b\n"x, y","line\nbreak"')).toEqual([{ a: 'x, y', b: 'line\nbreak' }]);
  });

  it('refuses ragged rows, unclosed quotes and empty input', () => {
    expect(() => parseCsv('a,b\n1')).toThrow(/Line 2 has 1 fields/);
    expect(() => parseCsv('a\n"open')).toThrow(/unclosed quote/);
    expect(() => parseCsv('\n\n')).toThrow(/empty/);
  });
});
