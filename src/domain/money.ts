/** All amounts are integer euro cents. Rounding: half away from zero, applied per line. */
export function roundHalfUp(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

export interface LineInput { description: string; quantity: number; unitPriceCents: number; taxRatePct: number }
export interface Line extends LineInput { netCents: number; taxCents: number; grossCents: number }
export interface Totals { netCents: number; taxCents: number; grossCents: number }

export function priceLine(l: LineInput): Line {
  const netCents = roundHalfUp(l.quantity * l.unitPriceCents);
  const taxCents = roundHalfUp((netCents * l.taxRatePct) / 100);
  return { ...l, netCents, taxCents, grossCents: netCents + taxCents };
}

export function totals(lines: Line[]): Totals {
  return lines.reduce(
    (t, l) => ({ netCents: t.netCents + l.netCents, taxCents: t.taxCents + l.taxCents, grossCents: t.grossCents + l.grossCents }),
    { netCents: 0, taxCents: 0, grossCents: 0 },
  );
}

export function formatEur(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${euros},${String(abs % 100).padStart(2, '0')} €`;
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}
