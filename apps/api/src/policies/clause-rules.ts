/**
 * Policy clauses for Ask iPro (decision #89): the text read from a published PDF or Word file is
 * split into numbered clauses ("4.2 Carry forward ..."), so an answer can link to the clause it came
 * from. A document without numbering is split into paragraphs instead.
 */
export interface Clause {
  /** The document's own number ("4.2"), or null when the document isn't numbered. */
  number: string | null;
  heading: string;
  body: string;
}

/** Longest clause body kept in one piece; longer ones continue in a second clause. */
export const MAX_CLAUSE_CHARS = 3000;
/** Paragraph chunks for documents without numbered clauses. */
const CHUNK_CHARS = 1200;

const NUMBERED = /^(\d{1,2}(?:\.\d{1,2}){0,3})[.)]?\s+(\S.*)$/;

export function splitClauses(raw: string): Clause[] {
  const lines = raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\t\u00a0 ]+/g, ' ').trim());
  const numbered = lines.filter((l) => NUMBERED.test(l)).length;
  const clauses = numbered >= 2 ? byNumber(lines) : byParagraph(lines);
  return clauses.flatMap(splitLong).filter((c) => c.body.trim() || c.heading.trim());
}

function byNumber(lines: string[]): Clause[] {
  const out: Clause[] = [];
  let current: { number: string | null; heading: string; parts: string[] } | null = null;
  const close = () => {
    if (current) {
      out.push({ number: current.number, heading: current.heading, body: join(current.parts) });
    }
  };
  for (const line of lines) {
    const m = NUMBERED.exec(line);
    if (m) {
      close();
      const [heading, rest] = headingOf(m[2]!);
      current = { number: m[1]!, heading, parts: rest ? [rest] : [] };
    } else if (line) {
      if (!current) current = { number: null, heading: 'Introduction', parts: [] };
      current.parts.push(line);
    } else if (current) {
      current.parts.push('');
    }
  }
  close();
  return out;
}

function byParagraph(lines: string[]): Clause[] {
  const paragraphs = join(lines)
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: Clause[] = [];
  let chunk = '';
  for (const p of paragraphs) {
    if (chunk && chunk.length + p.length > CHUNK_CHARS) {
      out.push(chunkClause(chunk));
      chunk = '';
    }
    chunk = chunk ? `${chunk}\n\n${p}` : p;
  }
  if (chunk) out.push(chunkClause(chunk));
  return out;
}

const chunkClause = (text: string): Clause => ({
  number: null,
  heading: firstWords(text),
  body: text,
});

/** "Carry forward. Up to 10 days ..." → heading "Carry forward", rest "Up to 10 days ...". */
function headingOf(text: string): [string, string] {
  const sentence = /^(.{2,80}?)[.:–-]\s+(.+)$/.exec(text);
  if (sentence) return [sentence[1]!.trim(), sentence[2]!.trim()];
  if (text.length <= 80) return [text.replace(/[.:;]$/, ''), ''];
  return [firstWords(text), text];
}

function firstWords(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 60) return flat;
  return `${flat.slice(0, 60).replace(/\s+\S*$/, '')}…`;
}

const join = (parts: string[]) =>
  parts
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function splitLong(clause: Clause): Clause[] {
  if (clause.body.length <= MAX_CLAUSE_CHARS) return [clause];
  const out: Clause[] = [];
  let rest = clause.body;
  while (rest.length > MAX_CLAUSE_CHARS) {
    const cut = rest.lastIndexOf('\n', MAX_CLAUSE_CHARS);
    const at = cut > MAX_CLAUSE_CHARS / 2 ? cut : MAX_CLAUSE_CHARS;
    out.push({ ...clause, body: rest.slice(0, at).trim() });
    rest = rest.slice(at).trim();
  }
  out.push({ ...clause, heading: `${clause.heading} (continued)`, body: rest });
  return out.map((c, i) => (i === 0 ? c : { ...c, heading: `${clause.heading} (continued)` }));
}

/**
 * A Postgres full-text query that matches any of the question's words (stop words are dropped by
 * the dictionary), ranked by how many match: "How many days can I carry forward?" →
 * `days | carry | forward`. Only letters and digits reach the query.
 */
export function anyWordQuery(question: string): string | null {
  const words = [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 2 && w.length <= 40),
    ),
  ].slice(0, 20);
  return words.length ? words.join(' | ') : null;
}

export const WORD_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** PDF by its signature; Word (.docx) by the zip signature and the file name. */
export function policyFileType(body: Buffer, fileName: string): 'pdf' | 'docx' | null {
  if (body.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  const zip = body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04;
  if (zip && /\.docx$/i.test(fileName)) return 'docx';
  return null;
}
