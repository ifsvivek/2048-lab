/** LLM usage records (see migrations/0003_llm_usage.sql). */
export interface UsageRow {
  game_id: string;
  day: string;
  provider: string | null;
  model: string;
  agent_name: string | null;
  source: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  cost_usd: number | null;
  cost_estimated: number;
  reported_at: number;
}

export function usageOut(u: UsageRow, game?: { score: number; moveNumber: number; maxTile: number; status: string }) {
  const total = u.input_tokens + u.output_tokens + u.cache_read_tokens;
  const moves = game?.moveNumber ?? 0;
  return {
    gameId: u.game_id,
    provider: u.provider,
    model: u.model,
    agentName: u.agent_name,
    calls: u.calls,
    tokens: { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_tokens, reasoning: u.reasoning_tokens, total },
    costUsd: u.cost_usd,
    costEstimated: !!u.cost_estimated,
    selfReported: true,
    ...(game
      ? {
          game,
          efficiency: {
            tokensPerMove: moves ? total / moves : null,
            costPerMoveUsd: moves && u.cost_usd !== null ? u.cost_usd / moves : null,
            pointsPer1kTokens: total ? (game.score / total) * 1000 : null,
            costPer1kPointsUsd: game.score && u.cost_usd !== null ? (u.cost_usd / game.score) * 1000 : null,
          },
        }
      : {}),
    reportedAt: u.reported_at,
  };
}
