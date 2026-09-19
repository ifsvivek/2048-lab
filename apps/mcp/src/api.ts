/**
 * Minimal client for the platform API. The MCP server holds no game logic and
 * no state: every tool is one (or a few) calls through this client.
 *
 * In production the API is reached through a Workers service binding (no
 * public network hop, no extra request billing); `API_URL` is the fallback for
 * local development against a remote API.
 */
export interface Env {
  API?: Fetcher;
  API_URL: string;
}

export interface ApiErrorBody {
  error: true;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class PlatformError extends Error {
  readonly body: ApiErrorBody;
  constructor(body: ApiErrorBody) {
    super(body.message);
    this.body = body;
  }
}

export class ApiClient {
  private readonly env: Env;
  private readonly auth: string | null;

  constructor(env: Env, auth: string | null) {
    this.env = env;
    this.auth = auth;
  }

  async call<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, auth = false): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'g2048-mcp/1' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth && this.auth) headers.authorization = this.auth;
    const init: RequestInit = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
    const url = new URL(path, this.env.API ? 'https://api.internal' : this.env.API_URL);
    let res: Response;
    try {
      res = this.env.API ? await this.env.API.fetch(url.toString(), init) : await fetch(url.toString(), init);
    } catch (e) {
      throw new PlatformError({ error: true, code: 'API_UNAVAILABLE', message: `platform API unreachable: ${(e as Error).message}` });
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PlatformError({ error: true, code: 'API_UNAVAILABLE', message: `platform API returned non-JSON (HTTP ${res.status})` });
    }
    if (!res.ok) {
      const b = json as Partial<ApiErrorBody>;
      throw new PlatformError({ error: true, code: b.code ?? 'INTERNAL', message: b.message ?? `HTTP ${res.status}`, details: b.details });
    }
    return json as T;
  }
}
