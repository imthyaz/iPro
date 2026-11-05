/**
 * A small CSV reader for imports (RFC 4180: commas, double-quoted fields with "" for a quote, CRLF
 * or LF line ends). The first row is the header; names are trimmed and lower-cased. Blank lines are
 * skipped. No dependency needed for this.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const input = text.replace(/^\uFEFF/, '');
  while (i < input.length) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"' && input[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') quoted = false;
      else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (c === '\r' && input[i + 1] === '\n') i++;
    } else field += c;
    i++;
  }
  if (quoted) throw new Error('The CSV has an unclosed quote');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const nonBlank = rows.filter((r) => r.some((f) => f.trim() !== ''));
  if (nonBlank.length === 0) throw new Error('The CSV is empty');
  const [header, ...body] = nonBlank;
  const names = header!.map((h) => h.trim().toLowerCase());
  return body.map((r, n) => {
    if (r.length !== names.length) {
      throw new Error(`Line ${n + 2} has ${r.length} fields; the header has ${names.length}`);
    }
    return Object.fromEntries(names.map((name, k) => [name, r[k]!]));
  });
}
