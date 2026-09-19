/**
 * Machine-readable errors. Every non-2xx response has the shape
 *   { "error": true, "code": "GAME_NOT_FOUND", "message": "...", "details"?: {...} }
 * and the codes are part of the public contract (spec/openapi.yaml).
 */
export const ERROR_STATUS = {
  BAD_REQUEST: 400,
  INVALID_MOVE: 422,
  GAME_OVER: 409,
  CONFLICT: 409,
  REPLAY_INVALID: 422,
  NOT_WORTH_STORING: 422,
  UNAUTHORIZED: 401,
  GAME_NOT_FOUND: 404,
  REPLAY_NOT_FOUND: 404,
  AGENT_NOT_FOUND: 404,
  BENCHMARK_NOT_FOUND: 404,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  AGENT_UNREACHABLE: 502,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  toJSON() {
    return { error: true, code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

/** Errors thrown inside a Durable Object lose their class across RPC; carry the code in the message. */
export function encodeRpcError(e: ApiError): Error {
  return new Error(`__api_error__${JSON.stringify(e.toJSON())}`);
}

export function decodeRpcError(e: unknown): ApiError | null {
  const msg = e instanceof Error ? e.message : String(e);
  const i = msg.indexOf('__api_error__');
  if (i < 0) return null;
  try {
    const j = JSON.parse(msg.slice(i + '__api_error__'.length));
    return new ApiError(j.code, j.message, j.details);
  } catch {
    return null;
  }
}
