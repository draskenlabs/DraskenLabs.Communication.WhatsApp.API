import { normalisePhone } from './phone';

describe('normalisePhone', () => {
  it('strips the punctuation a number is written with', () => {
    expect(normalisePhone('+91 98220 10210')).toBe('919822010210');
    expect(normalisePhone('(555) 010-2030')).toBe('5550102030');
    expect(normalisePhone('+1-555-010-2030')).toBe('15550102030');
  });

  it('leaves a number Meta already reported bare alone', () => {
    expect(normalisePhone('919822010210')).toBe('919822010210');
  });

  it('collapses the spellings of one number to one key', () => {
    const spellings = ['+91 98220 10210', '919822010210', '+919822010210'];
    expect(new Set(spellings.map(normalisePhone)).size).toBe(1);
  });

  it('survives an empty or missing value', () => {
    expect(normalisePhone('')).toBe('');
    expect(normalisePhone(undefined as unknown as string)).toBe('');
  });
});
