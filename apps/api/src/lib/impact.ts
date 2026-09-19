/**
 * AI cost & resource-impact model.
 *
 * These are EDUCATIONAL ESTIMATES, not measurements. Every figure is derived
 * from quantities the platform does record (decision time, benchmark CPU time,
 * LLM tokens) multiplied by the published-order-of-magnitude constants below.
 * The constants are returned with every response so the UI can show them.
 */
export const IMPACT_ASSUMPTIONS = {
  cpuWattsPerCore: {
    value: 15,
    unit: 'W per busy CPU core',
    note: 'Typical laptop/server core under load incl. share of memory & board (range ~5–30 W).',
  },
  pue: {
    value: 1.2,
    unit: 'power usage effectiveness',
    note: 'Data-centre overhead for cooling & power delivery (hyperscale ~1.1–1.4). Applied to all energy.',
  },
  computeUsdPerCoreHour: {
    value: 0.04,
    unit: 'USD per vCPU-hour',
    note: 'On-demand general-purpose cloud vCPU list price (range ~$0.02–0.10).',
  },
  llmWhPer1kTokens: {
    value: 0.5,
    unit: 'Wh per 1,000 tokens',
    note: 'Inference energy for a large hosted model; published estimates span ~0.1–3 Wh per 1k tokens. Free models still use energy.',
  },
  waterLitresPerKwh: {
    value: 1.8,
    unit: 'L water per kWh',
    note: 'On-site cooling plus power-generation water (WUE + source; range ~0.5–5 L/kWh).',
  },
  carbonKgPerKwh: {
    value: 0.45,
    unit: 'kg CO₂e per kWh',
    note: 'Approximate global-average grid intensity (range ~0.05–0.9 depending on region).',
  },
  phoneChargeKwh: { value: 0.015, unit: 'kWh per smartphone full charge', note: '~15 Wh battery incl. charger losses.' },
  laptopHourKwh: { value: 0.05, unit: 'kWh per laptop-hour', note: '~50 W average draw while in use.' },
} as const;

const A = IMPACT_ASSUMPTIONS;

export interface Footprint {
  computeSeconds: number;
  llmTokens: number;
  energyKwh: number;
  waterLitres: number;
  carbonKg: number;
  computeCostUsd: number;
}

/** Footprint of `seconds` of single-core CPU time plus `tokens` of LLM inference. */
export function footprint(seconds: number, tokens = 0): Footprint {
  const cpuKwh = (seconds * A.cpuWattsPerCore.value) / 3_600_000;
  const llmKwh = (tokens / 1000) * (A.llmWhPer1kTokens.value / 1000);
  const energyKwh = (cpuKwh + llmKwh) * A.pue.value;
  return {
    computeSeconds: seconds,
    llmTokens: tokens,
    energyKwh,
    waterLitres: energyKwh * A.waterLitresPerKwh.value,
    carbonKg: energyKwh * A.carbonKgPerKwh.value,
    computeCostUsd: (seconds / 3600) * A.computeUsdPerCoreHour.value,
  };
}

export function sumFootprints(fs: Footprint[]): Footprint {
  return fs.reduce(
    (a, f) => ({
      computeSeconds: a.computeSeconds + f.computeSeconds,
      llmTokens: a.llmTokens + f.llmTokens,
      energyKwh: a.energyKwh + f.energyKwh,
      waterLitres: a.waterLitres + f.waterLitres,
      carbonKg: a.carbonKg + f.carbonKg,
      computeCostUsd: a.computeCostUsd + f.computeCostUsd,
    }),
    footprint(0, 0),
  );
}

export function equivalents(energyKwh: number) {
  return {
    phoneCharges: energyKwh / A.phoneChargeKwh.value,
    laptopHours: energyKwh / A.laptopHourKwh.value,
  };
}
