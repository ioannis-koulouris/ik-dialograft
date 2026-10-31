import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, formatEur, priceLine, roundHalfUp, totals } from '../src/domain/money.js';

describe('money', () => {
  it('rounds half away from zero per line', () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(-0.5)).toBe(-1);
    const l = priceLine({ description: 'x', quantity: 1, unitPriceCents: 1050, taxRatePct: 7 }); // 73.5 -> 74
    expect(l).toMatchObject({ netCents: 1050, taxCents: 74, grossCents: 1124 });
  });
  it('sums totals from rounded lines', () => {
    const t = totals([priceLine({ description: 'a', quantity: 3, unitPriceCents: 333, taxRatePct: 19 }), priceLine({ description: 'b', quantity: 1, unitPriceCents: 3990, taxRatePct: 7 })]);
    expect(t).toEqual({ netCents: 4989, taxCents: 190 + 279, grossCents: 4989 + 469 });
  });
  it('formats and handles dates', () => {
    expect(formatEur(123456)).toBe('1.234,56 €');
    expect(addDays('2026-10-20', 14)).toBe('2026-11-03');
    expect(daysBetween('2026-10-15', '2026-10-30')).toBe(15);
  });
});
