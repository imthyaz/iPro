import { describe, expect, it } from 'vitest';
import { kycSubmitSchema, verhoeffValid } from './kyc.js';

// Synthetic identifiers only. 234123412346 is the commonly used Verhoeff-valid test number.
describe('verhoeffValid', () => {
  it('accepts a valid check digit and rejects a changed one', () => {
    expect(verhoeffValid('234123412346')).toBe(true);
    expect(verhoeffValid('234123412347')).toBe(false);
  });
});

describe('kycSubmitSchema', () => {
  const parse = (input: object) => kycSubmitSchema.safeParse(input);

  it('normalises and accepts well-formed values', () => {
    expect(parse({ type: 'pan', value: 'abcde 1234 f' }).data?.value).toBe('ABCDE1234F');
    expect(parse({ type: 'aadhaar', value: '2341 2341 2346' }).success).toBe(true);
    expect(parse({ type: 'passport', value: 'z1234567' }).success).toBe(true);
    expect(parse({ type: 'uan', value: '100000000001' }).success).toBe(true);
    expect(parse({ type: 'esic', value: '1234567890' }).success).toBe(true);
    expect(parse({ type: 'bank', value: '000123456789', ifsc: 'hdfc0001234' }).data?.ifsc).toBe(
      'HDFC0001234',
    );
  });

  it('rejects malformed values, a bad Aadhaar check digit and a bank account without IFSC', () => {
    expect(parse({ type: 'pan', value: 'ABCDE12345' }).success).toBe(false);
    expect(parse({ type: 'aadhaar', value: '234123412347' }).success).toBe(false);
    expect(parse({ type: 'aadhaar', value: '134123412346' }).success).toBe(false);
    expect(parse({ type: 'bank', value: '000123456789' }).success).toBe(false);
    expect(parse({ type: 'bank', value: '000123456789', ifsc: 'HDFC1001234' }).success).toBe(false);
  });

  it('names the field, never the value, in errors', () => {
    const result = parse({ type: 'pan', value: 'SECRET999' });
    expect(JSON.stringify(result.error?.issues)).not.toContain('SECRET999');
  });
});
