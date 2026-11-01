import { describe, expect, it } from 'vitest';
import { fieldsIn, merge, templateProblems, toBlocks } from './merge-fields.js';

const body = `# Letter of confirmation

Dear {{person.preferredName}},

We confirm your employment as {{ assignment.designation }} from {{extra.confirmationDate}}.`;

describe('templates', () => {
  it('lists the fields used', () => {
    expect(fieldsIn(body)).toEqual([
      'person.preferredName',
      'assignment.designation',
      'extra.confirmationDate',
    ]);
  });

  it('flags unknown fields and stray braces', () => {
    expect(templateProblems(body)).toEqual([]);
    expect(templateProblems('Hi {{person.salary}}')).toEqual(['Unknown field {{person.salary}}']);
    expect(templateProblems('Hi {{person.legalName}')).toEqual([
      'A {{ or }} is not part of a field',
    ]);
    expect(templateProblems('{{constructor.prototype}}')).toEqual([
      'Unknown field {{constructor.prototype}}',
    ]);
  });
});

describe('merge', () => {
  it('fills every field', () => {
    const result = merge(body, {
      'person.preferredName': 'Asha',
      'assignment.designation': 'Senior Engineer',
      'extra.confirmationDate': '1 Dec 2026',
    });
    expect(result).toEqual({
      ok: true,
      text: expect.stringContaining(
        'We confirm your employment as Senior Engineer from 1 Dec 2026.',
      ),
    });
  });

  it('refuses when any field has no value, listing them all', () => {
    expect(merge(body, { 'person.preferredName': 'Asha', 'assignment.designation': ' ' })).toEqual({
      ok: false,
      missing: ['assignment.designation', 'extra.confirmationDate'],
    });
  });

  it('never takes fields or values from the object prototype', () => {
    expect(templateProblems('{{constructor}} {{toString}}')).toEqual([
      'Unknown field {{constructor}}',
      'Unknown field {{toString}}',
    ]);
    expect(merge('{{toString}}', {})).toEqual({ ok: false, missing: ['toString'] });
  });

  it('does not interpret values as fields', () => {
    const result = merge('Hello {{person.legalName}}', { 'person.legalName': '{{company.name}}' });
    expect(result).toEqual({ ok: true, text: 'Hello {{company.name}}' });
  });
});

describe('toBlocks', () => {
  it('splits headings and paragraphs on blank lines', () => {
    expect(toBlocks('# Title\n\nFirst line\nsame paragraph\n\n\nSecond')).toEqual([
      { kind: 'heading', text: 'Title' },
      { kind: 'paragraph', text: 'First line\nsame paragraph' },
      { kind: 'paragraph', text: 'Second' },
    ]);
  });
});
