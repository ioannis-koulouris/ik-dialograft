import { roundHalfUp } from '../domain/money.js';
import type { WorkPackage } from '../domain/types.js';

export interface PricingConfig { ratePerHourCents: number; riskSurchargePct: number }

/** Deterministic range: lower bound = min hours × rate, upper bound = max hours × rate × (1 + surcharge). */
export function priceRange(packages: WorkPackage[], cfg: PricingConfig) {
  const minHours = packages.reduce((s, p) => s + p.minHours, 0);
  const maxHours = packages.reduce((s, p) => s + p.maxHours, 0);
  return {
    minHours,
    maxHours,
    lowCents: roundHalfUp(minHours * cfg.ratePerHourCents),
    highCents: roundHalfUp(maxHours * cfg.ratePerHourCents * (1 + cfg.riskSurchargePct / 100)),
  };
}
