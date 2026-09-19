/**
 * Price table for estimating LLM cost when a client doesn't report one.
 * USD per 1M tokens. Cached-input reads are billed at 10 % of input.
 * Unknown models return null (cost shown as "unknown", never guessed).
 */
const PER_MILLION: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export function normalizeModel(model: string): string {
  // "anthropic/claude-opus-5" (OpenRouter style) → "claude-opus-5"
  return model.trim().toLowerCase().replace(/^anthropic\//, '');
}

export function estimateCostUsd(model: string, t: { input: number; output: number; cacheRead: number }): number | null {
  const m = normalizeModel(model);
  if (m.endsWith(':free') || m === 'openrouter/free') return 0;
  const p = PER_MILLION[m];
  if (!p) return null;
  return (t.input * p.input + t.cacheRead * p.input * 0.1 + t.output * p.output) / 1_000_000;
}
